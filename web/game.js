// ===== SANRENTAN -Nelo Edition- Online Multiplayer =====
// PeerJS (WebRTC) でブラウザ間P2P通信。ホストのブラウザがゲームサーバー。

const LETTERS = ['A','B','C','D','E','F','G'];
const BADGES = ['badge-a','badge-b','badge-c','badge-d','badge-e','badge-f','badge-g'];
const P_COLORS = ['#E53935','#1E88E5','#43A047','#FB8C00','#9C27B0','#00897B','#F4511E','#5C6BC0'];
const PEER_PREFIX = 'srt3-';

// ===== State =====
let isHost = false;
let myPeerId = null;
let myName = '';
let roomCode = '';
let peer = null;
let connections = new Map(); // peerId -> {conn, name}
let hostConn = null;        // client's connection to host

// Host-side game state
let gs = {
  phase: 'lobby',  // lobby|topic|oya_select|predicting|results|final
  players: [],     // [{id, name, score, color}]
  round: 0,
  totalRounds: 5,
  oyaIdx: 0,
  odai: null,
  oyaAnswer: [],
  predictions: {},  // {playerId: [a,b,c]}
  submitted: {},    // {playerId: true}
  usedIds: [],
  roundResults: [],
};

// Client-side view (received from host)
let view = {};

// ===== Helpers =====
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  const el = $(`#screen-${id}`);
  if (el) { el.classList.add('active'); window.scrollTo(0, 0); }
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O (confusing)
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// ===== Back buttons =====
$$('.btn-back').forEach(b => b.addEventListener('click', () => {
  cleanup();
  showScreen(b.dataset.to);
}));

function cleanup() {
  if (peer) { peer.destroy(); peer = null; }
  connections.clear();
  hostConn = null;
  isHost = false;
}

// ===== Title =====
$('#btn-go-create').addEventListener('click', () => showScreen('create'));
$('#btn-go-join').addEventListener('click', () => showScreen('join'));

// ===== Create Room =====
$('#btn-create-room').addEventListener('click', () => {
  const name = $('#create-name').value.trim();
  if (!name) { $('#create-status').textContent = '名前を入力してください'; return; }
  myName = name;
  gs.totalRounds = parseInt($('#create-rounds').value);
  createRoom();
});

function createRoom() {
  roomCode = genCode();
  isHost = true;
  $('#create-status').textContent = '接続中...';
  $('#btn-create-room').disabled = true;

  peer = new Peer(PEER_PREFIX + roomCode, { debug: 0 });

  peer.on('open', id => {
    myPeerId = id;
    gs.players = [{ id: myPeerId, name: myName, score: 0, color: P_COLORS[0] }];
    gs.phase = 'lobby';
    showScreen('lobby');
    renderLobby();
    $('#btn-create-room').disabled = false;
    $('#create-status').textContent = '';
  });

  peer.on('connection', conn => {
    conn.on('open', () => {
      // Wait for join message
    });
    conn.on('data', data => handleClientMsg(conn, data));
    conn.on('close', () => removePlayer(conn.peer));
    conn.on('error', () => removePlayer(conn.peer));
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      // Code collision, retry
      roomCode = genCode();
      peer.destroy();
      createRoom();
    } else {
      $('#create-status').textContent = '接続エラー: ' + err.type;
      $('#btn-create-room').disabled = false;
    }
  });
}

// ===== Join Room =====
$('#btn-join-room').addEventListener('click', () => {
  const name = $('#join-name').value.trim();
  const code = $('#join-code').value.trim().toUpperCase();
  if (!name) { $('#join-status').textContent = '名前を入力してください'; return; }
  if (code.length !== 4) { $('#join-status').textContent = '4文字のルームコードを入力してください'; return; }
  myName = name;
  roomCode = code;
  joinRoom();
});

