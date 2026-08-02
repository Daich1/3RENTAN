// お題リスト（デッキ）の共有API。/deck.html から使う。
// 管理API(api/odai.js)と違い、プレイヤーが自分のリストを作る用途なので保護はしない。
// 既存デッキの更新はコードを知っている人だけができる＝コードが実質の合鍵。

const { getDeck, saveDeck, getSharedOdai } = require('../lib/store');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      // ?defaults=1 … 選択元になる共通リスト（管理パスワード不要で読めるようにする）
      if (req.query.defaults !== undefined) {
        return res.status(200).json({ odai: await getSharedOdai() });
      }
      const code = String(req.query.code || '').toUpperCase().trim();
      if (!code) return res.status(400).json({ error: 'コードを指定してください' });
      const deck = await getDeck(code);
      if (deck.error) return res.status(deck.error.includes('見つかりません') ? 404 : 400).json(deck);
      return res.status(200).json(deck);
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      // コード指定があればそのコードで保存（無ければ新規、あれば上書き）
      const result = await saveDeck(String(body.code || '').trim(), body.name, body.odai);
      if (result.error) return res.status(400).json(result);
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/deck]', e);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
};
