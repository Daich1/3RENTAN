// ===== SANRENTAN -Nelo Edition- Online (Server-Based) =====

const LETTERS = ['A','B','C','D','E','F','G'];
const BADGES  = ['badge-a','badge-b','badge-c','badge-d','badge-e','badge-f','badge-g'];
const API     = '/api/game';
const POLL_MS = 1000;

// ===== State =====
let myPlayerId = null;
let roomCode   = null;
let pollTimer  = null;
let lastPhase  = null;
let selPicks   = [];
let selMode    = null; // 'oya' | 'predict'
let selOdai    = null;

// ===== Helpers =====
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
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
  poll(); // immediate first
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

// ===== Navigation =====
$$('.btn-back').forEach(b => b.addEventListener('click', () => {
  stopPolling();
  myPlayerId = null; roomCode = null;
  showScreen(b.dataset.to);
}));
$('#btn-go-create').addEventListener('click', () => showScreen('create'));
$('#btn-go-join').addEventListener('click', () => showScreen('join'));
$('#btn-back-title').addEventListener('click', () => {
  stopPolling(); myPlayerId = null; roomCode = null;
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
    const data = await apiPost({ action: 'create', name, rounds });
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
  } catch (e) {
    console.error('Action failed:', e.message);
  }
}

// ===== Game Controls =====
$('#btn-start-game').addEventListener('click', () => sendAction('start'));
$('#btn-next-round').addEventListener('click', () => sendAction('next_round'));
$('#btn-play-again').addEventListener('click', () => sendAction('play_again'));
$('#btn-back-lobby').addEventListener('click', () => sendAction('back_to_lobby'));

// ===== Render Dispatcher =====
function renderView(v) {
  switch (v.phase) {
    case 'lobby':      showScreen('lobby');  renderLobby(v);          break;
    case 'topic':      showScreen('topic');  renderTopic(v);          break;
    case 'oya_select': renderOyaPhase(v);                             break;
    case 'predicting': renderPredictPhase(v);                         break;
    case 'results':    showScreen('result'); renderResults(v);        break;
    case 'final':      showScreen('final');  renderFinal(v);          break;
  }
  lastPhase = v.phase;
}

