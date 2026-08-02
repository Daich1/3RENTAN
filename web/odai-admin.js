// ===== お題管理画面 =====
// ゲーム本体からは一切リンクしていない（URL直打ち専用）。
// api/odai.js に管理パスワードが設定されている場合だけ入力を求める。

const API = '/api/odai';
const TOKEN_KEY = 'srt_admin_token';
const LETTERS = ['A','B','C','D','E','F','G'];
const BADGES = ['badge-a','badge-b','badge-c','badge-d','badge-e','badge-f','badge-g'];
const OPT_MAX = 7;

const $ = s => document.querySelector(s);
const esc = str => String(str).replace(/[&<>"']/g, c => (
  { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
));

let odai = [];          // 現在のお題リスト
let editingId = null;   // 編集中のid（null なら追加モード）
let storage = 'redis';  // 保存先。memory の時は消える旨を警告する
let builtinCount = 0;
let token = '';
try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}

// ===== API =====
async function call(method, body) {
  const res = await fetch(API, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'x-admin-token': token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // パスワードが設定されている環境。入れ直して同じ操作をやり直す
    const input = prompt('管理パスワードを入力してください');
    if (input === null) throw new Error('中止しました');
    token = input;
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
    return call(method, body);
  }
  if (!res.ok) throw new Error(data.error || '通信エラーが発生しました');
  return data;
}

// ===== フォーム =====
function buildOptInputs() {
  const g = $('#opt-grid');
  g.innerHTML = '';
  for (let i = 0; i < OPT_MAX; i++) {
    const row = document.createElement('label');
    row.className = 'opt-field';
    row.innerHTML = `<span class="opt-badge ${BADGES[i]}">${LETTERS[i]}</span>` +
      `<input type="text" class="input-field" maxlength="20" data-opt="${i}" placeholder="選択肢${i + 1}">`;
    g.appendChild(row);
  }
}
function readForm() {
  return {
    q: $('#f-q').value.trim(),
    // 空欄は詰めて送る（末尾を空にすれば3〜6択のお題も作れる）
    opts: [...document.querySelectorAll('#opt-grid input')].map(i => i.value.trim()).filter(Boolean),
  };
}
function setMode(item) {
  editingId = item ? item.id : null;
  $('#form-title').textContent = item ? `お題を編集（#${item.id}）` : 'お題を追加';
  $('#btn-save').textContent = item ? '更新する' : '追加する';
  $('#btn-cancel').style.display = item ? '' : 'none';
  $('#f-q').value = item ? item.q : '';
  [...document.querySelectorAll('#opt-grid input')].forEach((inp, i) => {
    inp.value = item && item.opts[i] ? item.opts[i] : '';
  });
  msg('');
  render();
  if (item) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('#f-q').focus();
  }
}
function msgOf(sel, text, ok) {
  const el = $(sel);
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}
const msg = (text, ok) => msgOf('#form-msg', text, ok);

