// ===== SANRENTAN Server-Side Game Store =====
// 部屋の状態は Redis に置く。serverless は複数インスタンスに分散するため、
// プロセス内メモリに持つと同時アクセス時に別インスタンスが空の状態を見て
// 「ルームが見つかりません」になる。Redis 未設定時のみメモリに退避する。

const kv = require('./kv');

const COLORS = ['#E53935','#1E88E5','#43A047','#FB8C00','#9C27B0','#00897B','#F4511E','#5C6BC0'];
const TTL = 2 * 60 * 60 * 1000;
const TTL_SEC = Math.round(TTL / 1000);
const SEEN_REFRESH_MS = 5 * 1000; // lastSeen の更新頻度。毎ポーリング書くと書込が多すぎる
const CAS_RETRIES = 6;
const DRAW_TIMEOUT = 45 * 1000; // お題選択フェーズのAFK自動確定（親設定対象外）
const FLIP_TIMEOUT = 45 * 1000; // 親が順位カードをめくる猶予。切れたら自動オープン
const DISCONNECT_MS = 20 * 1000; // この間ポーリングが無いプレイヤーは離脱扱い
const REROLL_FLOOR_MS = 8 * 1000; // リロール直後に最低限お題を読める猶予

// Redis 未設定時のフォールバック。Redis と同じく「JSON文字列」を持たせて
// CAS の比較セマンティクスを揃える
if (!globalThis.__srtRooms) globalThis.__srtRooms = new Map();
const mem = globalThis.__srtRooms;

// ===== Helpers =====
function rid() { return Math.random().toString(36).substring(2, 12); }
function rcode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 自分で決めたコード（ルーム・お題リスト共通の書式）。
// 大文字英数字4〜8文字。小文字や記号は落として揃える
const CODE_MIN = 4, CODE_MAX = 8;
const CODE_NG = `コードは英数字${CODE_MIN}〜${CODE_MAX}文字にしてください`;
function normalizeCode(input) {
  const c = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (c.length >= CODE_MIN && c.length <= CODE_MAX) ? c : null;
}
// 空いている色を配る。人数を添字にすると、誰かが抜けたあとの入室で色が被る
function freeColor(room) {
  const used = new Set(room.players.map(p => p.color));
  return COLORS.find(c => !used.has(c)) || COLORS[room.players.length % COLORS.length];
}

// ===== Persistence =====
const key = code => 'room:' + code;

async function loadRaw(code) {
  if (kv.enabled) return await kv.get(key(code));
  const raw = mem.get(code);
  if (raw === undefined) return null;
  // メモリ側は TTL を自前で切る
  try {
    if (Date.now() - JSON.parse(raw).createdAt > TTL) { mem.delete(code); return null; }
  } catch (e) { mem.delete(code); return null; }
  return raw;
}
async function saveNew(code, room) {
  const raw = JSON.stringify(room);
  if (kv.enabled) return await kv.setNew(key(code), raw, TTL_SEC);
  if (mem.has(code)) return false;
  mem.set(code, raw);
  return true;
}
async function cas(code, prev, next) {
  if (kv.enabled) return await kv.cas(key(code), prev, next, TTL_SEC);
  const cur = mem.has(code) ? mem.get(code) : null;
  if (cur !== prev) return false;
  mem.set(code, next);
  return true;
}

// 読み → 変更 → 書き を CAS で直列化する。同時提出などで
// 別インスタンスの更新を踏み潰さないための要。
// fn がエラーを返した場合は書き込まない（部分的な変更を捨てる）。
async function withRoom(code, fn) {
  for (let i = 0; i < CAS_RETRIES; i++) {
    let raw;
    try { raw = await loadRaw(code); }
    catch (e) { return { error: '通信エラーが発生しました' }; }
    if (!raw) return { error: 'ルームが見つかりません' };

    let room;
    try { room = JSON.parse(raw); } catch (e) { return { error: 'ルームが見つかりません' }; }

    const out = fn(room);
    if (out && out.error) return out;

    const next = JSON.stringify(room);
    if (next === raw) return out; // 変化なし → 書き込み不要（ポーリングの大半はこれ）

    try {
      if (await cas(code, raw, next)) return out;
    } catch (e) { return { error: '通信エラーが発生しました' }; }

    await sleep(15 + i * 25); // 競合。読み直してやり直す
  }
  return { error: '混み合っています。もう一度お試しください' };
}
// 重複なし3択をランダム生成（未回答者への自動割当に使用）
function randomPicks(odai) {
  const idx = [...Array(odai.opts.length).keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, 3);
}
// ===== Presence (離脱検知) =====
function isConnected(room, p, now) {
  return (now - (room.lastSeen[p.id] || 0)) < DISCONNECT_MS;
}
function connectedPlayers(room, now) {
  return room.players.filter(p => isConnected(room, p, now));
}
// 接続中のプレイヤーが全員 flags[id] を満たしたか（離脱者は待たない）
function allActiveDone(room, flags) {
  const now = Date.now();
  const conn = connectedPlayers(room, now);
  return conn.length > 0 && conn.every(p => flags[p.id]);
}
// ロビーで離脱したプレイヤーを除去し、必要ならホストを引き継ぐ
function pruneLobby(room, now) {
  const before = room.players.length;
  room.players = room.players.filter(p => isConnected(room, p, now));
  if (room.players.length === before) return;
  if (!room.players.find(p => p.id === room.hostId)) {
    room.hostId = room.players.length ? room.players[0].id : null;
  }
}

