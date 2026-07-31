// ===== SANRENTAN -Nelo Edition- Online (Server-Based) =====

const LETTERS = ['A','B','C','D','E','F','G'];
const BADGES  = ['badge-a','badge-b','badge-c','badge-d','badge-e','badge-f','badge-g'];
const API     = '/api/game';
const POLL_MS = 1000;
const DRAW_TOTAL_MS = 45000; // サーバー DRAW_TIMEOUT と一致

// ===== State =====
let myPlayerId = null;
let roomCode   = null;
let pollTimer  = null;
let lastPhase  = null;
let selPicks   = [];
let selMode    = null; // 'oya' | 'predict' | null
let selOdai    = null;
let lastCandidateId = null;

// Timer
let clockOffset  = 0;      // serverNow - clientNow
let timerDeadline = null;
let timerTotalMs = 0;
let timerTicker  = null;

// ===== Helpers =====
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function esc(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  const el = $(`#screen-${id}`);
  if (el) { el.classList.add('active'); window.scrollTo(0,0); }
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
    timerTotalMs = v.phase === 'draw' ? DRAW_TOTAL_MS
      : v.phase === 'answer' ? (v.answerSeconds || 120) * 1000
      : (v.revealSeconds || 60) * 1000;
    $('#global-timer').style.display = 'block';
    if (!timerTicker) timerTicker = setInterval(tickTimer, 250);
    tickTimer();
  } else {
    timerDeadline = null;
    $('#global-timer').style.display = 'none';
  }
}
function tickTimer() {
  if (!timerDeadline) return;
  const remain = timerDeadline - (Date.now() + clockOffset);
  const secs = Math.max(0, Math.ceil(remain / 1000));
  const pct = Math.max(0, Math.min(100, (remain / timerTotalMs) * 100));
  $('#global-timer-text').textContent = `残り ${secs} 秒`;
  const fill = $('#global-timer-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('danger', secs <= 10);
}

// ===== Navigation =====
$$('.btn-back').forEach(b => b.addEventListener('click', () => {
  stopPolling();
  myPlayerId = null; roomCode = null;
  updateTimer({});
  showScreen(b.dataset.to);
}));
$('#btn-go-create').addEventListener('click', () => showScreen('create'));
$('#btn-go-join').addEventListener('click', () => showScreen('join'));
$('#btn-back-title').addEventListener('click', () => {
  stopPolling(); myPlayerId = null; roomCode = null;
  updateTimer({});
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
  $('#lobby-code').textContent = v.roomCode;
  $('#lobby-rules').textContent = `回答 ${v.answerSeconds}秒 / 発表 ${v.revealSeconds}秒 ・ 全${v.totalRounds}R`;
  const c = $('#lobby-players');
  c.innerHTML = '';
  v.players.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'lobby-player';
    d.innerHTML = `<span class="p-dot" style="background:${p.color}"></span><span>${esc(p.name)}</span>${i===0?'<span class="p-host">HOST</span>':''}`;
    c.appendChild(d);
  });
  if (v.isHost) {
    $('#lobby-host-controls').style.display = '';
    $('#btn-start-game').disabled = v.players.length < 2;
    $('#lobby-status').textContent = v.players.length < 2 ? '2人以上で開始できます' : '準備OK！';
    $('#lobby-status').style.color = '';
  } else {
    $('#lobby-host-controls').style.display = 'none';
    $('#lobby-status').textContent = 'ホストの開始を待っています...';
    $('#lobby-status').style.color = '#888';
  }
}

