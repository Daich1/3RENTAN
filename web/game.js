// ===== SANRENTAN -Nelo Edition- Online (Server-Based) =====

const LETTERS = ['A','B','C','D','E','F','G'];
const BADGES  = ['badge-a','badge-b','badge-c','badge-d','badge-e','badge-f','badge-g'];
const API     = '/api/game';
const POLL_MS = 1000;
const LS_KEY  = 'srt_session';

// ===== State =====
let myPlayerId = null;
let roomCode   = null;
let pollTimer  = null;
let lastPhase  = null;
let selPicks   = [];
let selMode    = null; // 'oya' | 'predict' | null
let selOdai    = null;
let lastCandidateId = null;
let lobbyCount = 0;

// Timer
let clockOffset  = 0;      // serverNow - clientNow
let timerDeadline = null;
let timerTotalMs = 0;
let timerTicker  = null;
let lastTickSec  = null;  // 秒読みSEを1秒1回にする

// ===== Helpers =====
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function esc(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}
function showScreen(id) {
  const el = $(`#screen-${id}`);
  if (!el || el.classList.contains('active')) return; // 毎ポーリングで呼ばれるので同じ画面なら何もしない
  $$('.screen').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  window.scrollTo(0,0);
}
// textContent を毎回代入するとテキストノードが作り直され、
// 選択（コピペ）が1秒ごとに解除されるので値が変わった時だけ書く
function setText(el, str) {
  if (el && el.textContent !== str) el.textContent = str;
}
function clearList(el) {
  el.innerHTML = '';
  delete el.dataset.sig;
}

// ===== Sound =====
// 画面ごとのBGM。タイトル〜参加までは無音にして、ロビーに入ってから鳴らす
function bgmForPhase(phase) {
  Sound.bgm(
    phase === 'reveal' ? 'reveal'
    : (phase === 'draw' || phase === 'answer') ? 'answer'
    : phase === 'final' ? null
    : 'lobby'
  );
}
// ボタンの共通タップ音。専用音がある選択肢・順位カードと、音量パネル自身は除く
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled || b.id === 'btn-sound') return;
  if (b.closest('#select-choices') || b.closest('#reveal-cards') || b.closest('#sound-panel')) return;
  Sound.play(b.classList.contains('btn-link') || b.classList.contains('btn-back') ? 'back' : 'tap');
});

// ===== 音量パネル =====
const soundBtn = $('#btn-sound'), soundPanel = $('#sound-panel');
const volBgm = $('#vol-bgm'), volSfx = $('#vol-sfx'), muteBtn = $('#btn-mute');

function paintSoundUI() {
  const on = Sound.isOn();
  const v = Sound.getVol();
  soundBtn.textContent = on && (v.bgm > 0 || v.sfx > 0) ? '🔊' : '🔇';
  soundBtn.classList.toggle('off', !on);
  muteBtn.classList.toggle('on', !on);
  setText(muteBtn, on ? 'ミュート' : 'ミュート解除');
  setText($('#vol-bgm-num'), String(Math.round(v.bgm * 100)));
  setText($('#vol-sfx-num'), String(Math.round(v.sfx * 100)));
}
function openSoundPanel(open) {
  soundPanel.hidden = !open;
  soundBtn.classList.toggle('open', open);
  soundBtn.setAttribute('aria-expanded', String(open));
}
soundBtn.addEventListener('click', () => openSoundPanel(soundPanel.hidden));
// パネル外をタップしたら閉じる（ボタン自身のクリックはトグル側で処理済み）
document.addEventListener('click', e => {
  if (soundPanel.hidden) return;
  if (e.target.closest('#sound-panel') || e.target.closest('#btn-sound')) return;
  openSoundPanel(false);
});
muteBtn.addEventListener('click', () => { Sound.toggle(); paintSoundUI(); });
[[volBgm, 'bgm'], [volSfx, 'sfx']].forEach(([el, kind]) => {
  el.addEventListener('input', () => {
    if (!Sound.isOn()) Sound.toggle();   // 音量を触った＝鳴らしたい
    Sound.setVol(kind, el.value / 100);
    paintSoundUI();
  });
  // 離した時だけ試聴音を鳴らす（ドラッグ中に鳴らすと音が詰まる）
  el.addEventListener('change', () => { if (kind === 'sfx') Sound.play('pick', 1); });
});
volBgm.value = Math.round(Sound.getVol().bgm * 100);
volSfx.value = Math.round(Sound.getVol().sfx * 100);
paintSoundUI();

