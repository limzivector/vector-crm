export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const CS_TOKEN = process.env.CAMSCANNER_TOKEN || '200DA51E906A4370ay6Tg9SX';
  const CS_BASE = process.env.CAMSCANNER_BASE || 'https://d82.intsig.net/sync/';
  const CS_DEVICE = process.env.CAMSCANNER_DEVICE || 'WB_s0xls1mk5u';

  const { endpoint, ...params } = req.query;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint parameter' });

  // Build the CamScanner API URL
  const qs = new URLSearchParams({ ...params, token: CS_TOKEN, platform: 'web', device_id: CS_DEVICE });
  const url = CS_BASE + endpoint + '?' + qs.toString();

  try {
    const csResp = await fetch(url, {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    const contentType = csResp.headers.get('content-type') || '';

    if (contentType.includes('image')) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const buffer = await csResp.arrayBuffer();
      return res.send(Buffer.from(buffer));
    }

    const data = await csResp.json();
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json(data);
  } catch (e) {
    console.error('CamScanner proxy error:', e);
    return res.status(500).json({ error: 'Proxy error', message: e.message });
  }
}
