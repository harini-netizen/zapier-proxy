export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const ZAPIER_WEBHOOK = 'https://hooks.zapier.com/hooks/catch/27399381/uvmdqko/';
  const SHEET_ID       = process.env.GOOGLE_SHEET_ID;
  const CLIENT_EMAIL   = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const PRIVATE_KEY    = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const POLL_INTERVAL_MS = 2000;
  const POLL_TIMEOUT_MS  = 20000;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  if (!body || !body.email) {
    return res.status(400).json({ error: 'Missing email in request body', received: JSON.stringify(body) });
  }

  let webhookResp;
  try {
    webhookResp = await fetch(ZAPIER_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    return res.status(502).json({ error: 'Zapier webhook fetch failed', detail: err.message });
  }

  if (!webhookResp.ok) {
    const text = await webhookResp.text();
    return res.status(502).json({ error: 'Zapier webhook failed', status: webhookResp.status, detail: text });
  }

  const matchEmail = body.email;
  const deadline   = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const meet_link = await fetchMeetLinkFromSheets(SHEET_ID, CLIENT_EMAIL, PRIVATE_KEY, matchEmail);
    if (meet_link) return res.status(200).json({ status: 'success', meet_link });
  }

  return res.status(202).json({
    status: 'pending',
    message: 'Booking submitted but meet_link not yet available. Please check your email.'
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getGoogleAccessToken(clientEmail, privateKey) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;

  const crypto = require('crypto');
  const sign   = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');

  const jwt = `${signingInput}.${signature}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const tokenData = await tokenResp.json();
  return tokenData.access_token;
}

async function fetchMeetLinkFromSheets(sheetId, clientEmail, privateKey, email) {
  try {
    const accessToken = await getGoogleAccessToken(clientEmail, privateKey);
    const range = 'Sheet1!A:C';
    const url   = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;

    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!resp.ok) {
      console.error('Sheets API error:', resp.status, await resp.text());
      return null;
    }

    const data = await resp.json();
    const rows = data.values || [];

    for (let i = rows.length - 1; i >= 1; i--) {
      const [rowEmail, rowMeetLink] = rows[i];
      if (rowEmail === email && rowMeetLink) return rowMeetLink;
    }

    return null;
  } catch (err) {
    console.error('fetchMeetLinkFromSheets error:', err);
    return null;
  }
}