// ===== Session persistence (リロード復帰) =====
function saveSession() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ roomCode, myPlayerId })); } catch (e) {}
}
function clearSession() {
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
}
async function tryRestore() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) {}
  if (!s || !s.roomCode || !s.myPlayerId) return;
  roomCode = s.roomCode; myPlayerId = s.myPlayerId;
  try {
    const v = await apiGet({ code: roomCode, playerId: myPlayerId });
    if (!v.players || !v.players.some(p => p.id === myPlayerId)) throw new Error('not in room');
    renderView(v);
    startPolling();
  } catch (e) {
    roomCode = null; myPlayerId = null; clearSession();
  }
}

// ===== API =====
async function apiPost(body) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok && data.error) throw new Error(data.error);
  return data;
}
async function apiGet(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(API + '?' + qs);
  const data = await res.json();
  if (!res.ok && data.error) throw new Error(data.error);
  return data;
}

// ===== Polling =====
function startPolling() {
  stopPolling();
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (timerTicker) { clearInterval(timerTicker); timerTicker = null; }
}
async function poll() {
  if (!roomCode || !myPlayerId) return;
  try {
    const v = await apiGet({ code: roomCode, playerId: myPlayerId });
    renderView(v);
  } catch (e) {
    // Silent fail for transient network issues
  }
}

