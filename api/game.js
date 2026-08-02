// Single serverless function for all game operations.
// 状態は lib/store.js が Redis に永続化する（インスタンス間で共有される）。

const { createRoom, joinRoom, processAction, getView, storageEnabled } = require('../lib/store');

// 「見つからない」系は 404、入力・進行の不正は 400
const NOT_FOUND = 'ルームが見つかりません';
function fail(res, result) {
  return res.status(result.error === NOT_FOUND ? 404 : 400).json(result);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET ?health=1: 共有ストレージが効いているかの確認用。
    // memory のままだとインスタンスを跨いだ瞬間に部屋を見失う
    if (req.method === 'GET' && req.query.health !== undefined) {
      return res.status(200).json({ ok: true, storage: storageEnabled ? 'redis' : 'memory' });
    }

    // GET: poll state
    if (req.method === 'GET') {
      const { code, playerId } = req.query;
      if (!code || !playerId) return res.status(400).json({ error: 'code and playerId required' });
      const view = await getView(code.toUpperCase(), playerId);
      if (view.error) return fail(res, view);
      return res.status(200).json(view);
    }

    // POST: actions
    if (req.method === 'POST') {
      const body = req.body || {};
      const { action } = body;

      if (action === 'create') {
        const name = (body.name || '').trim();
        if (!name) return res.status(400).json({ error: '名前を入力してください' });
        const clamp = (v, def, min, max) => {
          const n = parseInt(v);
          return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
        };
        const answerSeconds = clamp(body.answerSeconds, 120, 15, 600);
        const revealSeconds = clamp(body.revealSeconds, 60, 10, 300);
        const deckCode = String(body.deckCode || '').toUpperCase().trim();
        const result = await createRoom(
          name, parseInt(body.rounds) || 5, answerSeconds, revealSeconds, deckCode || null);
        if (result.error) return fail(res, result);
        return res.status(200).json(result);
      }

      if (action === 'join') {
        const code = (body.code || '').toUpperCase();
        const name = (body.name || '').trim();
        if (!code || !name) return res.status(400).json({ error: 'code and name required' });
        const result = await joinRoom(code, name);
        if (result.error) return fail(res, result);
        const view = await getView(code, result.playerId);
        return res.status(200).json({ playerId: result.playerId, view: view.error ? null : view });
      }

      // Game actions: start, draw_reroll, draw_confirm, submit_answer,
      // flip_card, open_payout, ready_next, play_again, back_to_lobby
      const code = (body.code || '').toUpperCase();
      const { playerId } = body;
      if (!code || !playerId || !action) return res.status(400).json({ error: 'code, playerId, action required' });
      const result = await processAction(code, playerId, action, body);
      if (result.error) return fail(res, result);
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/game]', e);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
};