// ===== Lobby =====
function renderLobby(v) {
  $('#lobby-code').textContent = v.roomCode;
  const c = $('#lobby-players');
  c.innerHTML = '';
  v.players.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'lobby-player';
    d.innerHTML = `<span class="p-dot" style="background:${p.color}"></span><span>${p.name}</span>${i===0?'<span class="p-host">HOST</span>':''}`;
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

// ===== Topic =====
function renderTopic(v) {
  const odai = v.odai;
  if (!odai) return;
  $('#round-badge').textContent = `第${v.round}R / ${v.totalRounds}`;
  $('#topic-question').textContent = odai.q;
  const c = $('#topic-options');
  c.innerHTML = '';
  odai.opts.forEach((o, i) => {
    const d = document.createElement('div');
    d.className = 'topic-opt';
    d.innerHTML = `<span class="opt-badge ${BADGES[i]}">${LETTERS[i]}</span> ${o}`;
    c.appendChild(d);
  });
  $('#topic-oya-label').textContent = `親: ${v.oyaName}`;
}

// ===== Oya Phase =====
function renderOyaPhase(v) {
  if (v.isOya) {
    // Only reset selection UI on phase change
    if (lastPhase !== 'oya_select') {
      selPicks = []; selMode = 'oya'; selOdai = v.odai;
      showScreen('select');
      setupSelectUI(v);
    }
  } else {
    showScreen('wait');
    $('#wait-title').textContent = `${v.oyaName} が選択中...`;
    $('#wait-message').textContent = '親が自分のTop3を選んでいます';
    $('#wait-progress').innerHTML = '';
  }
}

// ===== Predict Phase =====
function renderPredictPhase(v) {
  if (v.isOya) {
    showScreen('wait');
    $('#wait-title').textContent = 'みんなが予想中...';
    $('#wait-message').textContent = '';
    renderSubmitProgress(v);
  } else if (v.hasSubmitted) {
    showScreen('wait');
    $('#wait-title').textContent = '提出済み！';
    $('#wait-message').textContent = '他のプレイヤーを待っています';
    renderSubmitProgress(v);
  } else {
    if (lastPhase !== 'predicting' || selMode !== 'predict') {
      selPicks = []; selMode = 'predict'; selOdai = v.odai;
      showScreen('select');
      setupSelectUI(v);
    }
  }
}

function renderSubmitProgress(v) {
  const c = $('#wait-progress');
  c.innerHTML = '';
  if (!v.submittedStatus) return;
  v.players.forEach(p => {
    if (p.id === v.oyaId) return;
    const done = v.submittedStatus[p.id];
    const d = document.createElement('div');
    d.className = 'wait-player';
    d.innerHTML = `<span class="status-dot ${done?'done':'pending'}"></span> ${p.name} ${done?'OK':'...'}`;
    c.appendChild(d);
  });
}

// ===== Selection UI =====
function setupSelectUI(v) {
  const odai = v.odai;
  selPicks = [];
  if (selMode === 'oya') {
    $('#select-title').textContent = '自分のTop3を選ぼう';
    $('#select-hint').textContent = '1位〜3位の順に選んでください';
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
    btn.innerHTML = `<span class="opt-badge ${BADGES[i]}">${LETTERS[i]}</span> ${opt}`;
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
  const action = selMode === 'oya' ? 'submit_oya' : 'submit_predict';
  sendAction(action, { answer: [...selPicks] });
  // Show waiting immediately
  showScreen('wait');
  $('#wait-title').textContent = '提出済み！';
  $('#wait-message').textContent = '結果を待っています...';
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

// ===== Results =====
function renderResults(v) {
  const odai = v.odai;
  // Oya answer
  const box = $('#result-oya-answer');
  box.innerHTML = `
    <div class="oya-answer-title">${v.oyaName} の答え</div>
    <div class="oya-ranks">
      ${(v.oyaAnswer||[]).map((idx,r) => `
        <div class="oya-rank-chip">
          <span class="r-label">${r+1}位</span>
          <span class="r-val"><span class="opt-badge ${BADGES[idx]}" style="width:1.2rem;height:1.2rem;font-size:.6rem">${LETTERS[idx]}</span> ${odai.opts[idx]}</span>
        </div>
      `).join('')}
    </div>
  `;
  // Scores
  const list = $('#result-scores');
  list.innerHTML = '';
  (v.roundResults||[]).forEach((r,i) => {
    const row = document.createElement('div');
    row.className = `result-row ${r.cls}`;
    row.style.animationDelay = `${i*0.1}s`;
    row.innerHTML = `
      <span class="r-name">${r.name}</span>
      <span class="r-yaku">${r.yaku}</span>
      <span class="r-picks">${(r.pred||[]).map(i=>LETTERS[i]).join('→')}</span>
      <span class="r-pts">${r.pts>0?'+'+r.pts:'0'}pt</span>
    `;
    list.appendChild(row);
  });
  // Standings
  const st = $('#result-standings');
  const sorted = [...v.players].sort((a,b) => b.score - a.score);
  st.innerHTML = `<div class="standings-title">現在の順位</div>` +
    sorted.map(p => `<div class="standings-row"><span class="s-name">${p.name}</span><span class="s-score">${p.score}pt</span></div>`).join('');
  $('#btn-next-round').style.display = v.isHost ? '' : 'none';
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
      <span class="f-name">${p.name}</span>
      <span class="f-score">${p.score} <small>pt</small></span>
    `;
    c.appendChild(row);
  });
  $('#btn-play-again').style.display = v.isHost ? '' : 'none';
  $('#btn-back-lobby').style.display = v.isHost ? '' : 'none';
}