// ===== Countdown Timer =====
function updateTimer(v) {
  const timed = v.deadline && ['draw','answer','reveal'].includes(v.phase);
  if (timed) {
    timerDeadline = v.deadline;
    timerTotalMs = v.phase === 'draw' ? (v.drawSeconds || 45) * 1000
      : v.phase === 'answer' ? (v.answerSeconds || 120) * 1000
      // 発表は「めくり待ち」と「配当タイム」で持ち時間が違う
      : v.payoutOpen ? (v.revealSeconds || 60) * 1000
      : (v.flipSeconds || 45) * 1000;
    $('#global-timer').style.display = 'block';
    if (!timerTicker) timerTicker = setInterval(tickTimer, 250);
    tickTimer();
  } else {
    timerDeadline = null;
    lastTickSec = null;
    $('#global-timer').style.display = 'none';
  }
}
function tickTimer() {
  if (!timerDeadline) return;
  const remain = timerDeadline - (Date.now() + clockOffset);
  const secs = Math.max(0, Math.ceil(remain / 1000));
  const pct = Math.max(0, Math.min(100, (remain / timerTotalMs) * 100));
  // ラスト10秒だけ秒読み。250ms 間隔で呼ばれるので秒が変わった時のみ
  if (secs !== lastTickSec) {
    if (secs > 0 && secs <= 10 && lastTickSec !== null) Sound.play('tick');
    lastTickSec = secs;
  }
  $('#global-timer-text').textContent = `残り ${secs} 秒`;
  const fill = $('#global-timer-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('danger', secs <= 10);
}

// ===== Navigation =====
$$('.btn-back').forEach(b => b.addEventListener('click', () => {
  stopPolling();
  myPlayerId = null; roomCode = null;
  clearSession();
  updateTimer({});
  Sound.bgm(null);
  showScreen(b.dataset.to);
}));
$('#btn-go-create').addEventListener('click', () => showScreen('create'));
$('#btn-go-join').addEventListener('click', () => showScreen('join'));
$('#btn-back-title').addEventListener('click', () => {
  stopPolling(); myPlayerId = null; roomCode = null;
  clearSession();
  updateTimer({});
  Sound.bgm(null);
  showScreen('title');
});

// ===== Create Room =====
$('#btn-create-room').addEventListener('click', async () => {
  const name = $('#create-name').value.trim();
  if (!name) { $('#create-status').textContent = '名前を入力してください'; return; }
  $('#btn-create-room').disabled = true;
  $('#create-status').textContent = '作成中...';
  try {
    const rounds = parseInt($('#create-rounds').value) || 5;
    const answerSeconds = parseInt($('#create-answer-sec').value) || 120;
    const revealSeconds = parseInt($('#create-reveal-sec').value) || 60;
    const data = await apiPost({ action: 'create', name, rounds, answerSeconds, revealSeconds });
    myPlayerId = data.playerId;
    roomCode = data.code;
    saveSession();
    showScreen('lobby');
    startPolling();
    $('#create-status').textContent = '';
  } catch (e) {
    $('#create-status').textContent = e.message;
  }
  $('#btn-create-room').disabled = false;
});

// ===== Join Room =====
$('#btn-join-room').addEventListener('click', async () => {
  const name = $('#join-name').value.trim();
  const code = $('#join-code').value.trim().toUpperCase();
  if (!name) { $('#join-status').textContent = '名前を入力してください'; return; }
  if (code.length !== 4) { $('#join-status').textContent = '4文字のコードを入力'; return; }
  $('#btn-join-room').disabled = true;
  $('#join-status').textContent = '参加中...';
  try {
    const data = await apiPost({ action: 'join', code, name });
    myPlayerId = data.playerId;
    roomCode = code;
    saveSession();
    showScreen('lobby');
    startPolling();
    $('#join-status').textContent = '';
  } catch (e) {
    $('#join-status').textContent = e.message;
  }
  $('#btn-join-room').disabled = false;
});

// ===== Send Action =====
async function sendAction(action, extra = {}) {
  try {
    await apiPost({ action, code: roomCode, playerId: myPlayerId, ...extra });
    poll(); // 即時反映
  } catch (e) {
    console.error('Action failed:', e.message);
  }
}

// ===== Game Controls =====
$('#btn-start-game').addEventListener('click', () => sendAction('start'));
$('#btn-draw-confirm').addEventListener('click', () => sendAction('draw_confirm'));
$('#btn-draw-reroll').addEventListener('click', () => sendAction('draw_reroll'));
$('#btn-ready-next').addEventListener('click', () => sendAction('ready_next'));
$('#btn-play-again').addEventListener('click', () => sendAction('play_again'));
$('#btn-back-lobby').addEventListener('click', () => sendAction('back_to_lobby'));

// ===== Render Dispatcher =====
function renderView(v) {
  clockOffset = (typeof v.now === 'number') ? v.now - Date.now() : 0;
  updateTimer(v);
  bgmForPhase(v.phase);
  if (lastPhase === 'reveal' && v.phase !== 'reveal') revealRound = null;
  // 復帰時に途中から入った場合は鳴らさない（lastPhase が null）
  if (lastPhase && lastPhase !== v.phase) {
    if (lastPhase === 'lobby' && v.phase === 'draw') Sound.play('start');
    if (v.phase === 'final') Sound.play('final');
  }
  switch (v.phase) {
    case 'lobby':   showScreen('lobby'); renderLobby(v);  break;
    case 'draw':    renderDraw(v);                        break;
    case 'answer':  renderAnswer(v);                      break;
    case 'reveal':  renderReveal(v);                      break;
    case 'final':   showScreen('final'); renderFinal(v);  break;
  }
  lastPhase = v.phase;
}

// ===== Lobby =====
function renderLobby(v) {
  setText($('#lobby-code'), v.roomCode);
  setText($('#lobby-rules'), `回答 ${v.answerSeconds}秒 / 発表 ${v.revealSeconds}秒 ・ 全${v.totalRounds}R`);
  // 顔ぶれが変わった時だけ組み直す。毎ポーリングで作り直すと
  // 入場アニメが再生され続けて名前が点滅し、コピーもできない
  const c = $('#lobby-players');
  const sig = v.players.map(p => p.id + ':' + p.name).join('|');
  if (c.dataset.sig !== sig) {
    // 増えた時だけ入室音（退出や初回描画では鳴らさない）
    if (c.dataset.sig && v.players.length > lobbyCount) Sound.play('join');
    lobbyCount = v.players.length;
    c.dataset.sig = sig;
    c.innerHTML = '';
    v.players.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'lobby-player';
      d.innerHTML = `<span class="p-dot" style="background:${p.color}"></span><span>${esc(p.name)}</span>${i===0?'<span class="p-host">HOST</span>':''}`;
      c.appendChild(d);
    });
  }
  if (v.isHost) {
    $('#lobby-host-controls').style.display = '';
    $('#btn-start-game').disabled = v.players.length < 2;
    setText($('#lobby-status'), v.players.length < 2 ? '2人以上で開始できます' : '準備OK！');
    $('#lobby-status').style.color = '';
  } else {
    $('#lobby-host-controls').style.display = 'none';
    setText($('#lobby-status'), 'ホストの開始を待っています...');
    $('#lobby-status').style.color = '#888';
  }
}