// ===== ODAI Data =====
const ODAI = [
  {id:1,q:"恋人に求める絶対条件",opts:["顔","性格","金銭感覚","酒のモチベ","連絡頻度","食の好み","休日の過ごし方"]},
  {id:2,q:"百万円手に入ったら？",opts:["貯金","旅行","投資","服など爆買い","高級ブランド品","ギャンブル","友達と焼肉"]},
  {id:3,q:"徹夜明けに一番沁みるもの",opts:["ラーメン","サウナ","味噌汁","風呂","ふかふかベッド","牛丼","そば"]},
  {id:4,q:"旅行で一番アガる瞬間",opts:["企画中","車内","現地の買い出し","飲みゲー","BBQ","観光","銭湯・サウナ"]},
  {id:5,q:"FPSで一番脳汁が出る瞬間",opts:["1vXクラッチ","連続HS","完璧な裏取り","フリックエイム","昇格戦勝利","煽られた試合に勝つ","味方のナイス"]},
  {id:6,q:"焼肉で最初に頼むメニュー",opts:["タン塩","肉刺し","ハラミ","キムチ","ビール","白米","チョレギサラダ"]},
  {id:7,q:"BBQの最強食材",opts:["ステーキ","ホタテ","焼きそば","かぼちゃ","タン","しいたけ","イカ"]},
  {id:8,q:"寿司屋で絶対頼むネタ",opts:["マグロ","サーモン","ハマチ","エビ","イクラ","エンガワ","卵"]},
  {id:9,q:"深夜のコンビニの誘惑",opts:["カップ麺","ホットスナック","アイス","菓子パン","スナック菓子","お酒","エナドリ"]},
  {id:10,q:"最後の晩餐",opts:["母親の手料理","超高級寿司","最高級ステーキ","行きつけラーメン","卵かけご飯","マクドナルド","丸亀うどん"]},
  {id:11,q:"旅行で一番重視すること",opts:["飯の美味さ","宿のクオリティ","アクティビティ","移動の楽さ","行くメンバー","写真映え","予算の安さ"]},
  {id:12,q:"絶対に嫌な罰ゲーム",opts:["激辛料理","一発ギャグ","恥ずかしい秘密暴露","SNS変な投稿","一曲作って歌う","過酷な筋トレ","女装"]},
  {id:13,q:"ついやってしまう無駄遣い",opts:["コンビニついで買い","ゲーム課金","セール衝動買い","サブスク解約忘れ","タクシー移動","外食","高すぎる趣味道具"]},
  {id:14,q:"朝起きて最初にやること",opts:["スマホを見る","トイレ","水・コーヒー","二度寝","伸びをする","歯を磨く","シャワー"]},
  {id:15,q:"自分へのご褒美",opts:["ちょっと高い外食","欲しかった物を買う","マッサージ","一日中ゲーム","旅行","高級な酒","ひたすら寝る"]},
  {id:16,q:"学生時代に戻りたい瞬間",opts:["文化祭","体育祭","修学旅行","放課後","休み時間","部活動","授業中"]},
  {id:17,q:"魔法が一つ使えるなら？",opts:["空を飛ぶ","瞬間移動","時間停止","過去に戻る","読心術","お金を出す","透明化"]},
  {id:18,q:"無人島に一つ持っていくなら？",opts:["サバイバルナイフ","ライター","浄水器","スマホ","テント","友達","麻紐"]},
  {id:19,q:"許せない他人の行動",opts:["時間にルーズ","店員への態度","食べ方が汚い","自慢話ばかり","話を聞かない","ドタキャン","連絡無視"]},
  {id:20,q:"一番欲しい才能",opts:["コミュ力","天才的な頭脳","プロの運動神経","絶対音感・センス","不老不死","鋼のメンタル","運の良さ"]},
  {id:21,q:"一生に一度はやりたいこと",opts:["世界一周","スカイダイビング","宇宙旅行","起業","テレビ出演","大富豪の豪遊","自分の店を持つ"]},
  {id:22,q:"ゾンビ襲来！最初の行動",opts:["武器を探す","食料買い占め","安全な場所に籠る","家族・友達と合流","SNSで情報収集","車を確保","諦めてゾンビ化"]},
  {id:23,q:"生まれ変わるなら？",opts:["イケメン/美女","大富豪の子供","鳥","猫","天才スポーツ選手","歴史上の偉人","もう一度自分"]},
  {id:24,q:"タイムマシンで行く時代",opts:["学生時代","バブル時代","江戸時代","百年後の未来","恐竜時代","自分が生まれる前","十年前のビットコイン"]},
  {id:25,q:"家での最強の暇つぶし",opts:["YouTube","漫画・アニメ","映画","ゲーム","睡眠","読書","筋トレ"]},
  {id:26,q:"世界最後の一日にやること",opts:["家族と過ごす","友達とバカ騒ぎ","好きな人に告白","全財産使い果たす","いつも通り過ごす","美味いもの食いまくる","ひたすら祈る"]},
  {id:27,q:"デスゲーム開始！最初の行動",opts:["リーダー格に取り入る","嘘ついて単独行動","とりあえず武器探し","ルールの抜け穴探し","弱そうな奴を盾に","狂ったフリで距離置く","主人公っぽい奴についていく"]},
  {id:28,q:"最強のおにぎりの具",opts:["ツナマヨ","鮭","梅干し","昆布","明太子","チャーハン","塩むすび"]},
  {id:29,q:"一千万円もらえるが絶対嫌な条件",opts:["一年間スマホ禁止","一生炭水化物抜き","一ヶ月無人島","嫌いな人と毎日サシ飲み","一生同じ服","一生音楽なし","黒歴史公開"]},
  {id:30,q:"お祭りの最強屋台",opts:["焼きそば","たこ焼き","りんご飴","かき氷","フランクフルト","ベビーカステラ","チョコバナナ"]},
  {id:31,q:"YouTuberになるならどのジャンル？",opts:["ゲーム実況","バラエティ・検証","ガジェットレビュー","旅行・Vlog","料理・飯テロ","怪談・都市伝説","ひたすら雑談"]},
  {id:32,q:"絶対にやりたくないバイト",opts:["真夏の交通整理","笑顔のテーマパーク","クレーム対応コールセンター","深夜ワンオペ牛丼屋","心霊スポット警備","引越し屋","虫の駆除"]},
  {id:33,q:"一生これしか飲めないなら？",opts:["コーラ","コーヒー","エナドリ","オレンジジュース","ビール","牛乳","炭酸水"]},
  {id:34,q:"不良に絡まれた！どう切り抜ける？",opts:["全力土下座","狂ったフリ","ハッタリをかます","全力ダッシュ逃げ","弱いやつを人質に","金を渡す","泣き落とし"]},
  {id:35,q:"コンビニで一番イラッとする客",opts:["会計後に財布探す","大量の公共料金","ホットスナックで長考","一円玉を数え出す","店員と無駄話","スマホ見ながら適当","割り込みスレスレ"]},
  {id:36,q:"異世界に一つ持っていくなら？",opts:["トイレットペーパー","歯ブラシ","シャンプー・石鹸","マヨネーズ等の調味料","ライター","爪切り","高反発マットレス"]},
  {id:37,q:"居酒屋のセンスあるおつまみ",opts:["梅水晶","エイヒレ炙り","チャンジャ","だし巻き卵","手作りポテサラ","タコわさ","モロキュウ"]},
  {id:38,q:"最強の調味料",opts:["醤油","マヨネーズ","塩","ケチャップ","ごま油","ポン酢","塩コショウ"]},
  {id:39,q:"RPGで使いたい武器",opts:["剣","弓","杖","槍","斧","銃","素手"]},
  {id:40,q:"マックの定番バーガー",opts:["ビッグマック","てりやきマックバーガー","ダブルチーズバーガー","フィレオフィッシュ","えびフィレオ","チキンフィレオ","ハンバーガー"]},
  {id:41,q:"ファンタジー世界の自分の属性",opts:["炎","水","風","土","雷","光","闇"]},
  {id:42,q:"一生住むならどこ？",opts:["大都会","地方都市","ド田舎","海沿い","山奥","南の島","海外"]},
  {id:43,q:"アニメ・漫画の最強ジャンル",opts:["異世界・ファンタジー","日常・コメディ","ロボット・メカ","バトル・王道","ラブコメ","サスペンス","スポーツ"]},
  {id:44,q:"好きな季節のイベント",opts:["お正月","バレンタイン","お花見","夏休み","ハロウィン","クリスマス","大晦日"]},
  {id:45,q:"廃墟に一緒に行くなら？",opts:["Nariko","Kabu","aro","Kirua","Taker","はむろ","Poaro"]},
  {id:46,q:"鬼畜ゲーを一緒にやるなら？",opts:["Fami","Daich1","Kabu","つばちゃん","なかぴー","なえちゃう","Jeyy"]},
  {id:47,q:"一生一つのゲームしかできないなら？",opts:["Valorant","Minecraft","League of Legends","Escape From Tarkov","雀魂","Overwatch","Kovaaks"]},
  {id:48,q:"限界まで酒を飲むなら？",opts:["チャミスル","クライナー","テキーラ","日本酒","ウイスキー","レモンサワー原液","ストロングゼロ"]},
  {id:49,q:"一番イラッとするデス",opts:["走り撃ちHS","角待ちショットガン","味方のフラッシュ","モク抜き","スキル死","落下死","ナイフキル"]},
  {id:50,q:"この中で一番仲良くしたいのは？",opts:["Raze","Viper","Fade","Chamber","Sova","Yoru","Deadlock"]},
  {id:51,q:"デスゲームで最後まで生き残りそうなのは？",opts:["はむろ","つばちゃん","Nariko","Daich1","なかぴー","KZR","Fami"]},
  {id:52,q:"一生行けないと嫌な場所",opts:["マクドナルド","遊園地","AEONモール","ローソン","アウトレット","映画館","パチンコ屋"]},
  {id:53,q:"飛行機の操縦を任せるなら誰？",opts:["Poaro","Nariko","KZR","なかぴー","Taker","Churro","Daich1"]},
  {id:54,q:"この中でなれるならどれが良い？",opts:["キリト","はじめしゃちょー","大谷翔平","Ado","自分","山田涼介","Laz"]},
  {id:55,q:"一生一ジャンルしか聴けないなら？",opts:["ロック","ボカロ","バラード","ラップ","アニソン","Ado","クラシック"]},
  {id:56,q:"【特殊】この中で酒を飲むべきは？",opts:["Daich1","Nariko","つばちゃん","なかぴー","Aro","Kirua","Kabu"]},
  {id:57,q:"ラーメンに必須のトッピング",opts:["チャーシュー","味玉","ネギ","のり","メンマ","もやし","にんにく"]},
  {id:58,q:"コンビニスイーツで買うなら",opts:["シュークリーム","プリン","エクレア","どら焼き","ワッフル","ロールケーキ","大福"]},
  {id:59,q:"鍋で一番好きな具",opts:["肉","白菜","豆腐","きのこ","〆のうどん","つみれ","ネギ"]},
  {id:60,q:"カレーに乗せたいトッピング",opts:["とんかつ","チーズ","卵","福神漬け","らっきょう","ほうれん草","唐揚げ"]},
  {id:61,q:"ピザで許せない具",opts:["パイナップル","アンチョビ","ピーマン","コーン","生ハム","エビ","ゆで卵"]},
  {id:62,q:"給食で一番の当たりメニュー",opts:["揚げパン","カレー","ソフト麺","冷凍みかん","ミルメーク","わかめご飯","きなこ餅"]},
  {id:63,q:"ファミレスで頼みがち",opts:["ハンバーグ","ドリア","パフェ","ドリンクバー","ステーキ","ピザ","唐揚げ"]},
  {id:64,q:"冷凍庫に常備したいもの",opts:["餃子","チャーハン","アイス","から揚げ","うどん","ピザ","たこ焼き"]},
  {id:65,q:"一番テンション上がる肉料理",opts:["和牛ステーキ","焼肉","ローストビーフ","唐揚げ","ハンバーグ","生ハム","トンカツ"]},
  {id:66,q:"スーパーで無限に食える惣菜",opts:["コロッケ","唐揚げ","ポテサラ","焼き鳥","フライドチキン","天ぷら","メンチカツ"]},
  {id:67,q:"二日酔いの朝に欲しいもの",opts:["水","味噌汁","ポカリ","ラーメン","二度寝","迎え酒","うどん"]},
  {id:68,q:"飲み会の締めは",opts:["ラーメン","うどん","お茶漬け","アイス","締めない","パフェ","おにぎり"]},
  {id:69,q:"家飲みのお供",opts:["ポテチ","柿ピー","チーズ","枝豆","さきいか","ナッツ","からあげ"]},
  {id:70,q:"スマホのホーム画面一軍アプリ",opts:["LINE","X","YouTube","ゲーム","TikTok","インスタ","電卓"]},
  {id:71,q:"デートで行きたい場所",opts:["水族館","映画","遊園地","カフェ","夜景","家","ショッピング"]},
  {id:72,q:"老後にやってみたいこと",opts:["世界旅行","田舎暮らし","趣味三昧","孫と遊ぶ","起業","のんびり","移住"]},
  {id:73,q:"透明人間になったら最初に何する",opts:["銀行","のぞき見","いたずら","タダ乗り","有名人に接近","サボる","本音を聞く"]},
  {id:74,q:"100億もらう代わりに失うなら",opts:["友達","自由時間","睡眠","味覚","スマホ","記憶の一部","一生海外禁止"]},
  {id:75,q:"世界を救うのに必要なのは",opts:["金","愛","科学","勇気","運","団結","諦めない心"]},
  {id:76,q:"生き返らせるなら",opts:["歴史の偉人","好きな有名人","ペット","先祖","発明家","音楽家","いない"]},
  {id:77,q:"バトルで使うなら最強の能力",opts:["発火","瞬間移動","予知","怪力","治癒","透明化","電撃"]},
  {id:78,q:"ゲームで思わず課金する瞬間",opts:["ガチャ","スキン","時短","追加ストーリー","限定イベント","便利機能","推しキャラ"]},
  {id:79,q:"同窓会で言われたいこと",opts:["変わらないね","大人になった","出世したね","若い","綺麗になった","面白いまま","幸せそう"]},
  {id:80,q:"テンション上がる集まり",opts:["飲み会","旅行","ゲーム大会","BBQ","カラオケ","鍋パ","誕生日会"]},
  {id:81,q:"頼れる友達の条件",opts:["話を聞く","秘密を守る","お金貸せる","すぐ駆けつける","冷静","面白い","裏切らない"]},
  {id:82,q:"友達にされて一番嬉しいこと",opts:["覚えててくれる","話を聞く","さりげない気遣い","褒める","誘ってくれる","頼ってくれる","味方する"]},
  {id:83,q:"久々の再会でやりがち",opts:["昔話","近況報告","写真見返す","恋バナ","愚痴","次の予定決め","飲みすぎ"]},
  {id:84,q:"言われて一番テンション上がる言葉",opts:["好き","天才","かわいい","さすが","おつかれ","ありがとう","おごるよ"]},
  {id:85,q:"生まれ変わったらなりたい職業",opts:["医者","芸能人","パイロット","公務員","社長","YouTuber","研究者"]},
  {id:86,q:"テンション下がる休日の天気",opts:["大雨","猛暑","極寒","強風","花粉","曇り","雪"]},
  {id:87,q:"もし動物を飼うなら",opts:["犬","猫","うさぎ","ハムスター","鳥","爬虫類","魚"]},
  {id:88,q:"一番幸せを感じる瞬間",opts:["寝る前","美味しい物","風呂","推し活","給料日","褒められた時","何もしない時"]},
  {id:89,q:"地味に一番ほしい日常スキル",opts:["早起き","料理上手","片付け上手","暗算","物覚え","人の顔と名前","髪がすぐ乾く"]},
  {id:90,q:"家に絶対欲しい家電",opts:["食洗機","ロボ掃除機","ドラム式洗濯機","大型テレビ","高機能エアコン","電子レンジ","コーヒーメーカー"]},
  {id:91,q:"くじで当てたいもの",opts:["現金","旅行券","高級家電","車","ゲーム機","食べ放題券","一年分の米"]},
  {id:92,q:"お弁当に入っててうれしいおかず",opts:["唐揚げ","卵焼き","ハンバーグ","ウインナー","エビフライ","ミートボール","焼き鮭"]},
  {id:93,q:"テンションが上がる食べ放題",opts:["焼肉","寿司","スイーツ","ピザ・パスタ","中華","しゃぶしゃぶ","ホテルビュッフェ"]},
  {id:94,q:"スタバで頼む人気メニュー",opts:["キャラメルマキアート","カフェモカ","抹茶フラペチーノ","キャラメルフラペチーノ","ダークモカチップフラペチーノ","カフェラテ","期間限定フラペチーノ"]},
  {id:95,q:"夏に一番テンション上がるもの",opts:["海","花火","夏祭り","スイカ","かき氷","プール","夏休み"]},
  {id:96,q:"冬に一番幸せを感じる瞬間",opts:["こたつ","温泉","鍋","雪景色","イルミネーション","あったかい布団","クリスマス"]},
  {id:97,q:"連休の理想の過ごし方",opts:["旅行","家でゴロゴロ","イベント","帰省","ショッピング","趣味没頭","寝だめ"]},
  {id:98,q:"仕事・バイトの一番のモチベ",opts:["給料","人間関係","やりがい","定時で帰れる","感謝される","成長","暇な時間"]},
  {id:99,q:"家が火事、1つだけ持ち出すなら",opts:["スマホ","財布","アルバム","パソコン","ペット","思い出の品","現金"]},
  {id:100,q:"恋人にされたら冷める行動",opts:["既読無視","店員に横柄","清潔感ない","嘘","時間にルーズ","束縛","元恋人の話"]},
  {id:101,q:"欲しいドラえもんの道具",opts:["どこでもドア","タイムマシン","タケコプター","翻訳こんにゃく","暗記パン","スモールライト","バイバイン"]},
  // お題リスト「NELO」で追加された分
  {id:102,q:"寝るときに必要なもの",opts:["枕","マットレス","掛け布団","ぬいぐるみ","寝落ち要素(動画など)","部屋の暗さ","部屋の温湿度"]},
  {id:103,q:"住みたい地域",opts:["北海道","東北","関東","北陸","中部","近畿","九州"]},
  {id:104,q:"飲み物買うなら",opts:["お茶","水","カルピス","コーヒー","紅茶","コーラ","エナドリ"]},
  {id:105,q:"ビール",opts:["黒ラベル","エビス","1番絞り","プレモル","スーパードライ","クラフトビール","ORION"]},
  {id:106,q:"支払い方法￥コンビニにて",opts:["QR決済","クレジット","現金","QUOカード","交通系","先輩","つけ"]},
  {id:107,q:"好きな色",opts:["白","黒","赤","青","黄","緑","橙"]},
  {id:108,q:"好きなフルーツ",opts:["桃","りんご","ぶどう","みかん","めろん","キウイ","イチゴ"]},
  {id:109,q:"チェーン店",opts:["マクドナルド","スシロー","すき家","丸亀製麺","サイゼリア","ミスタードーナツ","31（サーティワン）"]},
  {id:110,q:"好きな麺類",opts:["ラーメン","うどん","そば","そうめん","パスタ","冷やし中華","焼きそば"]},
  {id:111,q:"テーマパークやりたいこと",opts:["ジェットコースター","観覧車","パレード","お土産買う","写真撮る","食事楽しむ","お化け屋敷"]},
  {id:112,q:"ドラッグストア",opts:["ウエルシア","ダイコクドラッグ","マツモトキヨシ","スギ薬局","トモズ薬局","くすりの福太郎","赤ひげ薬局"]},
  {id:113,q:"ジブリ作品",opts:["千と千尋の神隠し","となりのトトロ","ハウルの動く城","猫の恩返し","天空の城ラピュタ","耳をすませば","もののけ姫"]},
  {id:114,q:"映画ジャンル",opts:["アクション","ホラー","恋愛","実写化","ミステリー","コメディ","キッズ映画"]},
  {id:115,q:"小さい時の思い出のアニメ",opts:["ポケモン","名探偵コナン","プリキュア","トムとジェリー","ドラえもん","クレヨンしんちゃん","忍たま乱太郎"]},
  {id:116,q:"好きなミスタードーナツ",opts:["ポンデリング","フレンチクルーラー","エンゼルフレンチ","ゴールデンチョコレート","ハニーチュロ","ダブルチョコレート","パイ系"]},
  {id:117,q:"旅行の宿に着いて一番最初にすること",opts:["荷物整理","ベッドを決める","着替える","お風呂入る","写真撮る","付いてるお茶・お菓子を食べる","カードキー入れに別のカード入れる"]},
  {id:118,q:"熱が出たときに欲しいもの",opts:["ポカリスエット","冷えピタ","お茶漬け","ゼリー","アイス","友達との電話","恋人の看病"]},
  {id:119,q:"デートの際に１番気合い入れるところ",opts:["ファッション","髪型","デートプラン","早寝早起き","話す内容","ドライブの曲","ディナーの内容"]},
  {id:120,q:"マクドナルドのドリンク",opts:["ファンタメロン","コカ・コーラ","ミニッツメイド","クー","シェイク","紅茶","コーヒー"]},
  {id:121,q:"すきなおでん",opts:["白滝","こんにゃく","卵","大根","牛すじ","ちくわ","はんぺん"]},
  {id:122,q:"好きな薬味",opts:["ねぎ","ショウガ","わさび","大根おろし","みょうが","大葉","にんにく"]},
];