// ===== 描画 =====
function paintMeta() {
  $('#meta').textContent = `全 ${odai.length} 件 ・ 組み込み ${builtinCount} 件`;
  const note = $('#storage-note');
  if (storage === 'memory') {
    note.className = 'admin-note alert';
    note.textContent = 'Redis が未設定のため、編集内容はサーバーの再起動で消えます（インスタンス間でも共有されません）。'
      + '本番で使う場合は KV_REST_API_URL / KV_REST_API_TOKEN を設定してください。';
  } else if (odai.length < 10) {
    note.className = 'admin-note warn';
    note.textContent = 'お題が10件を下回っています。ラウンド数より少ないと、お題が尽きた時点でゲームが終了します。';
  } else {
    note.className = 'admin-note';
    note.textContent = '';
  }
}
function render() {
  const kw = $('#search').value.trim().toLowerCase();
  const shown = kw
    ? odai.filter(o => (o.q + ' ' + o.opts.join(' ')).toLowerCase().includes(kw))
    : odai;

  $('#count').textContent = kw ? `${shown.length} / ${odai.length} 件` : `${odai.length} 件`;

  const list = $('#list');
  if (!shown.length) {
    list.innerHTML = `<p class="empty-note">${kw ? '該当するお題がありません' : 'お題がありません'}</p>`;
    return;
  }
  list.innerHTML = shown.map(o => `
    <div class="odai-row ${o.id === editingId ? 'editing' : ''}">
      <div class="odai-top">
        <span class="odai-id">#${o.id}</span>
        <span class="odai-q">${esc(o.q)}</span>
        <span class="odai-acts">
          <button type="button" data-edit="${o.id}">編集</button>
          <button type="button" class="danger" data-del="${o.id}">削除</button>
        </span>
      </div>
      <div class="odai-opts">
        ${o.opts.map((t, i) =>
          `<span class="odai-opt"><span class="opt-badge ${BADGES[i]}">${LETTERS[i]}</span>${esc(t)}</span>`
        ).join('')}
      </div>
    </div>`).join('');
}
// 一覧を返すレスポンスを受けて全体を描き直す
function apply(data) {
  if (Array.isArray(data.odai)) odai = data.odai;
  if (data.storage) storage = data.storage;
  if (data.builtinCount != null) builtinCount = data.builtinCount;
  paintMeta();
  render();
}

// ===== 操作 =====
$('#btn-save').addEventListener('click', async () => {
  const form = readForm();
  const wasEditing = editingId !== null;
  $('#btn-save').disabled = true;
  try {
    apply(await call('POST', wasEditing
      ? Object.assign({ action: 'update', id: editingId }, form)
      : Object.assign({ action: 'create' }, form)));
    setMode(null);
    msg(wasEditing ? '更新しました' : '追加しました', true);
  } catch (e) {
    msg(e.message);
  }
  $('#btn-save').disabled = false;
});
$('#btn-cancel').addEventListener('click', () => setMode(null));

$('#list').addEventListener('click', async e => {
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const item = odai.find(o => String(o.id) === edit.dataset.edit);
    if (item) setMode(item);
    return;
  }
  const del = e.target.closest('[data-del]');
  if (!del) return;
  const item = odai.find(o => String(o.id) === del.dataset.del);
  if (!item || !confirm(`「${item.q}」を削除します。よろしいですか？`)) return;
  try {
    const wasEditingThis = editingId === item.id;
    apply(await call('POST', { action: 'delete', id: item.id }));
    if (wasEditingThis) setMode(null);
  } catch (err) {
    alert(err.message);
  }
});

// デッキの内容で基本のお題を丸ごと置き換える
$('#btn-import').addEventListener('click', async () => {
  const code = $('#import-code').value.trim().toUpperCase();
  if (!code) return msgOf('#import-msg', 'コードを入力してください');
  if (!confirm(`今の基本のお題（${odai.length}件）を、コード ${code} の内容に置き換えます。よろしいですか？`)) return;
  $('#btn-import').disabled = true;
  try {
    const r = await call('POST', { action: 'import', code });
    apply(r);
    setMode(null);
    msgOf('#import-msg', `「${r.from.name}」（${code}）の ${r.odai.length}件に差し替えました`, true);
    $('#import-code').value = '';
  } catch (e) {
    msgOf('#import-msg', e.message);
  }
  $('#btn-import').disabled = false;
});

$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('編集内容をすべて破棄して、コードに組み込まれている初期リストに戻します。よろしいですか？')) return;
  try {
    apply(await call('POST', { action: 'reset' }));
    setMode(null);
    msg('組み込みのリストに戻しました', true);
  } catch (e) {
    alert(e.message);
  }
});

$('#search').addEventListener('input', render);

buildOptInputs();
call('GET').then(apply).catch(e => { $('#meta').textContent = e.message; });