// ===== Draw (お題発表・親主導) =====
function renderDraw(v) {
  if (v.isOya) {
    showScreen('draw');
    setText($('#draw-round-badge'), `第${v.round}R / ${v.totalRounds}`);
    if (lastPhase !== 'draw') lastCandidateId = null;
    const odai = v.odai;
    if (odai && odai.id !== lastCandidateId) {
      lastCandidateId = odai.id;
      playDrawReveal(odai);
    }
  } else {
    showScreen('wait');
    setText($('#wait-title'), `${v.oyaName} がお題を選択中`);
    setText($('#wait-message'), '親が山札からお題を引いています…');
    clearList($('#wait-progress'));
    lastCandidateId = null;
  }
}
function playDrawReveal(odai) {
  const deck = $('#draw-deck'), cand = $('#draw-candidate'), ctrl = $('#draw-controls');
  deck.style.display = ''; cand.style.display = 'none'; ctrl.style.display = 'none';
  deck.classList.remove('shuffling'); void deck.offsetWidth; deck.classList.add('shuffling');
  Sound.play('deck');
  setTimeout(() => {
    Sound.play('odai');
    $('#draw-question').textContent = odai.q;
    const c = $('#draw-options'); c.innerHTML = '';
    odai.opts.forEach((o, i) => {
      const d = document.createElement('div');
      d.className = 'topic-opt';
      d.innerHTML = `<span class="opt-badge ${BADGES[i]}">${LETTERS[i]}</span> ${esc(o)}`;
      c.appendChild(d);
    });
    deck.style.display = 'none';
    cand.style.display = ''; ctrl.style.display = '';
    cand.classList.remove('pop'); void cand.offsetWidth; cand.classList.add('pop');
  }, 800);
}

// ===== Answer (回答・一斉) =====
function renderAnswer(v) {
  if (v.hasSubmitted) {
    showScreen('wait');
    setText($('#wait-title'), '提出済み！');
    setText($('#wait-message'), '全員の回答を待っています');
    renderSubmitProgress(v);
    return;
  }
  if (lastPhase !== 'answer' || selMode === null) {
    selPicks = []; selMode = v.isOya ? 'oya' : 'predict'; selOdai = v.odai;
    showScreen('select');
    setupSelectUI(v);
    // 親は山札演出で鳴っているので、待たされていた側にだけお題の音を出す
    if (!v.isOya && lastPhase) Sound.play('odai');
  }
}

// 名前の行は組み直さず、丸と OK/… だけ差し替える（点滅・選択解除の防止）
function renderSubmitProgress(v) {
  const c = $('#wait-progress');
  if (!v.submittedStatus) { clearList(c); return; }
  const sig = v.players.map(p => p.id + ':' + p.name).join('|');
  if (c.dataset.sig !== sig) {
    c.dataset.sig = sig;
    c.innerHTML = '';
    v.players.forEach(p => {
      const d = document.createElement('div');
      d.className = 'wait-player';
      d.innerHTML = `<span class="status-dot pending"></span>` +
        `<span class="sp-name">${esc(p.name)}${p.id === v.oyaId ? '（親）' : ''}</span>` +
        `<span class="sp-flag">…</span>`;
      c.appendChild(d);
    });
  }
  v.players.forEach((p, i) => {
    const row = c.children[i];
    if (!row) return;
    const done = !!v.submittedStatus[p.id];
    row.querySelector('.status-dot').className = `status-dot ${done ? 'done' : 'pending'}`;
    setText(row.querySelector('.sp-flag'), done ? 'OK' : '…');
  });
}

// ===== Selection UI =====
function setupSelectUI(v) {
  const odai = v.odai;
  selPicks = [];
  if (selMode === 'oya') {
    $('#select-role').textContent = '親';
    $('#select-title').textContent = '自分のTop3を選ぼう！';
    $('#select-hint').textContent = '1位〜3位の順に、あなたの本当の順位を選んでください';
  } else {
    $('#select-role').textContent = '予想者';
    $('#select-title').textContent = `${v.oyaName} が選ぶTop3を当てろ！`;
    $('#select-hint').textContent = '1位〜3位の順に予想してください';
  }
  $('#select-question').textContent = odai.q;
  resetRanks();
  buildChoices(odai);
  $('#btn-undo').disabled = true;
  $('#btn-confirm').disabled = true;
}