// ===== お題ストア =====
// 上の ODAI は「組み込みの初期リスト」。管理画面で編集された場合は Redis 側が
// 正となり、以降そちらを読む。Redis 未設定時はプロセス内に持つ（再起動で消える）。
const ODAI_KEY = 'odai:list';
const ODAI_MAX = 300;
const ODAI_CACHE_MS = 30 * 1000;   // 毎リクエスト読むと GET が倍増するので短時間キャッシュ
const OPT_MIN = 3;
const OPT_MAX = 7;                 // バッジが A〜G の7色しかない
let odaiCache = null, odaiCacheAt = 0;

async function getOdaiList() {
  const t = Date.now();
  if (odaiCache && t - odaiCacheAt < ODAI_CACHE_MS) return odaiCache;
  let list = null;
  if (kv.enabled) {
    try {
      const raw = await kv.get(ODAI_KEY);
      if (raw) list = JSON.parse(raw);
    } catch (e) { /* 読めなければ組み込みで続行（ゲームは止めない） */ }
  } else {
    list = globalThis.__srtOdai || null;
  }
  odaiCache = (Array.isArray(list) && list.length) ? list : ODAI;
  odaiCacheAt = t;
  return odaiCache;
}
async function saveOdaiList(list) {
  if (kv.enabled) await kv.set(ODAI_KEY, JSON.stringify(list));
  else globalThis.__srtOdai = list;
  odaiCache = list; odaiCacheAt = Date.now();
}

