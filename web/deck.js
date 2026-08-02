// ===== お題リスト（デッキ）作成画面 =====
// 既定リスト（初期は全部入り。要らないものを外す）＋ 自作お題 を1つにまとめ、
// 6文字のコードで共有する。

const API = '/api/deck';
const LETTERS = ['A','B','C','D','E','F','G'];
const BADGES = ['badge-a','badge-b','badge-c','badge-d','badge-e','badge-f','badge-g'];
const OPT_MAX = 7;
const MIN_ITEMS = 3;

const $ = s => document.querySelector(s);
const esc = str => String(str).replace(/[&<>"']/g, c => (
  { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
));
// コードは英数字4〜8文字。ルーム側と同じ書式
const CODE_HINT = 'コードは英数字4〜8文字にしてください';
function normCode(input) {
  const c = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (c.length >= 4 && c.length <= 8) ? c : null;
}

let defaults = [];          // 既定リスト（初期状態は全部入り）
let excluded = new Set();   // そこから外した id
let mine = [];              // 自作お題 {q, opts}
let editingIdx = null;      // 自作お題の編集中インデックス
let deckCode = '';          // 読み込み/保存済みのコード（あれば更新扱い）

// ===== 共通 =====
async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '通信エラーが発生しました');
  return data;
}
function msg(el, text, ok) {
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}
const optsLine = opts => opts.map((t, i) => `${LETTERS[i]} ${esc(t)}`).join(' ・ ');

// ===== 既定リスト =====
// 全部入りが初期状態。要らないものを「外す」で除いていく
const matches = (o, kw) => !kw || (o.q + ' ' + o.opts.join(' ')).toLowerCase().includes(kw);
const keyword = () => $('#search').value.trim().toLowerCase();

function renderPicks() {
  const kw = keyword();
  const shown = defaults.filter(o => matches(o, kw));
  const box = $('#picks');
  if (!shown.length) {
    box.innerHTML = '<p class="empty-note">該当するお題がありません</p>';
    return;
  }
  box.innerHTML = shown.map(o => {
    const off = excluded.has(o.id);
    return `
    <div class="pick ${off ? 'off' : ''}">
      <span class="pick-body">
        <span class="pick-q">${esc(o.q)}</span>
        <span class="pick-o">${optsLine(o.opts)}</span>
      </span>
      <button type="button" class="pick-btn" data-toggle="${o.id}">${off ? '戻す' : '外す'}</button>
    </div>`;
  }).join('');
}
$('#picks').addEventListener('click', e => {
  const btn = e.target.closest('[data-toggle]');
  if (!btn) return;
  const id = Number(btn.dataset.toggle);
  if (excluded.has(id)) excluded.delete(id); else excluded.add(id);
  renderPicks(); paintCount();
});
$('#search').addEventListener('input', renderPicks);
// 絞り込み中は表示されているものだけをまとめて外す
$('#btn-none').addEventListener('click', () => {
  const kw = keyword();
  defaults.filter(o => matches(o, kw)).forEach(o => excluded.add(o.id));
  renderPicks(); paintCount();
});
$('#btn-all').addEventListener('click', () => { excluded.clear(); renderPicks(); paintCount(); });

// ===== 自作お題 =====
function buildOptInputs() {
  const g = $('#opt-grid');
  g.innerHTML = '';
  for (let i = 0; i < OPT_MAX; i++) {
    const row = document.createElement('label');
    row.className = 'opt-field';
    row.innerHTML = `<span class="opt-badge ${BADGES[i]}">${LETTERS[i]}</span>` +
      `<input type="text" class="input-field" maxlength="20" placeholder="選択肢${i + 1}">`;
    g.appendChild(row);
  }
}
function renderMine() {
  const box = $('#mine');
  if (!mine.length) {
    box.innerHTML = '<p class="empty-note">まだありません。下のフォームから追加できます。</p>';
    return;
  }
  box.innerHTML = mine.map((o, i) => `
    <div class="mine-row">
      <span class="mine-body">
        <span class="mine-q">${esc(o.q)}</span>
        <span class="mine-o">${optsLine(o.opts)}</span>
      </span>
      <span class="mine-acts">
        <button type="button" data-edit="${i}">編集</button>
        <button type="button" class="danger" data-del="${i}">削除</button>
      </span>
    </div>`).join('');
}
$('#mine').addEventListener('click', e => {
  const ed = e.target.closest('[data-edit]');
  if (ed) return startEdit(Number(ed.dataset.edit));
  const del = e.target.closest('[data-del]');
  if (!del) return;
  const i = Number(del.dataset.del);
  mine.splice(i, 1);
  if (editingIdx === i) resetForm();
  else if (editingIdx !== null && editingIdx > i) editingIdx--;
  renderMine(); paintCount();
});
function startEdit(i) {
  const item = mine[i];
  if (!item) return;
  editingIdx = i;
  $('#f-q').value = item.q;
  [...document.querySelectorAll('#opt-grid input')].forEach((inp, n) => {
    inp.value = item.opts[n] || '';
  });
  $('#btn-add').textContent = 'このお題を更新';
  $('#btn-add-cancel').style.display = '';
  msg($('#form-msg'), '');
  $('#f-q').focus();
}
function resetForm() {
  editingIdx = null;
  $('#f-q').value = '';
  [...document.querySelectorAll('#opt-grid input')].forEach(i => { i.value = ''; });
  $('#btn-add').textContent = 'このお題を追加';
  $('#btn-add-cancel').style.display = 'none';
}
$('#btn-add-cancel').addEventListener('click', () => { resetForm(); msg($('#form-msg'), ''); });
$('#btn-add').addEventListener('click', () => {
  const q = $('#f-q').value.trim();
  const opts = [...document.querySelectorAll('#opt-grid input')].map(i => i.value.trim()).filter(Boolean);
  // 保存時にサーバーでも弾かれるが、その場で気づけるようここでも見る
  if (!q) return msg($('#form-msg'), 'お題を入力してください');
  if (opts.length < 3) return msg($('#form-msg'), '選択肢は3つ以上必要です');
  if (new Set(opts).size !== opts.length) return msg($('#form-msg'), '同じ選択肢が重複しています');

  if (editingIdx === null) mine.push({ q, opts });
  else mine[editingIdx] = { q, opts };
  const wasEditing = editingIdx !== null;
  resetForm();
  renderMine(); paintCount();
  msg($('#form-msg'), wasEditing ? '更新しました' : '追加しました', true);
});