function buildChoices(odai) {
  const c = $('#select-choices');
  c.innerHTML = '';
  odai.opts.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.dataset.idx = i;
    btn.innerHTML = `<span class="opt-badge ${BADGES[i]}">${LETTERS[i]}</span> ${esc(opt)}`;
    btn.addEventListener('click', () => pickChoice(i));
    c.appendChild(btn);
  });
}

function pickChoice(idx) {
  if (selPicks.length >= 3 || selPicks.includes(idx)) return;
  Sound.play('pick', selPicks.length);
  selPicks.push(idx);
  refreshSelUI();
}

$('#btn-undo').addEventListener('click', () => {
  if (selPicks.length) Sound.play('undo');
  selPicks.pop();
  refreshSelUI();
});

$('#btn-confirm').addEventListener('click', () => {
  if (selPicks.length !== 3) return;
  Sound.play('submit');
  sendAction('submit_answer', { answer: [...selPicks] });
  showScreen('wait');
  setText($('#wait-title'), '提出済み！');
  setText($('#wait-message'), '全員の回答を待っています…');
  clearList($('#wait-progress'));
  selMode = null;
});

function refreshSelUI() {
  const odai = selOdai;
  if (!odai) return;
  $$('#select-ranks .rank-slot').forEach((slot, i) => {
    const val = slot.querySelector('.rank-val');
    if (i < selPicks.length) {
      const idx = selPicks[i];
      slot.classList.add('filled');
      val.textContent = `${LETTERS[idx]} ${odai.opts[idx]}`;
      val.style.color = '';
    } else {
      slot.classList.remove('filled');
      val.textContent = '？';
      val.style.color = '#bbb';
    }
  });
  $$('#select-choices .choice-btn').forEach(btn => {
    btn.classList.toggle('used', selPicks.includes(parseInt(btn.dataset.idx)));
  });
  $('#btn-undo').disabled = selPicks.length === 0;
  $('#btn-confirm').disabled = selPicks.length !== 3;
}

function resetRanks() {
  $$('#select-ranks .rank-slot').forEach(slot => {
    slot.classList.remove('filled');
    slot.querySelector('.rank-val').textContent = '？';
    slot.querySelector('.rank-val').style.color = '#bbb';
  });
}

// ===== Reveal (発表・親が順位カードをめくる) =====
let revealRound = null;   // 構造を組み直すべきラウンドの判定用
let flipSent = [];        // 送信済みのめくり（往復待ちの二度押し防止）
let revealJustBuilt = false;

function renderReveal(v) {
  showScreen('reveal');
  if (revealRound !== v.round) {
    revealRound = v.round;
    flipSent = [];
    buildReveal(v);
    revealJustBuilt = true;   // 途中参加・復帰で既に開いている分は鳴らさない
  }
  updateReveal(v);
  updateReadyUI(v);
  revealJustBuilt = false;
}

// 1ラウンドにつき1回だけ DOM を組む。以降は状態だけ更新して
// カードの transition（めくり演出）が途切れないようにする
function buildReveal(v) {
  const odai = v.odai || {};
  $('#reveal-eyebrow').textContent = `REVEAL ・ 第${v.round}R ・ 親：${v.oyaName}`;
  $('#reveal-question').textContent = odai.q || '';

  const cards = $('#reveal-cards');
  cards.innerHTML = '';
  for (let r = 0; r < 3; r++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flip-card';
    btn.dataset.rank = r;
    btn.innerHTML = `
      <span class="flip-inner">
        <span class="flip-face flip-back">
          <span class="flip-rank-pill">${r+1}位</span>
          <span class="flip-brand">PARTY<br>RACE<br>TICKET</span>
          <span class="barcode">||⦀|||⦀|</span>
        </span>
        <span class="flip-face flip-front"></span>
      </span>
      <span class="flip-hint"></span>`;
    btn.addEventListener('click', () => flipCard(r));
    cards.appendChild(btn);
  }

  const preds = $('#reveal-preds');
  preds.innerHTML = '';
  (v.preds || []).forEach(p => {
    const row = document.createElement('div');
    row.className = 'pred-row';
    row.dataset.id = p.id;
    row.innerHTML = `
      <span class="pred-dot" style="background:${p.color || '#999'}"></span>
      <span class="pred-name">${esc(p.name)}</span>
      <span class="pred-badges">${(p.pred||[]).map(i =>
        `<span class="pred-badge opt-badge ${BADGES[i]}" data-idx="${i}">${LETTERS[i]}<b class="pred-mark"></b></span>`
      ).join('')}</span>`;
    preds.appendChild(row);
  });

  $('#reveal-scores').innerHTML = '';
  $('#reveal-standings').innerHTML = '';
  $('#reveal-preds-section').style.display = '';
  clearList($('#reveal-ready-progress'));
  const pay = $('#reveal-payout');
  pay.innerHTML = '';
  delete pay.dataset.state;
}