// 入力の正規化＆検証。ここを通ったものだけ保存する
function normalizeOdai(input) {
  const q = String((input && input.q) || '').trim();
  if (!q) return { error: 'お題を入力してください' };
  if (q.length > 40) return { error: 'お題は40文字以内にしてください' };
  const opts = (Array.isArray(input.opts) ? input.opts : [])
    .map(o => String(o == null ? '' : o).trim())
    .filter(Boolean);
  if (opts.length < OPT_MIN) return { error: `選択肢は${OPT_MIN}つ以上必要です` };
  if (opts.length > OPT_MAX) return { error: `選択肢は${OPT_MAX}つまでです（バッジがA〜Gのため）` };
  if (opts.some(o => o.length > 20)) return { error: '選択肢は20文字以内にしてください' };
  if (new Set(opts).size !== opts.length) return { error: '同じ選択肢が重複しています' };
  return { q, opts };
}

async function listOdai() {
  return {
    odai: await getOdaiList(),
    builtinCount: ODAI.length,
    storage: kv.enabled ? 'redis' : 'memory',
    limits: { max: ODAI_MAX, optMin: OPT_MIN, optMax: OPT_MAX },
  };
}
async function createOdai(input) {
  const v = normalizeOdai(input);
  if (v.error) return v;
  const list = [...await getOdaiList()];
  if (list.length >= ODAI_MAX) return { error: `お題は${ODAI_MAX}件までです` };
  // id は使用済み管理（usedOdaiIds）の鍵なので、既存と絶対に被らせない
  const id = list.reduce((m, o) => Math.max(m, Number(o.id) || 0), 0) + 1;
  list.push({ id, q: v.q, opts: v.opts });
  await saveOdaiList(list);
  return { id, odai: list };
}
async function updateOdai(id, input) {
  const v = normalizeOdai(input);
  if (v.error) return v;
  const list = [...await getOdaiList()];
  const i = list.findIndex(o => Number(o.id) === Number(id));
  if (i < 0) return { error: 'そのお題は見つかりません' };
  list[i] = { id: Number(id), q: v.q, opts: v.opts };
  await saveOdaiList(list);
  return { id: Number(id), odai: list };
}
async function deleteOdai(id) {
  const list = await getOdaiList();
  const next = list.filter(o => Number(o.id) !== Number(id));
  if (next.length === list.length) return { error: 'そのお題は見つかりません' };
  if (!next.length) return { error: '最後の1件は削除できません' };
  await saveOdaiList(next);
  return { id: Number(id), odai: next };
}
// 組み込みリストに戻す（編集をやり直したい時の逃げ道）
async function resetOdai() {
  const list = ODAI.map(o => ({ id: o.id, q: o.q, opts: [...o.opts] }));
  await saveOdaiList(list);
  return { odai: list };
}
// 共有リスト（＝コード未指定のルームが使うお題）を、デッキの内容で丸ごと差し替える。
// 「普段使いのリスト」を作り直したい時に、デッキ作成画面の成果をそのまま昇格させる用
async function importDeckAsShared(code) {
  const deck = await getDeck(code);
  if (deck.error) return deck;
  if (deck.odai.length > ODAI_MAX) return { error: `お題は${ODAI_MAX}件までです` };
  const list = deck.odai.map((o, i) => ({ id: i + 1, q: o.q, opts: [...o.opts] }));
  await saveOdaiList(list);
  return { odai: list, from: { code: deck.code, name: deck.name } };
}

