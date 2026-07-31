// ===== SANRENTAN Server-Side Game Store =====
// In-memory storage. Persists across warm serverless invocations.

const COLORS = ['#E53935','#1E88E5','#43A047','#FB8C00','#9C27B0','#00897B','#F4511E','#5C6BC0'];
const TTL = 2 * 60 * 60 * 1000;
const DRAW_TIMEOUT = 45 * 1000; // お題選択フェーズのAFK自動確定（親設定対象外）

if (!globalThis.__srtRooms) globalThis.__srtRooms = new Map();
const rooms = globalThis.__srtRooms;

// ===== Helpers =====
function rid() { return Math.random().toString(36).substring(2, 12); }
function rcode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function cleanup() {
  const now = Date.now();
  for (const [k, v] of rooms) { if (now - v.createdAt > TTL) rooms.delete(k); }
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

// ===== ODAI Data =====
const ODAI = [
  {id:1,q:"恋人に求める絶対条件",opts:["顔","性格","金銭感覚","酒のモチベ","連絡頻度","食の好み","休日の過ごし方"]},
  {id:2,q:"百万円手に入ったら？",opts:["貯金","旅行","投資","服など爆買い","高級ブランド品","ギャンブル","友達と焼肉"]},
  {id:3,q:"徹夜明けに一番沁みるもの",opts:["ラーメン","サウナ","味噌汁","風呂","ふかふかベッド","牛丼","そば"]},
  {id:4,q:"旅行で一番アガる瞬間",opts:["企画中","車内","現地の買い出し","飲みゲー","BBQ","観光","銭湯・サウナ"]},
  {id:5,q:"FPSで一番脳汁が出る瞬間",opts:["1vXクラッチ","連続HS","完璧な裏取り","フリックエイム","昇格戦勝利","実力でわからせる","味方のナイス"]},
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
];

// ===== Room CRUD =====
function createRoom(hostName, totalRounds, answerSeconds, revealSeconds) {
  cleanup();
  let code;
  do { code = rcode(); } while (rooms.has(code));
  const hostId = rid();
  const room = {
    code, createdAt: Date.now(), hostId,
    phase: 'lobby',
    players: [{ id: hostId, name: hostName, score: 0, color: COLORS[0] }],
    totalRounds: totalRounds || 5,
    answerSeconds: answerSeconds || 120,
    revealSeconds: revealSeconds || 60,
    round: 0, oyaIdx: 0,
    odai: null, drawCandidate: null, oyaAnswer: [],
    answers: {}, submitted: {}, ready: {},
    roundResults: [], usedOdaiIds: [], deadline: null,
  };
  rooms.set(code, room);
  return { code, playerId: hostId };
}

function getRoom(code) { cleanup(); return rooms.get(code) || null; }

function joinRoom(code, name) {
  const room = getRoom(code);
  if (!room) return { error: 'ルームが見つかりません' };
  if (room.phase !== 'lobby') return { error: 'ゲーム進行中です' };
  if (room.players.length >= 8) return { error: '満員です（最大8人）' };
  if (room.players.some(p => p.name === name)) return { error: 'その名前は使われています' };
  const playerId = rid();
  room.players.push({ id: playerId, name, score: 0, color: COLORS[room.players.length % COLORS.length] });
  return { playerId };
}

// ===== Actions =====
function processAction(code, playerId, action, data) {
  const room = getRoom(code);
  if (!room) return { error: 'ルームが見つかりません' };
  if (!room.players.find(p => p.id === playerId)) return { error: 'プレイヤーが見つかりません' };

  switch (action) {
    case 'start': {
      if (playerId !== room.hostId) return { error: 'ホストのみ' };
      if (room.players.length < 2) return { error: '2人以上必要' };
      room.round = 0; room.oyaIdx = 0; room.usedOdaiIds = [];
      room.players.forEach(p => p.score = 0);
      startRound(room);
      break;
    }
    case 'draw_reroll': {
      if (room.phase !== 'draw') return { error: 'フェーズ違い' };
      if (room.players[room.oyaIdx].id !== playerId) return { error: '親ではない' };
      pickCandidate(room);
      break;
    }
    case 'draw_confirm': {
      if (room.phase !== 'draw') return { error: 'フェーズ違い' };
      if (room.players[room.oyaIdx].id !== playerId) return { error: '親ではない' };
      confirmOdai(room);
      break;
    }
    case 'submit_answer': {
      if (room.phase !== 'answer') return { error: 'フェーズ違い' };
      if (room.submitted[playerId]) return { error: '提出済み' };
      if (!Array.isArray(data.answer) || data.answer.length !== 3) return { error: '3つ選んでください' };
      // 妥当性: 重複なし & 範囲内
      const n = room.odai.opts.length;
      if (new Set(data.answer).size !== 3 || data.answer.some(i => i < 0 || i >= n)) {
        return { error: '選択が不正です' };
      }
      room.answers[playerId] = data.answer;
      room.submitted[playerId] = true;
      if (room.players.every(p => room.submitted[p.id])) finalizeRound(room);
      break;
    }
    case 'ready_next': {
      if (room.phase !== 'reveal') return { error: 'フェーズ違い' };
      room.ready[playerId] = true;
      if (room.players.every(p => room.ready[p.id])) advanceRound(room);
      break;
    }
    case 'play_again': {
      if (playerId !== room.hostId) return { error: 'ホストのみ' };
      room.players.forEach(p => p.score = 0);
      room.round = 0; room.oyaIdx = 0; room.usedOdaiIds = [];
      startRound(room);
      break;
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
function startRound(room) {
  room.round++;
  room.answers = {}; room.submitted = {}; room.ready = {};
  room.roundResults = []; room.oyaAnswer = [];
  room.odai = null; room.drawCandidate = null;
  const avail = ODAI.filter(o => !room.usedOdaiIds.includes(o.id));
  if (!avail.length || room.round > room.totalRounds) { room.phase = 'final'; room.deadline = null; return; }
  room.phase = 'draw';
  room.deadline = Date.now() + DRAW_TIMEOUT;
  pickCandidate(room);
}

// 未使用お題からランダムに候補を1件選ぶ（直前の候補は可能なら避ける）
function pickCandidate(room) {
  let avail = ODAI.filter(o => !room.usedOdaiIds.includes(o.id));
  if (!avail.length) return;
  if (avail.length > 1 && room.drawCandidate) {
    avail = avail.filter(o => o.id !== room.drawCandidate.id);
  }
  room.drawCandidate = avail[Math.floor(Math.random() * avail.length)];
}

function confirmOdai(room) {
  if (!room.drawCandidate) pickCandidate(room);
  const odai = room.drawCandidate;
  if (!odai) { room.phase = 'final'; room.deadline = null; return; }
  room.odai = odai;
  room.usedOdaiIds.push(odai.id);
  room.drawCandidate = null;
  room.phase = 'answer';
  room.answers = {}; room.submitted = {};
  room.deadline = Date.now() + room.answerSeconds * 1000;
}

function advanceRound(room) {
  room.oyaIdx = (room.oyaIdx + 1) % room.players.length;
  startRound(room);
}

function resetToLobby(room) {
  room.phase = 'lobby';
  room.round = 0; room.oyaIdx = 0; room.usedOdaiIds = [];
  room.odai = null; room.drawCandidate = null; room.oyaAnswer = [];
  room.answers = {}; room.submitted = {}; room.ready = {};
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
  room.phase = 'reveal';
  room.ready = {};
  room.deadline = Date.now() + room.revealSeconds * 1000;
}

// ===== View Builder =====
function buildView(room, playerId) {
  // タイマー到達で自動進行（既存の副作用パターン。1ポーリングにつき1遷移）
  const now = Date.now();
  if (room.deadline && now > room.deadline) {
    if (room.phase === 'draw') confirmOdai(room);
    else if (room.phase === 'answer') finalizeRound(room);
    else if (room.phase === 'reveal') advanceRound(room);
  }
  const oya = room.players[room.oyaIdx] || {};
  const v = {
    phase: room.phase,
    players: room.players.map(p => ({ id:p.id, name:p.name, score:p.score, color:p.color })),
    round: room.round, totalRounds: room.totalRounds,
    oyaIdx: room.oyaIdx, oyaId: oya.id, oyaName: oya.name,
    roomCode: room.code,
    isHost: room.hostId === playerId,
    isOya: oya.id === playerId,
    hasSubmitted: !!room.submitted[playerId],
    isReady: !!room.ready[playerId],
    myId: playerId,
    now,
    deadline: room.deadline,
    answerSeconds: room.answerSeconds,
    revealSeconds: room.revealSeconds,
  };
  if (room.phase === 'draw') {
    // 候補お題は親にのみ公開。他プレイヤーは待機
    if (oya.id === playerId) v.odai = room.drawCandidate;
  }
  if (room.phase === 'answer') {
    v.odai = room.odai;
    v.submittedStatus = {};
    room.players.forEach(p => { v.submittedStatus[p.id] = !!room.submitted[p.id]; });
  }
  if (room.phase === 'reveal') {
    v.odai = room.odai;
    v.oyaAnswer = room.oyaAnswer;
    v.answers = room.answers;
    v.roundResults = room.roundResults;
    v.readyStatus = {};
    room.players.forEach(p => { v.readyStatus[p.id] = !!room.ready[p.id]; });
  }
  if (room.phase === 'final') {
    v.finalRanking = [...room.players].sort((a, b) => b.score - a.score);
  }
  return v;
}

module.exports = { createRoom, getRoom, joinRoom, processAction, buildView };