function flipCard(rank) {
  if (flipSent.includes(rank)) return;
  flipSent.push(rank);
  sendAction('flip_card', { rank });
  // 通信が落ちた時にカードが永久に固まらないよう、開かなければ再タップを許す
  setTimeout(() => {
    const btn = $(`#reveal-cards .flip-card[data-rank="${rank}"]`);
    if (btn && !btn.classList.contains('open')) flipSent = flipSent.filter(r => r !== rank);
  }, 3000);
}

function updateReveal(v) {
  const odai = v.odai || {};
  const opts = odai.opts || [];
  const flipped = v.flipped || [false,false,false];
  const answer = v.oyaAnswer || [];
  const hits = v.hits || [];
  const openCount = flipped.filter(Boolean).length;
  const canFlip = v.isOya && !v.payoutOpen;

  setText($('#reveal-open-label'), `${openCount} / 3 オープン`);

  // --- 順位カード ---
  $$('#reveal-cards .flip-card').forEach(btn => {
    const r = parseInt(btn.dataset.rank);
    const isOpen = !!flipped[r];
    if (isOpen && !btn.classList.contains('open')) {
      const idx = answer[r];
      const front = btn.querySelector('.flip-front');
      front.innerHTML = `
        <span class="flip-rank">${r+1}位</span>
        <span class="opt-badge flip-badge ${BADGES[idx]}">${LETTERS[idx]}</span>
        <span class="flip-label">${esc(opts[idx] || '')}</span>
        <span class="flip-hits ${hits[r] > 0 ? 'has-hit' : ''}">${hits[r] > 0 ? hits[r]+'人 的中！' : '的中なし'}</span>`;
      btn.classList.add('open');
      if (!revealJustBuilt) {
        Sound.play('flip', r);
        // 面が見えるのは CSS の回転(.55s)の中盤。的中の鳴りをそこに合わせる
        if (hits[r] > 0) setTimeout(() => Sound.play('hit'), 380);
      }
    }
    btn.classList.toggle('can-flip', canFlip && !isOpen);
    btn.disabled = !canFlip || isOpen;
    setText(btn.querySelector('.flip-hint'),
      isOpen ? 'オープン済み' : (canFlip ? 'タップでオープン' : ''));
  });

  // --- 煽り文 ---
  const hype = $('#reveal-hype');
  const who = v.isOya ? 'あなた' : v.oyaName;
  if (v.payoutOpen) {
    setText(hype, '配当オープン！');
  } else if (openCount === 0) {
    setText(hype, `さあ親の${who}、どこから開ける？`);
  } else if (openCount === 2) {
    setText(hype, '残り1枚…ここで役が決まる！');
  } else {
    setText(hype, 'まだまだ、次いこう！');
  }

  // --- めくり待ちの文言（3枚目で配当は自動オープン）---
  const pay = $('#reveal-payout');
  const payState = v.payoutOpen ? 'open' : (v.isOya ? 'flipping' : 'watching');
  if (pay.dataset.state !== payState) {
    pay.dataset.state = payState;
    if (payState === 'open') {
      pay.innerHTML = '';
    } else if (payState === 'flipping') {
      pay.innerHTML = `<p class="payout-wait">3枚めくると配当が出ます</p>`;
    } else {
      pay.innerHTML = `<p class="payout-wait">${esc(v.oyaName)} が順位カードをめくっています…</p>`;
    }
  }

  // --- みんなの予想の ○/△ ---
  const openIdx = answer.filter((x, r) => flipped[r] && x != null);
  $$('#reveal-preds .pred-row').forEach(row => {
    row.querySelectorAll('.pred-badge').forEach((b, j) => {
      const idx = parseInt(b.dataset.idx);
      const exact = flipped[j] && answer[j] === idx;
      const soft  = !exact && openIdx.includes(idx);
      b.classList.toggle('hit-exact', exact);
      b.classList.toggle('hit-soft', soft);
      setText(b.querySelector('.pred-mark'), exact ? '○' : (soft ? '△' : ''));
    });
  });

  // --- 配当（役・点）と現在の順位 ---
  // 3枚目のめくり演出が終わってから出す（同時だと役が先に見えてしまう）
  if (v.payoutOpen && $('#reveal-scores').childElementCount === 0 && (v.roundResults||[]).length) {
    const round = v.round;
    const silent = revealJustBuilt;   // 配当済みの画面に途中から入った時は鳴らさない
    setTimeout(() => {
      if (revealRound !== round || $('#reveal-scores').childElementCount) return;
      renderPayout(v);
      if (silent) return;
      // 自分が高役を当てていたら専用のファンファーレ
      const mine = (v.roundResults || []).find(r => r.id === v.myId);
      Sound.play(mine && (mine.cls === 'sanrentan' || mine.cls === 'sanrenpuku') ? 'bigwin' : 'payout');
    }, 550);
  }
}