function joinRoom() {
  isHost = false;
  $('#join-status').textContent = '接続中...';
  $('#btn-join-room').disabled = true;

  peer = new Peer(undefined, { debug: 0 });

  peer.on('open', id => {
    myPeerId = id;
    const conn = peer.connect(PEER_PREFIX + roomCode, { reliable: true });

    conn.on('open', () => {
      hostConn = conn;
      conn.send({ type: 'join', name: myName });
      $('#join-status').textContent = '';
      $('#btn-join-room').disabled = false;
    });

    conn.on('data', data => handleHostMsg(data));

    conn.on('close', () => {
      showScreen('error');
      $('#error-message').textContent = 'ホストとの接続が切れました';
    });

    conn.on('error', () => {
      $('#join-status').textContent = 'ルームが見つかりません';
      $('#btn-join-room').disabled = false;
    });
  });

  peer.on('error', err => {
    if (err.type === 'peer-unavailable') {
      $('#join-status').textContent = 'ルームが見つかりません';
    } else {
      $('#join-status').textContent = '接続エラー: ' + err.type;
    }
    $('#btn-join-room').disabled = false;
  });
}

// ===== Host: Handle Client Messages =====
function handleClientMsg(conn, data) {
  if (data.type === 'join') {
    if (gs.phase !== 'lobby') {
      conn.send({ type: 'error', msg: 'ゲーム進行中です' });
      return;
    }
    if (gs.players.length >= 8) {
      conn.send({ type: 'error', msg: '満員です' });
      return;
    }
    const player = {
      id: conn.peer,
      name: data.name,
      score: 0,
      color: P_COLORS[gs.players.length % P_COLORS.length],
    };
    gs.players.push(player);
    connections.set(conn.peer, conn);
    broadcastView();
    renderLobby();
  }
  else if (data.type === 'submit_oya') {
    if (gs.phase === 'oya_select') {
      gs.oyaAnswer = data.answer;
      gs.phase = 'predicting';
      gs.submitted = {};
      broadcastView();
      if (isHost) renderForPhase();
    }
  }
  else if (data.type === 'submit_predict') {
    if (gs.phase === 'predicting') {
      gs.predictions[conn.peer] = data.answer;
      gs.submitted[conn.peer] = true;
      // Check if all non-oya have submitted
      const oya = gs.players[gs.oyaIdx];
      const allDone = gs.players
        .filter(p => p.id !== oya.id)
        .every(p => gs.submitted[p.id]);
      if (allDone) {
        calculateResults();
        gs.phase = 'results';
      }
      broadcastView();
      if (isHost) renderForPhase();
    }
  }
}

function removePlayer(peerId) {
  connections.delete(peerId);
  if (gs.phase === 'lobby') {
    gs.players = gs.players.filter(p => p.id !== peerId);
    broadcastView();
    renderLobby();
  }
  // During game, mark as disconnected but keep in player list
}

// ===== Host: Broadcast =====
function broadcastView() {
  const v = buildView();
  connections.forEach(conn => {
    try { conn.send({ type: 'state', view: v }); } catch(e) {}
  });
  // Also update local host view
  view = v;
}

function buildView() {
  const oya = gs.players[gs.oyaIdx] || {};
  const v = {
    phase: gs.phase,
    players: gs.players.map(p => ({
      id: p.id, name: p.name, score: p.score, color: p.color,
    })),
    round: gs.round,
    totalRounds: gs.totalRounds,
    oyaIdx: gs.oyaIdx,
    oyaId: oya.id,
    oyaName: oya.name,
    roomCode,
  };

  if (gs.phase === 'topic' || gs.phase === 'oya_select' || gs.phase === 'predicting' || gs.phase === 'results') {
    v.odai = gs.odai;
  }
  if (gs.phase === 'predicting') {
    v.submitted = { ...gs.submitted };
  }
  if (gs.phase === 'results' || gs.phase === 'final') {
    v.oyaAnswer = gs.oyaAnswer;
    v.predictions = { ...gs.predictions };
    v.roundResults = gs.roundResults;
  }
  if (gs.phase === 'final') {
    v.finalRanking = [...gs.players].sort((a, b) => b.score - a.score);
  }
  return v;
}

// ===== Client: Handle Host Messages =====
function handleHostMsg(data) {
  if (data.type === 'state') {
    view = data.view;
    renderForPhase();
  }
  else if (data.type === 'error') {
    $('#join-status').textContent = data.msg;
  }
}

// ===== Host: Game Logic =====
$('#btn-start-game').addEventListener('click', () => {
  if (!isHost) return;
  gs.round = 0;
  gs.oyaIdx = 0;
  gs.usedIds = [];
  gs.players.forEach(p => p.score = 0);
  nextRound();
});

