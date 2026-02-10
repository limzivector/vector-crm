export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { to, cc, subject, body } = req.body || {};
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, body' });
    }

    const tenantId = process.env.MS_TENANT_ID;
    const clientId = process.env.MS_CLIENT_ID;
    const clientSecret = process.env.MS_CLIENT_SECRET;
    const sender = process.env.MS_SENDER;
    if (!tenantId || !clientId || !clientSecret || !sender) {
      return res.status(500).json({ error: 'Missing Outlook env vars (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SENDER)' });
    }

    const tokenResp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      return res.status(500).json({ error: 'Token request failed', details: tokenData });
    }

    const ccList = Array.isArray(cc)
      ? cc
      : typeof cc === 'string'
        ? cc.split(/[;,]+/).map(s => s.trim()).filter(Boolean)
        : [];

    const mailPayload = {
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: to } }],
        ccRecipients: ccList.map(address => ({ emailAddress: { address } }))
      },
      saveToSentItems: true
    };

    const sendResp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mailPayload)
    });

    if (!sendResp.ok) {
      const errText = await sendResp.text().catch(() => '');
      return res.status(sendResp.status).json({ error: 'SendMail failed', details: errText });
    }

    return res.status(202).json({ ok: true });
  } catch (e) {
    console.error('send-email error:', e);
    return res.status(500).json({ error: 'Server error', details: e.message });
  }
}