function renderPayout(v) {
  const list = $('#reveal-scores');
  v.roundResults.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = `result-row ${r.cls}`;
    row.style.animationDelay = `${i * 0.09}s`;
    row.innerHTML = `
      <span class="r-name">${esc(r.name)}</span>
      <span class="r-picks">${(r.pred||[]).map(i2=>LETTERS[i2]).join('→')}</span>
      <span class="r-yaku">${r.yaku}</span>
      <span class="r-pts">${r.pts>0?'+'+r.pts:'0'}pt</span>
      <span class="r-total">計${r.total}</span>`;
    list.appendChild(row);
  });
  const sorted = [...v.players].sort((a,b) => b.score - a.score);
  $('#reveal-standings').innerHTML = `<div class="standings-title">現在の順位</div><div class="standings-chips">` +
    sorted.map((p, i) => `<span class="standings-chip"><b>${i+1}</b>${esc(p.name)}<em>${p.score}pt</em></span>`).join('') +
    `</div>`;
  // 予想と○△は結果リストに集約されるので、1画面に収まるよう畳む
  $('#reveal-preds-section').style.display = 'none';
}

function updateReadyUI(v) {
  const c = $('#reveal-ready-progress');
  const players = v.players || [];
  // 配当オープン前は「次へ」自体が押せないので進捗も出さない
  if (!v.payoutOpen) { clearList(c); return updateReadyBtn(v); }
  // 名前は組み直さず、済/未の色だけ切り替える
  const sig = players.map(p => p.id + ':' + p.name).join('|');
  if (c.dataset.sig !== sig) {
    c.dataset.sig = sig;
    c.innerHTML = '';
    players.forEach(p => {
      const s = document.createElement('span');
      s.className = 'ready-chip';
      s.textContent = p.name;
      c.appendChild(s);
    });
  }
  players.forEach((p, i) => {
    const chip = c.children[i];
    if (chip) chip.classList.toggle('done', !!(v.readyStatus && v.readyStatus[p.id]));
  });
  updateReadyBtn(v);
}

function updateReadyBtn(v) {
  const btn = $('#btn-ready-next');
  const isLast = v.round >= v.totalRounds; // 最終ラウンドは次のレースが無い
  btn.disabled = !v.payoutOpen || !!v.isReady;
  setText(btn, !v.payoutOpen ? 'カードオープン待ち'
    : v.isReady ? '待機中…'
    : isLast ? '最終結果へ ▶' : '次のレースへ ▶');
}

// ===== Final =====
function renderFinal(v) {
  const sorted = v.finalRanking || [...v.players].sort((a,b)=>b.score-a.score);
  const c = $('#final-ranking');
  // 順位が動かない画面。毎ポーリングで組み直すと名前が点滅してコピーできない
  const sig = sorted.map(p => p.id + ':' + p.name + ':' + p.score).join('|');
  if (c.dataset.sig === sig) return;
  c.dataset.sig = sig;
  c.innerHTML = '';
  sorted.forEach((p,i) => {
    const row = document.createElement('div');
    row.className = 'final-row';
    row.style.animationDelay = `${i*0.12}s`;
    row.innerHTML = `
      <span class="f-rank">${i<3?['1','2','3'][i]:i+1}</span>
      <span class="f-name">${esc(p.name)}</span>
      <span class="f-score">${p.score} <small>pt</small></span>`;
    c.appendChild(row);
  });
  $('#btn-play-again').style.display = v.isHost ? '' : 'none';
  $('#btn-back-lobby').style.display = v.isHost ? '' : 'none';
}

// ===== Boot: 直近セッションがあれば復帰 =====
tryRestore();