function nextRound() {
  gs.round++;
  gs.predictions = {};
  gs.submitted = {};
  gs.oyaAnswer = [];
  gs.roundResults = [];

  const available = ODAI_DATA.filter(o => !gs.usedIds.includes(o.id));
  if (available.length === 0 || gs.round > gs.totalRounds) {
    gs.phase = 'final';
    view = buildView();
    broadcastView();
    renderForPhase();
    return;
  }

  gs.odai = available[Math.floor(Math.random() * available.length)];
  gs.usedIds.push(gs.odai.id);
  gs.phase = 'topic';
  broadcastView();
  renderForPhase();

  // Auto-advance to oya_select after 3s
  setTimeout(() => {
    if (gs.phase === 'topic') {
      gs.phase = 'oya_select';
      broadcastView();
      renderForPhase();
    }
  }, 3500);
}

function calculateResults() {
  const oya = gs.players[gs.oyaIdx];
  gs.roundResults = [];

  gs.players.forEach(p => {
    if (p.id === oya.id) return;
    const pred = gs.predictions[p.id] || [];
    if (pred.length !== 3) {
      gs.roundResults.push({ id: p.id, name: p.name, pred: [], yaku: 'タイムアウト', pts: 0, cls: 'hazure' });
      return;
    }
    const result = calcScore(gs.oyaAnswer, pred);
    p.score += result.pts;
    gs.roundResults.push({ id: p.id, name: p.name, pred, ...result });
  });

  gs.roundResults.sort((a, b) => b.pts - a.pts);
}

function calcScore(oya, pred) {
  const [o1,o2,o3] = oya;
  const [p1,p2,p3] = pred;

  if (p1===o1 && p2===o2 && p3===o3)
    return { yaku:'サンレンタン', pts:6, cls:'sanrentan' };

  const os = new Set(oya), ps = new Set(pred);
  if (pred.every(p => os.has(p)) && oya.every(o => ps.has(o)))
    return { yaku:'サンレンプク', pts:4, cls:'sanrenpuku' };

  if (p1===o1 && p2===o2)
    return { yaku:'ニレンタン', pts:3, cls:'nirentan' };

  if (pred.filter(p => os.has(p)).length >= 2)
    return { yaku:'プクプク', pts:2, cls:'pukupuku' };

  if (p1===o1)
    return { yaku:'タン', pts:1, cls:'tan' };

  return { yaku:'ハズレ', pts:0, cls:'hazure' };
}

$('#btn-next-round').addEventListener('click', () => {
  if (!isHost) return;
  gs.oyaIdx = (gs.oyaIdx + 1) % gs.players.length;
  nextRound();
});

$('#btn-play-again').addEventListener('click', () => {
  if (!isHost) return;
  gs.players.forEach(p => p.score = 0);
  gs.round = 0;
  gs.oyaIdx = 0;
  gs.usedIds = [];
  nextRound();
});

$('#btn-back-title').addEventListener('click', () => {
  cleanup();
  showScreen('title');
});

// ===== Rendering =====
function renderForPhase() {
  const v = view;
  if (!v || !v.phase) return;

  switch (v.phase) {
    case 'lobby': showScreen('lobby'); renderLobby(); break;
    case 'topic': showScreen('topic'); renderTopic(); break;
    case 'oya_select': renderOyaOrWait(); break;
    case 'predicting': renderPredictOrWait(); break;
    case 'results': showScreen('result'); renderResults(); break;
    case 'final': showScreen('final'); renderFinal(); break;
  }
}

// --- Lobby ---
function renderLobby() {
  const players = isHost ? gs.players : (view.players || []);
  const code = isHost ? roomCode : (view.roomCode || roomCode);

  $('#lobby-code').textContent = code;

  const container = $('#lobby-players');
  container.innerHTML = '';
  players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'lobby-player';
    div.innerHTML = `
      <span class="p-dot" style="background:${p.color || P_COLORS[i]}"></span>
      <span>${p.name}</span>
      ${i === 0 ? '<span class="p-host">HOST</span>' : ''}
    `;
    container.appendChild(div);
  });

  if (isHost) {
    $('#lobby-host-controls').style.display = '';
    $('#btn-start-game').disabled = players.length < 2;
    $('#lobby-status').textContent = players.length < 2 ? '2人以上で開始できます' : '準備OK！';
  } else {
    $('#lobby-host-controls').style.display = 'none';
    $('#lobby-status').textContent = 'ホストがゲームを開始するのを待っています...';
  }
}