// ===== Draw (お題発表・親主導) =====
function renderDraw(v) {
  if (v.isOya) {
    showScreen('draw');
    $('#draw-round-badge').textContent = `第${v.round}R / ${v.totalRounds}`;
    if (lastPhase !== 'draw') lastCandidateId = null;
    const odai = v.odai;
    if (odai && odai.id !== lastCandidateId) {
      lastCandidateId = odai.id;
      playDrawReveal(odai);
    }
  } else {
    showScreen('wait');
    $('#wait-title').textContent = `${v.oyaName} がお題を選択中`;
    $('#wait-message').textContent = '親が山札からお題を引いています…';
    $('#wait-progress').innerHTML = '';
    lastCandidateId = null;
  }
}
function playDrawReveal(odai) {
  const deck = $('#draw-deck'), cand = $('#draw-candidate'), ctrl = $('#draw-controls');
  deck.style.display = ''; cand.style.display = 'none'; ctrl.style.display = 'none';
  deck.classList.remove('shuffling'); void deck.offsetWidth; deck.classList.add('shuffling');
  setTimeout(() => {
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
    $('#wait-title').textContent = '提出済み！';
    $('#wait-message').textContent = '全員の回答を待っています';
    renderSubmitProgress(v);
    return;
  }
  if (lastPhase !== 'answer' || selMode === null) {
    selPicks = []; selMode = v.isOya ? 'oya' : 'predict'; selOdai = v.odai;
    showScreen('select');
    setupSelectUI(v);
  }
}

function renderSubmitProgress(v) {
  const c = $('#wait-progress');
  c.innerHTML = '';
  if (!v.submittedStatus) return;
  v.players.forEach(p => {
    const done = v.submittedStatus[p.id];
    const isOya = p.id === v.oyaId;
    const d = document.createElement('div');
    d.className = 'wait-player';
    d.innerHTML = `<span class="status-dot ${done?'done':'pending'}"></span> ${esc(p.name)}${isOya?'（親）':''} ${done?'OK':'…'}`;
    c.appendChild(d);
  });
}

// ===== Selection UI =====
function setupSelectUI(v) {
  const odai = v.odai;
  selPicks = [];
  if (selMode === 'oya') {
    $('#select-title').textContent = '自分のTop3を選ぼう';
    $('#select-hint').textContent = '1位〜3位の順に選んでください（あなたの本当の順位）';
  } else {
    $('#select-title').textContent = `${v.oyaName} のTop3を予想！`;
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
  selPicks.push(idx);
  refreshSelUI();
}

$('#btn-undo').addEventListener('click', () => {
  selPicks.pop();
  refreshSelUI();
});

$('#btn-confirm').addEventListener('click', () => {
  if (selPicks.length !== 3) return;
  sendAction('submit_answer', { answer: [...selPicks] });
  showScreen('wait');
  $('#wait-title').textContent = '提出済み！';
  $('#wait-message').textContent = '全員の回答を待っています…';
  $('#wait-progress').innerHTML = '';
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

// ===== Reveal (発表・演出) =====
function renderReveal(v) {
  showScreen('reveal');
  if (lastPhase !== 'reveal') playReveal(v);
  updateReadyUI(v);
}

function playReveal(v) {
  const odai = v.odai || {};
  // 親の答え（最初は隠す）
  const box = $('#reveal-oya-answer');
  box.style.display = 'none';
  box.innerHTML = `
    <div class="oya-answer-title">${esc(v.oyaName)} の答え</div>
    <div class="oya-ranks">
      ${(v.oyaAnswer||[]).map((idx,r) => `
        <div class="oya-rank-chip">
          <span class="r-label">${r+1}位</span>
          <span class="r-val"><span class="opt-badge ${BADGES[idx]}" style="width:1.2rem;height:1.2rem;font-size:.6rem">${LETTERS[idx]}</span> ${esc((odai.opts||[])[idx])}</span>
        </div>
      `).join('')}
    </div>`;

  // 予想者の手を一斉公開（役・点はまだ隠す）
  const list = $('#reveal-scores');
  list.innerHTML = '';
  (v.roundResults||[]).forEach(r => {
    const row = document.createElement('div');
    row.className = 'result-row pending-reveal';
    row.dataset.cls = r.cls;
    row.innerHTML = `
      <span class="r-name">${esc(r.name)}</span>
      <span class="r-picks">${(r.pred||[]).map(i=>LETTERS[i]).join('→')}</span>
      <span class="r-yaku reveal-hide">${r.yaku}</span>
      <span class="r-pts reveal-hide">${r.pts>0?'+'+r.pts:'0'}pt</span>
      <span class="r-total reveal-hide">計${r.total}</span>`;
    list.appendChild(row);
  });

  const st = $('#reveal-standings');
  st.innerHTML = '';

  // 段階演出: 予想公開 → 親の答え → 役/点を一斉
  setTimeout(() => { box.style.display = ''; box.classList.add('pop'); }, 1400);
  setTimeout(() => {
    $$('#reveal-scores .result-row').forEach(row => {
      row.classList.remove('pending-reveal');
      if (row.dataset.cls) row.classList.add(row.dataset.cls);
      row.querySelectorAll('.reveal-hide').forEach(el => el.classList.remove('reveal-hide'));
    });
    const sorted = [...v.players].sort((a,b) => b.score - a.score);
    st.innerHTML = `<div class="standings-title">現在の順位</div>` +
      sorted.map(p => `<div class="standings-row"><span class="s-name">${esc(p.name)}</span><span class="s-score">${p.score}pt</span></div>`).join('');
  }, 2800);
}

function updateReadyUI(v) {
  const c = $('#reveal-ready-progress');
  c.innerHTML = '';
  (v.players||[]).forEach(p => {
    const done = v.readyStatus && v.readyStatus[p.id];
    const d = document.createElement('div');
    d.className = 'wait-player';
    d.innerHTML = `<span class="status-dot ${done?'done':'pending'}"></span> ${esc(p.name)} ${done?'OK':'…'}`;
    c.appendChild(d);
  });
  const btn = $('#btn-ready-next');
  btn.disabled = !!v.isReady;
  btn.textContent = v.isReady ? '待機中…' : '次へ ▶';
}

// ===== Final =====
function renderFinal(v) {
  const sorted = v.finalRanking || [...v.players].sort((a,b)=>b.score-a.score);
  const c = $('#final-ranking');
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