// ===== 保存 =====
function collect() {
  // 既定リストは元の並び順のまま、そのあとに自作お題
  return defaults.filter(o => !excluded.has(o.id)).map(o => ({ q: o.q, opts: o.opts }))
    .concat(mine.map(o => ({ q: o.q, opts: o.opts })));
}
function paintCount() {
  const n = collect().length;
  const own = mine.length ? `（うち自作 ${mine.length} 件）` : '';
  $('#save-count').textContent = n < MIN_ITEMS
    ? `あと ${MIN_ITEMS - n} 件でお題リストを保存できます（現在 ${n} 件）`
    : `お題 ${n} 件${own}`;
  $('#btn-save').disabled = n < MIN_ITEMS;
}
function showCode(code) {
  deckCode = code;
  $('#code-val').textContent = code;
  $('#code-out').classList.add('on');
  $('#load-code').value = code;
  $('#btn-save').textContent = 'このリストを更新する';
  // 同じタブで戻るので、コードを持たせてルーム作成画面に入力済みの状態にする
  const use = $('#btn-use');
  use.href = '/?deck=' + encodeURIComponent(code);
  use.style.display = '';
}
$('#btn-save').addEventListener('click', async () => {
  // 入力欄のコードを優先する（自分で決めたコードで保存できる）
  const typed = $('#load-code').value.trim();
  if (typed && !normCode(typed)) return msg($('#load-msg'), CODE_HINT);
  $('#btn-save').disabled = true;
  try {
    const deck = await call('POST', '', {
      // 欄が空なら新しいコードで登録する（＝入力欄の中身が保存先）
      code: normCode(typed) || undefined,
      name: $('#deck-name').value,
      odai: collect(),
    });
    showCode(deck.code);
    msg($('#load-msg'), `保存しました（${deck.odai.length}件）。このコードをルーム作成画面で入力してください。`, true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    msg($('#load-msg'), e.message);
  }
  paintCount();
});

// コードをタップでコピー
$('#code-out').addEventListener('click', async () => {
  const hint = $('#code-hint');
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(deckCode);
      ok = true;
    }
  } catch (e) {}
  hint.textContent = ok ? 'コピーしました！' : 'コードを長押しでコピーしてください';
  hint.classList.toggle('done', ok);
  setTimeout(() => { hint.textContent = 'タップでコピー'; hint.classList.remove('done'); }, 2000);
});

// ===== 読み込み =====
$('#btn-load').addEventListener('click', async () => {
  const code = normCode($('#load-code').value);
  if (!code) return msg($('#load-msg'), CODE_HINT);
  try {
    const deck = await call('GET', '?code=' + encodeURIComponent(code));
    $('#deck-name').value = deck.name || '';
    // 既定リストと中身が同じものは残し、含まれていないものは「外した」状態にする。
    // 既定に無いお題は自作枠へ回す
    const key = o => o.q + ' ' + o.opts.join('');
    const byKey = new Map(defaults.map(o => [key(o), o.id]));
    const kept = new Set();
    mine = [];
    deck.odai.forEach(o => {
      const hit = byKey.get(key(o));
      if (hit) kept.add(hit); else mine.push({ q: o.q, opts: o.opts });
    });
    excluded = new Set(defaults.filter(o => !kept.has(o.id)).map(o => o.id));
    showCode(deck.code);
    resetForm();
    renderPicks(); renderMine(); paintCount();
    msg($('#load-msg'), `「${deck.name}」を読み込みました（${deck.odai.length}件）`, true);
  } catch (e) {
    msg($('#load-msg'), e.message);
  }
});

// ===== 起動 =====
buildOptInputs();
renderMine();
paintCount();
call('GET', '?defaults=1')
  // 既定リストが届いた時点で全部入りになるので、件数と保存可否も引き直す
  .then(d => { defaults = d.odai || []; renderPicks(); paintCount(); })
  .catch(e => { $('#picks').innerHTML = `<p class="empty-note">${esc(e.message)}</p>`; });

// ?code=XXXXXX で開かれたら自動で読み込む
const preset = new URLSearchParams(location.search).get('code');
if (preset) {
  $('#load-code').value = preset.toUpperCase();
  // 既定リストが揃ってから照合したいので、取得完了を待つ
  setTimeout(() => $('#btn-load').click(), 300);
}