// --- Topic ---
function renderTopic() {
  const v = isHost ? { ...gs, odai: gs.odai, round: gs.round, totalRounds: gs.totalRounds, oyaName: gs.players[gs.oyaIdx]?.name } : view;
  const odai = v.odai;
  if (!odai) return;

  $('#round-badge').textContent = `第${v.round}R / ${v.totalRounds}`;
  $('#topic-question').textContent = odai.q;

  const opts = $('#topic-options');
  opts.innerHTML = '';
  odai.opts.forEach((o, i) => {
    const d = document.createElement('div');
    d.className = 'topic-opt';
    d.innerHTML = `<span class="opt-badge ${BADGES[i]}">${LETTERS[i]}</span> ${o}`;
    opts.appendChild(d);
  });

  $('#topic-oya-label').textContent = `親: ${v.oyaName || ''}`;
}

// --- Oya Select or Wait ---
function renderOyaOrWait() {
  const v = isHost ? buildView() : view;
  const amOya = v.oyaId === myPeerId;

  if (amOya) {
    showScreen('select');
    setupSelection('oya', v);
  } else {
    showScreen('wait');
    $('#wait-title').textContent = `${v.oyaName}が選択中...`;
    $('#wait-message').textContent = '親が自分のTop3を選んでいます';
    $('#wait-progress').innerHTML = '';
  }
}

// --- Predict or Wait ---
function renderPredictOrWait() {
  const v = isHost ? buildView() : view;
  const amOya = v.oyaId === myPeerId;
  const alreadySubmitted = v.submitted && v.submitted[myPeerId];

  if (amOya || alreadySubmitted) {
    showScreen('wait');
    $('#wait-title').textContent = amOya ? 'みんなが予想中...' : '提出済み！';
    $('#wait-message').textContent = '全員の予想を待っています';
    renderWaitProgress(v);
  } else {
    showScreen('select');
    setupSelection('predict', v);
  }
}

function renderWaitProgress(v) {
  const prog = $('#wait-progress');
  prog.innerHTML = '';
  const oya = v.players[v.oyaIdx];
  v.players.forEach(p => {
    if (p.id === oya.id) return;
    const done = v.submitted && v.submitted[p.id];
    const d = document.createElement('div');
    d.className = 'wait-player';
    d.innerHTML = `<span class="status-dot ${done?'done':'pending'}"></span> ${p.name} ${done?'提出済み':'...'}`;
    prog.appendChild(d);
  });
}

// --- Selection (shared for oya + predict) ---
let selPicks = [];

function setupSelection(mode, v) {
  selPicks = [];
  const odai = v.odai;

  if (mode === 'oya') {
    $('#select-title').textContent = '自分のTop3を選ぼう';
    $('#select-hint').textContent = '1位〜3位の順に選んでください';
  } else {
    const oyaName = v.oyaName || v.players[v.oyaIdx]?.name || '親';
    $('#select-title').textContent = `${oyaName}のTop3を予想！`;
    $('#select-hint').textContent = '1位〜3位の順に予想してください';
  }

  $('#select-question').textContent = odai.q;
  resetRankSlots();
  buildChoices(odai);
  $('#btn-select-undo').disabled = true;
  $('#btn-select-confirm').disabled = true;

  // Rebind confirm handler
  const confirmBtn = $('#btn-select-confirm');
  const newBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
  newBtn.addEventListener('click', () => {
    if (selPicks.length !== 3) return;
    if (isHost) {
      if (mode === 'oya') {
        gs.oyaAnswer = [...selPicks];
        gs.phase = 'predicting';
        gs.submitted = {};
        // If host is not oya, this shouldn't happen, but just in case
        broadcastView();
        renderForPhase();
      } else {
        gs.predictions[myPeerId] = [...selPicks];
        gs.submitted[myPeerId] = true;
        const oya = gs.players[gs.oyaIdx];
        const allDone = gs.players.filter(p => p.id !== oya.id).every(p => gs.submitted[p.id]);
        if (allDone) {
          calculateResults();
          gs.phase = 'results';
        }
        broadcastView();
        renderForPhase();
      }
    } else {
      hostConn.send({ type: mode === 'oya' ? 'submit_oya' : 'submit_predict', answer: [...selPicks] });
      // Show waiting screen
      showScreen('wait');
      $('#wait-title').textContent = '提出済み！';
      $('#wait-message').textContent = '他のプレイヤーを待っています...';
    }
  });
}

