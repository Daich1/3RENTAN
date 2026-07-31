// Single serverless function for all game operations.
// All requests hit the same Lambda → in-memory state is shared.

const { createRoom, getRoom, joinRoom, processAction, buildView } = require('../lib/store');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: poll state
  if (req.method === 'GET') {
    const { code, playerId } = req.query;
    if (!code || !playerId) return res.status(400).json({ error: 'code and playerId required' });
    const room = getRoom(code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'ルームが見つかりません' });
    return res.status(200).json(buildView(room, playerId));
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
      const result = createRoom(name, parseInt(body.rounds) || 5, answerSeconds, revealSeconds);
      return res.status(200).json(result);
    }

    if (action === 'join') {
      const code = (body.code || '').toUpperCase();
      const name = (body.name || '').trim();
      if (!code || !name) return res.status(400).json({ error: 'code and name required' });
      const result = joinRoom(code, name);
      if (result.error) return res.status(400).json(result);
      const room = getRoom(code);
      return res.status(200).json({ playerId: result.playerId, view: buildView(room, result.playerId) });
    }

    // Game actions: start, draw_reroll, draw_confirm, submit_answer, ready_next, play_again, back_to_lobby
    const code = (body.code || '').toUpperCase();
    const { playerId } = body;
    if (!code || !playerId || !action) return res.status(400).json({ error: 'code, playerId, action required' });
    const result = processAction(code, playerId, action, body);
    if (result.error) return res.status(400).json(result);
    const room = getRoom(code);
    return res.status(200).json(buildView(room, playerId));
  }

  res.status(405).json({ error: 'Method not allowed' });
};
