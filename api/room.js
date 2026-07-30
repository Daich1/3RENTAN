const { createRoom } = require('../lib/store');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, rounds } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '名前を入力してください' });

  const result = createRoom(name.trim(), parseInt(rounds) || 5);
  res.status(200).json(result);
};