function buildChoices(odai) {
  const container = $('#select-choices');
  container.innerHTML = '';
  odai.opts.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.dataset.idx = i;
    btn.innerHTML = `<span class="opt-badge ${BADGES[i]}">${LETTERS[i]}</span> ${opt}`;
    btn.addEventListener('click', () => pickChoice(i, odai));
    container.appendChild(btn);
  });
}

function pickChoice(idx, odai) {
  if (selPicks.length >= 3 || selPicks.includes(idx)) return;
  selPicks.push(idx);
  updateSelectionUI(odai);
}

$('#btn-select-undo').addEventListener('click', () => {
  selPicks.pop();
  const odai = view.odai || gs.odai;
  updateSelectionUI(odai);
});

function updateSelectionUI(odai) {
  // Update rank slots
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

  // Mark used choices
  $$('#select-choices .choice-btn').forEach(btn => {
    btn.classList.toggle('used', selPicks.includes(parseInt(btn.dataset.idx)));
  });

  $('#btn-select-undo').disabled = selPicks.length === 0;
  const confirmBtn = $('[id="btn-select-confirm"]') || $$('.action-row .btn-primary.compact')[0];
  if (confirmBtn) confirmBtn.disabled = selPicks.length !== 3;
}

function resetRankSlots() {
  $$('#select-ranks .rank-slot').forEach(slot => {
    slot.classList.remove('filled');
    const val = slot.querySelector('.rank-val');
    val.textContent = '？';
    val.style.color = '#bbb';
  });
}

// --- Results ---
function renderResults() {
  const v = isHost ? buildView() : view;
  const odai = v.odai;

  // Oya's answer
  const oyaBox = $('#result-oya-answer');
  oyaBox.innerHTML = `
    <div class="oya-answer-title">${v.players[v.oyaIdx]?.name || ''} の答え</div>
    <div class="oya-ranks">
      ${(v.oyaAnswer||[]).map((idx, r) => `
        <div class="oya-rank-chip">
          <span class="r-label">${r+1}位</span>
          <span class="r-val"><span class="opt-badge ${BADGES[idx]}" style="width:1.2rem;height:1.2rem;font-size:.6rem">${LETTERS[idx]}</span> ${odai.opts[idx]}</span>
        </div>
      `).join('')}
    </div>
  `;

  // Results
  const list = $('#result-scores');
  list.innerHTML = '';
  (v.roundResults || []).forEach((r, i) => {
    const row = document.createElement('div');
    row.className = `result-row ${r.cls}`;
    row.style.animationDelay = `${i * 0.1}s`;
    row.innerHTML = `
      <span class="r-name">${r.name}</span>
      <span class="r-yaku">${r.yaku}</span>
      <span class="r-picks">${(r.pred||[]).map(i=>LETTERS[i]).join('→')}</span>
      <span class="r-pts">${r.pts > 0 ? '+'+r.pts : '0'}pt</span>
    `;
    list.appendChild(row);
  });

  // Standings
  const standings = $('#result-standings');
  const sorted = [...v.players].sort((a,b) => b.score - a.score);
  standings.innerHTML = `<div class="standings-title">現在の順位</div>` +
    sorted.map(p => `<div class="standings-row"><span class="s-name">${p.name}</span><span class="s-score">${p.score}pt</span></div>`).join('');

  // Next round button (host only)
  const btn = $('#btn-next-round');
  btn.style.display = isHost ? '' : 'none';
}

// --- Final ---
function renderFinal() {
  const v = isHost ? buildView() : view;
  const sorted = v.finalRanking || [...v.players].sort((a,b) => b.score - a.score);
  const medals = ['1','2','3'];

  const container = $('#final-ranking');
  container.innerHTML = '';
  sorted.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'final-row';
    row.style.animationDelay = `${i * 0.12}s`;
    row.innerHTML = `
      <span class="f-rank">${i < 3 ? medals[i] : i+1}</span>
      <span class="f-name">${p.name}</span>
      <span class="f-score">${p.score} <small>pt</small></span>
    `;
    container.appendChild(row);
  });

  // Only host can restart
  $('#btn-play-again').style.display = isHost ? '' : 'none';
}
