// お題の管理API（/odai.html 専用）。
// 保護は任意: 環境変数 ODAI_ADMIN_TOKEN を設定すると、以降は
// x-admin-token ヘッダが一致しないと読み書きできなくなる。未設定なら誰でも触れる
// ＝URLを知られた時点で編集されうるので、公開先で使うなら設定推奨。

const {
  listOdai, createOdai, updateOdai, deleteOdai, resetOdai, importDeckAsShared,
} = require('../lib/store');

const TOKEN = process.env.ODAI_ADMIN_TOKEN || '';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (TOKEN && (req.headers['x-admin-token'] || '') !== TOKEN) {
      return res.status(401).json({ error: '管理パスワードが違います', needToken: true });
    }

    if (req.method === 'GET') {
      return res.status(200).json(await listOdai());
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      let result;
      switch (body.action) {
        case 'create': result = await createOdai(body); break;
        case 'update': result = await updateOdai(body.id, body); break;
        case 'delete': result = await deleteOdai(body.id); break;
        case 'reset':  result = await resetOdai(); break;
        case 'import': result = await importDeckAsShared(body.code); break;
        default: return res.status(400).json({ error: '不明な操作です' });
      }
      if (result.error) return res.status(400).json(result);
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/odai]', e);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
};