// ===== お題リスト（デッキ）=====
// ルームごとに使うお題を差し替えるための仕組み。作ると6文字のコードが出て、
// そのコードをルーム作成時に渡すと、そのリストでゲームが回る。
// 何も渡さなければ上の共通リスト（＝管理画面のリスト、無ければ組み込み）を使う。
const DECK_TTL_SEC = 90 * 24 * 60 * 60;   // 90日触られなければ消える
const DECK_MIN = 3;                        // 最低3お題ないとゲームにならない
const DECK_MAX = 200;
const DECK_NAME_MAX = 20;

if (!globalThis.__srtDecks) globalThis.__srtDecks = new Map();
const memDecks = globalThis.__srtDecks;

const deckKey = code => 'deck:' + code;
function dcode() {
  // ルームコード（4文字）と見分けがつくよう6文字。紛らわしい I/O/1/0 は不使用
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

// 保存前の共通処理。id はデッキ内で振り直す（元リストの id と衝突させない）
function normalizeDeck(name, items) {
  if (!Array.isArray(items)) return { error: 'お題リストが不正です' };
  if (items.length < DECK_MIN) return { error: `お題は${DECK_MIN}件以上必要です` };
  if (items.length > DECK_MAX) return { error: `お題は${DECK_MAX}件までです` };
  const odai = [];
  for (let i = 0; i < items.length; i++) {
    const v = normalizeOdai(items[i]);
    if (v.error) return { error: `${i + 1}件目: ${v.error}` };
    odai.push({ id: i + 1, q: v.q, opts: v.opts });
  }
  const nm = String(name || '').trim().slice(0, DECK_NAME_MAX) || 'カスタムリスト';
  return { name: nm, odai };
}

async function readDeck(code) {
  if (kv.enabled) return await kv.get(deckKey(code));
  return memDecks.has(code) ? memDecks.get(code) : null;
}
async function writeDeck(code, deck, isNew) {
  const raw = JSON.stringify(deck);
  if (kv.enabled) {
    return isNew ? await kv.setNew(deckKey(code), raw, DECK_TTL_SEC)
                 : (await kv.set(deckKey(code), raw), true);
  }
  if (isNew && memDecks.has(code)) return false;
  memDecks.set(code, raw);
  return true;
}

async function getDeck(code) {
  const c = String(code || '').toUpperCase().trim();
  if (!c) return { error: 'コードを入力してください' };
  let raw;
  try { raw = await readDeck(c); }
  catch (e) { return { error: '通信エラーが発生しました' }; }
  if (!raw) return { error: 'そのお題リストは見つかりません' };
  try { return JSON.parse(raw); }
  catch (e) { return { error: 'そのお題リストは見つかりません' }; }
}

// コード指定ありなら「そのコードで保存」（既にあれば中身を差し替え）。
// 指定なしなら空いているコードを振り出す。作成済みのルームは保存時点の内容を
// 抱えているので、更新しても進行中のゲームには影響しない
async function saveDeck(code, name, items) {
  const v = normalizeDeck(name, items);
  if (v.error) return v;
  const now = Date.now();

  if (code) {
    const c = normalizeCode(code);
    if (!c) return { error: CODE_NG };
    const cur = await getDeck(c);
    const deck = {
      code: c, name: v.name, odai: v.odai,
      createdAt: cur.error ? now : cur.createdAt, updatedAt: now,
    };
    try {
      await writeDeck(c, deck, false);
    } catch (e) { return { error: '通信エラーが発生しました' }; }
    return deck;
  }

  for (let i = 0; i < 8; i++) {
    const c = dcode();
    const deck = { code: c, name: v.name, odai: v.odai, createdAt: now, updatedAt: now };
    try {
      if (await writeDeck(c, deck, true)) return deck;
    } catch (e) { return { error: '通信エラーが発生しました' }; }
  }
  return { error: '作成に失敗しました。もう一度お試しください' };
}
const createDeck = (name, items) => saveDeck(null, name, items);

// ===== Room CRUD =====
// laps は「全員が親を1回ずつやる」を何周するか。実際のラウンド数は
// 開始時の人数×周回数で決まるので、ここでは確定させない
async function createRoom(hostName, laps, answerSeconds, revealSeconds, deckCode, wantCode) {
  const hostId = rid();
  // 自分でコードを決めた場合はそれ以外では作らない（勝手に別コードにしない）
  let fixedCode = null;
  if (wantCode) {
    fixedCode = normalizeCode(wantCode);
    if (!fixedCode) return { error: CODE_NG };
  }
  // デッキ指定があれば作成時点の内容をルームに焼き込む。以降そのリストで進行し、
  // 元のデッキが編集されても進行中のゲームは変わらない
  let pool = null, deckName = null, usedDeck = null;
  if (deckCode) {
    const d = await getDeck(deckCode);
    if (d.error) return d;
    pool = d.odai; deckName = d.name; usedDeck = d.code;
  }
  const build = code => ({
    code, createdAt: Date.now(), hostId,
    phase: 'lobby',
    odaiPool: pool, deckCode: usedDeck, deckName,
    players: [{ id: hostId, name: hostName, score: 0, color: COLORS[0] }],
    laps: Math.min(3, Math.max(1, parseInt(laps) || 1)),
    totalRounds: 0,   // start 時に「人数 × 周回数」で確定する
    answerSeconds: answerSeconds || 120,
    revealSeconds: revealSeconds || 60,
    round: 0, oyaIdx: 0,
    odai: null, drawCandidate: null, oyaAnswer: [],
    answers: {}, submitted: {}, ready: {},
    flipped: [false, false, false], payoutOpen: false,
    roundResults: [], sanrentans: [], usedOdaiIds: [], deadline: null,
    lastSeen: { [hostId]: Date.now() },
  });
  if (fixedCode) {
    try {
      if (await saveNew(fixedCode, build(fixedCode))) return { code: fixedCode, playerId: hostId };
    } catch (e) { return { error: '通信エラーが発生しました' }; }
    return { error: 'そのルームコードは使われています' };
  }
  // 自動生成は4文字なので衝突しうる。SETNX で取れるまで振り直す
  for (let i = 0; i < 8; i++) {
    const code = rcode();
    try {
      if (await saveNew(code, build(code))) return { code, playerId: hostId };
    } catch (e) { return { error: '通信エラーが発生しました' }; }
  }
  return { error: 'ルーム作成に失敗しました。もう一度お試しください' };
}

async function joinRoom(code, name) {
  return withRoom(code, room => {
    if (room.phase !== 'lobby') return { error: 'ゲーム進行中です' };
    if (room.players.length >= 8) return { error: '満員です（最大8人）' };
    if (room.players.some(p => p.name === name)) return { error: 'その名前は使われています' };
    const playerId = rid();
    room.players.push({ id: playerId, name, score: 0, color: freeColor(room) });
    room.lastSeen[playerId] = Date.now();
    return { playerId };
  });
}

// ===== Actions =====
// room を直接受けとる純粋な適用関数。永続化は withRoom 側が受け持つ
function applyAction(room, playerId, action, data, odai) {
  if (!room.players.find(p => p.id === playerId)) return { error: 'プレイヤーが見つかりません' };

  switch (action) {
    case 'start': {
      if (playerId !== room.hostId) return { error: 'ホストのみ' };
      if (room.players.length < 2) return { error: '2人以上必要' };
      room.round = 0; room.oyaIdx = 0; room.usedOdaiIds = []; room.sanrentans = [];
      room.players.forEach(p => p.score = 0);
      fixRounds(room);
      startRound(room, odai);
      break;
    }
    case 'draw_reroll': {
      if (room.phase !== 'draw') return { error: 'フェーズ違い' };
      if (room.players[room.oyaIdx].id !== playerId) return { error: '親ではない' };
      pickCandidate(room, odai);
      // 引き直し直後に即オートコンフィームされないよう最低猶予を確保
      room.deadline = Math.max(room.deadline || 0, Date.now() + REROLL_FLOOR_MS);
      break;
    }
    case 'draw_confirm': {
      if (room.phase !== 'draw') return { error: 'フェーズ違い' };
      if (room.players[room.oyaIdx].id !== playerId) return { error: '親ではない' };
      confirmOdai(room, odai);
      break;
    }
    case 'submit_answer': {
      if (room.phase !== 'answer') return { error: 'フェーズ違い' };
      if (room.submitted[playerId]) return { error: '提出済み' };
      if (!Array.isArray(data.answer) || data.answer.length !== 3) return { error: '3つ選んでください' };
      // 正規化＆妥当性: 整数化・重複なし・範囲内（型ゆれで採点が壊れるのを防ぐ）
      const n = room.odai.opts.length;
      const ans = data.answer.map(Number);
      if (ans.some(i => !Number.isInteger(i) || i < 0 || i >= n) || new Set(ans).size !== 3) {
        return { error: '選択が不正です' };
      }
      room.answers[playerId] = ans;
      room.submitted[playerId] = true;
      if (allActiveDone(room, room.submitted)) finalizeRound(room);
      break;
    }
    case 'flip_card': {
      if (room.phase !== 'reveal') return { error: 'フェーズ違い' };
      if (room.players[room.oyaIdx].id !== playerId) return { error: '親ではない' };
      if (room.payoutOpen) return { error: 'オープン済み' };
      const rank = Number(data.rank);
      if (!Number.isInteger(rank) || rank < 0 || rank > 2) return { error: 'カード指定が不正です' };
      room.flipped[rank] = true;
      // 3枚開いた時点で配当は自動オープン（親のボタン操作を挟まない）
      if (room.flipped.every(Boolean)) openPayout(room);
      break;
    }
    // 3枚目のめくりで自動オープンするので通常は届かない（旧クライアント用の保険）
    case 'open_payout': {
      if (room.phase !== 'reveal') return { error: 'フェーズ違い' };
      if (room.players[room.oyaIdx].id !== playerId) return { error: '親ではない' };
      if (room.payoutOpen) break; // 二重押しは無視
      if (!room.flipped.every(Boolean)) return { error: '3枚めくってください' };
      openPayout(room);
      break;
    }
    case 'ready_next': {
      if (room.phase !== 'reveal') return { error: 'フェーズ違い' };
      // 配当オープン前に進まれると発表が飛ぶので拒否する
      if (!room.payoutOpen) return { error: '配当オープン前です' };
      room.ready[playerId] = true;
      if (allActiveDone(room, room.ready)) advanceRound(room, odai);
      break;
    }
    case 'play_again': {
      if (playerId !== room.hostId) return { error: 'ホストのみ' };
      room.players.forEach(p => p.score = 0);
      room.round = 0; room.oyaIdx = 0; room.usedOdaiIds = []; room.sanrentans = [];
      fixRounds(room);   // 人数が変わっているかもしれないので取り直す
      startRound(room, odai);
      break;
    }
    case 'leave': {
      // ロビーなら席をすぐ空ける。ゲーム中は players を抜くと親順（oyaIdx）や
      // 採点済みの結果がずれるので、離脱扱いにして待たれないようにするだけ
      if (room.phase === 'lobby') {
        room.players = room.players.filter(p => p.id !== playerId);
        delete room.lastSeen[playerId];
        delete room.answers[playerId];
        delete room.submitted[playerId];
        delete room.ready[playerId];
        if (!room.players.find(p => p.id === room.hostId)) {
          room.hostId = room.players.length ? room.players[0].id : null;
        }
      } else {
        room.lastSeen[playerId] = 0;
      }
      return { left: true };
    }
    case 'back_to_lobby': {
      if (playerId !== room.hostId) return { error: 'ホストのみ' };
      resetToLobby(room);
      break;
    }
    default: return { error: '不明なアクション' };
  }
  return { ok: true };
}

// ===== Round Lifecycle =====
// 開始時点の人数で総ラウンド数を確定させる。以降ゲーム中は動かさない
// （途中退出しても players から抜かないので、親の一巡は崩れない）
function fixRounds(room) {
  room.totalRounds = room.players.length * (room.laps || 1);
}

// odai は「今のお題リスト」。管理画面で編集されうるので定数ではなく引数で渡す
function startRound(room, odai) {
  room.round++;
  room.answers = {}; room.submitted = {}; room.ready = {};
  room.roundResults = []; room.oyaAnswer = [];
  room.flipped = [false, false, false]; room.payoutOpen = false;
  room.odai = null; room.drawCandidate = null;
  const avail = odai.filter(o => !room.usedOdaiIds.includes(o.id));
  if (!avail.length || room.round > room.totalRounds) { room.phase = 'final'; room.deadline = null; return; }
  room.phase = 'draw';
  room.deadline = Date.now() + DRAW_TIMEOUT;
  pickCandidate(room, odai);
}

// 未使用お題からランダムに候補を1件選ぶ（直前の候補は可能なら避ける）
function pickCandidate(room, odai) {
  let avail = odai.filter(o => !room.usedOdaiIds.includes(o.id));
  if (!avail.length) return;
  if (avail.length > 1 && room.drawCandidate) {
    avail = avail.filter(o => o.id !== room.drawCandidate.id);
  }
  room.drawCandidate = avail[Math.floor(Math.random() * avail.length)];
}

function confirmOdai(room, odaiList) {
  if (!room.drawCandidate) pickCandidate(room, odaiList);
  const odai = room.drawCandidate;
  if (!odai) { room.phase = 'final'; room.deadline = null; return; }
  room.odai = odai;
  room.usedOdaiIds.push(odai.id);
  room.drawCandidate = null;
  room.phase = 'answer';
  room.answers = {}; room.submitted = {};
  room.deadline = Date.now() + room.answerSeconds * 1000;
}

function advanceRound(room, odai) {
  room.oyaIdx = (room.oyaIdx + 1) % room.players.length;
  startRound(room, odai);
}

function resetToLobby(room) {
  room.phase = 'lobby';
  room.round = 0; room.oyaIdx = 0; room.usedOdaiIds = []; room.totalRounds = 0;
  room.sanrentans = [];
  room.odai = null; room.drawCandidate = null; room.oyaAnswer = [];
  room.answers = {}; room.submitted = {}; room.ready = {};
  room.flipped = [false, false, false]; room.payoutOpen = false;
  room.roundResults = []; room.deadline = null;
  room.players.forEach(p => p.score = 0);
}

// ===== Scoring =====
function calcScore(oya, pred) {
  const [o1,o2,o3] = oya, [p1,p2,p3] = pred;
  if (p1===o1&&p2===o2&&p3===o3) return {yaku:'サンレンタン',pts:6,cls:'sanrentan'};
  const os = new Set(oya);
  if (pred.every(p=>os.has(p))&&oya.every(o=>new Set(pred).has(o))) return {yaku:'サンレンプク',pts:4,cls:'sanrenpuku'};
  if (p1===o1&&p2===o2) return {yaku:'ニレンタン',pts:3,cls:'nirentan'};
  if (pred.filter(p=>os.has(p)).length>=2) return {yaku:'プクプク',pts:2,cls:'pukupuku'};
  if (p1===o1) return {yaku:'タン',pts:1,cls:'tan'};
  return {yaku:'ハズレ',pts:0,cls:'hazure'};
}

// 回答締切: 未回答者へランダム割当（共通ルール・親含む）→ 採点 → 発表フェーズへ
function finalizeRound(room) {
  const oya = room.players[room.oyaIdx];
  room.players.forEach(p => {
    const a = room.answers[p.id];
    if (!Array.isArray(a) || a.length !== 3) {
      room.answers[p.id] = randomPicks(room.odai);
      room.submitted[p.id] = true;
    }
  });
  const oyaAnswer = room.answers[oya.id];
  room.oyaAnswer = oyaAnswer;
  room.roundResults = [];
  room.players.forEach(p => {
    if (p.id === oya.id) return;
    const pred = room.answers[p.id];
    const r = calcScore(oyaAnswer, pred);
    p.score += r.pts;
    room.roundResults.push({ id: p.id, name: p.name, pred, ...r, total: p.score });
  });
  room.roundResults.sort((a, b) => b.pts - a.pts);
  // 最高役だけは最終結果まで残す。roundResults はラウンド頭で捨てられるのでここで控える
  if (!Array.isArray(room.sanrentans)) room.sanrentans = [];
  room.roundResults.filter(r => r.cls === 'sanrentan').forEach(r => {
    room.sanrentans.push({
      round: room.round, name: r.name, oyaName: oya.name,
      q: room.odai.q, picks: r.pred.map(i => room.odai.opts[i]),
    });
  });
  room.phase = 'reveal';
  room.ready = {};
  // 発表は2段階。まず親が3枚めくる（FLIP_TIMEOUT）、その後が配当タイム（revealSeconds）
  room.flipped = [false, false, false];
  room.payoutOpen = false;
  room.deadline = Date.now() + FLIP_TIMEOUT;
}

// 3枚を開き切って配当へ。親のAFK・離脱時もここに合流する
function openPayout(room) {
  room.flipped = [true, true, true];
  room.payoutOpen = true;
  room.ready = {};
  room.deadline = Date.now() + room.revealSeconds * 1000;
}

// ===== View Builder =====
// room を進行させつつ view を返す（副作用あり）。永続化は withRoom 側。
function buildView(room, playerId, odai) {
  const now = Date.now();
  // 毎回書くと Redis への書込がポーリング数だけ発生するので、
  // 切断判定(DISCONNECT_MS)に対して十分細かい間隔でだけ更新する
  if (playerId && now - (room.lastSeen[playerId] || 0) > SEEN_REFRESH_MS) {
    room.lastSeen[playerId] = now;
  }
  if (room.phase === 'lobby') pruneLobby(room, now);

  // 進行判定（1ポーリングにつき1遷移）。まずタイマー到達、次に離脱者を待たない完了。
  if (room.deadline && now > room.deadline) {
    if (room.phase === 'draw') confirmOdai(room, odai);
    else if (room.phase === 'answer') finalizeRound(room);
    // めくり待ちで時間切れ→自動オープン。配当タイム切れ→次ラウンド
    else if (room.phase === 'reveal') room.payoutOpen ? advanceRound(room, odai) : openPayout(room);
  } else if (room.phase === 'draw') {
    const o = room.players[room.oyaIdx];
    if (o && !isConnected(room, o, now)) confirmOdai(room, odai); // 親が離脱→即確定
  } else if (room.phase === 'answer') {
    if (allActiveDone(room, room.submitted)) finalizeRound(room);
  } else if (room.phase === 'reveal') {
    const o = room.players[room.oyaIdx];
    if (!room.payoutOpen && o && !isConnected(room, o, now)) openPayout(room); // 親が離脱→即オープン
    else if (room.payoutOpen && allActiveDone(room, room.ready)) advanceRound(room, odai);
  }
  const oya = room.players[room.oyaIdx] || {};
  const v = {
    phase: room.phase,
    players: room.players.map(p => ({ id:p.id, name:p.name, score:p.score, color:p.color })),
    round: room.round, totalRounds: room.totalRounds, laps: room.laps || 1,
    oyaIdx: room.oyaIdx, oyaId: oya.id, oyaName: oya.name,
    roomCode: room.code,
    // どのお題リストで遊んでいるか（ロビー表示用）。null なら共通リスト
    deckName: room.deckName || null,
    deckCode: room.deckCode || null,
    odaiCount: odai.length,
    isHost: room.hostId === playerId,
    isOya: oya.id === playerId,
    hasSubmitted: !!room.submitted[playerId],
    isReady: !!room.ready[playerId],
    myId: playerId,
    now,
    deadline: room.deadline,
    answerSeconds: room.answerSeconds,
    revealSeconds: room.revealSeconds,
    drawSeconds: Math.round(DRAW_TIMEOUT / 1000),
    flipSeconds: Math.round(FLIP_TIMEOUT / 1000),
  };
  if (room.phase === 'draw') {
    // 候補お題は親にのみ公開。他プレイヤーは待機
    if (oya.id === playerId) v.odai = room.drawCandidate;
  }
  if (room.phase === 'answer') {
    v.odai = room.odai;
    // 自分の提出内容だけ返す（待機中に見返す用）。他人の予想は reveal まで伏せる
    v.myAnswer = room.submitted[playerId] ? room.answers[playerId] : null;
    v.submittedStatus = {};
    room.players.forEach(p => { v.submittedStatus[p.id] = !!room.submitted[p.id]; });
  }
  if (room.phase === 'reveal') {
    v.odai = room.odai;
    v.flipped = room.flipped.map(Boolean);
    v.payoutOpen = !!room.payoutOpen;
    // 未オープンの枠は null で送る。クライアントに答えを渡さないことで
    // DOM を覗いてもフライングできないようにする
    v.oyaAnswer = room.oyaAnswer.map((idx, r) => (room.flipped[r] ? idx : null));
    // その枠を的中させた人数（オープン済みの枠のみ）
    v.hits = room.oyaAnswer.map((idx, r) => (
      room.flipped[r]
        ? room.roundResults.filter(x => x.pred[r] === idx).length
        : null
    ));
    // 予想手は最初から公開。役と点は配当オープンまで伏せる
    const colorOf = {};
    room.players.forEach(p => { colorOf[p.id] = p.color; });
    v.preds = room.roundResults.map(r => ({
      id: r.id, name: r.name, pred: r.pred, color: colorOf[r.id],
    }));
    v.roundResults = room.payoutOpen ? room.roundResults : [];
    if (!room.payoutOpen) {
      // 加点は finalizeRound で反映済みなので、配当前はラウンド前の持ち点に戻して送る
      const gained = {};
      room.roundResults.forEach(r => { gained[r.id] = r.pts; });
      v.players = v.players.map(p => ({ ...p, score: p.score - (gained[p.id] || 0) }));
    }
    v.readyStatus = {};
    room.players.forEach(p => { v.readyStatus[p.id] = !!room.ready[p.id]; });
  }
  if (room.phase === 'final') {
    v.finalRanking = [...room.players].sort((a, b) => b.score - a.score);
    v.sanrentans = room.sanrentans || [];   // 旧データの部屋は空扱い
  }
  return v;
}

// ===== Public API (すべて非同期・永続化込み) =====
// ルーム専用リスト（odaiPool）があればそれを、無ければ共通リストを使う
const roomOdai = (room, shared) =>
  (Array.isArray(room.odaiPool) && room.odaiPool.length) ? room.odaiPool : shared;

// お題リストは withRoom の中（同期）で必要になるので、先に読んでから渡す
async function processAction(code, playerId, action, data) {
  const shared = await getOdaiList();
  return withRoom(code, room => {
    const odai = roomOdai(room, shared);
    const r = applyAction(room, playerId, action, data, odai);
    if (r.error) return r;
    if (r.left) return { ok: true };   // もう部屋にいないので view は作らない
    return buildView(room, playerId, odai);
  });
}
// GET も進行判定(締切到達・全員完了)で room を進めるので同じ経路を通す
async function getView(code, playerId) {
  const shared = await getOdaiList();
  return withRoom(code, room => buildView(room, playerId, roomOdai(room, shared)));
}

module.exports = {
  createRoom, joinRoom, processAction, getView, storageEnabled: kv.enabled,
  listOdai, createOdai, updateOdai, deleteOdai, resetOdai, importDeckAsShared,
  getDeck, saveDeck, createDeck, getSharedOdai: getOdaiList,
};
