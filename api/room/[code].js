const { getRoom, joinRoom, processAction, buildView } = require('../../lib/store');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const code = (req.query.code || '').toUpperCase();

  // GET: poll state
  if (req.method === 'GET') {
    const playerId = req.query.playerId;
    const room = getRoom(code);
    if (!room) return res.status(404).json({ error: 'ルームが見つかりません' });
    if (!playerId) return res.status(400).json({ error: 'playerId required' });
    return res.status(200).json(buildView(room, playerId));
  }

  // POST: join or action
  if (req.method === 'POST') {
    const body = req.body || {};
    const { action } = body;

    if (action === 'join') {
      const name = (body.name || '').trim();
      if (!name) return res.status(400).json({ error: '名前を入力してください' });
      const result = joinRoom(code, name);
      if (result.error) return res.status(400).json(result);
      // Return playerId + initial view
      const room = getRoom(code);
      return res.status(200).json({ playerId: result.playerId, view: buildView(room, result.playerId) });
    }

    // Game actions
    const { playerId, ...data } = body;
    if (!playerId || !action) return res.status(400).json({ error: 'playerId and action required' });
    const result = processAction(code, playerId, action, data);
    if (result.error) return res.status(400).json(result);
    const room = getRoom(code);
    return res.status(200).json(buildView(room, playerId));
  }

  res.status(405).json({ error: 'Method not allowed' });
};
