export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const ZAPIER_WEBHOOK = 'https://hooks.zapier.com/hooks/catch/17069947/uvxy225/';
  const SHEET_ID       = process.env.GOOGLE_SHEET_ID;
  const CLIENT_EMAIL   = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const PRIVATE_KEY    = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const POLL_TIMEOUT_MS = 8000;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  if (!body?.email) return res.status(400).json({ error: 'Missing email in request body' });

  const email = body.email;

  // Fetch token once, reuse across all polls
  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(CLIENT_EMAIL, PRIVATE_KEY);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get Google access token', detail: err.message });
  }

  // Snapshot row count before triggering Zapier
  const countBefore = await getMeetLinkCount(SHEET_ID, accessToken, email);

  // Trigger Zapier
  try {
    const webhookResp = await fetch(ZAPIER_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!webhookResp.ok) {
      const text = await webhookResp.text();
      return res.status(502).json({ error: 'Zapier webhook failed', status: webhookResp.status, detail: text });
    }
  } catch (err) {
    return res.status(502).json({ error: 'Zapier webhook fetch failed', detail: err.message });
  }

  // Poll with exponential backoff: 500ms → 1000ms → 1500ms → 2000ms (max)
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let interval = 500;

  while (Date.now() < deadline) {
    const meet_link = await fetchNewMeetLink(SHEET_ID, accessToken, email, countBefore);
    if (meet_link) return res.status(200).json({ status: 'success', meet_link });
    await sleep(interval);
    interval = Math.min(interval + 500, 2000);
  }

  return res.status(202).json({
    status: 'pending',
    message: 'Booking submitted but meet_link not yet available. Please check your email.',
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    exp: now + 3600,
  };

  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sigInput = `${encode(header)}.${encode(payload)}`;

  const crypto = require('crypto');
  const sign   = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const jwt = `${sigInput}.${sign.sign(privateKey, 'base64url')}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await tokenResp.json();
  if (!data.access_token) throw new Error(JSON.stringify(data));
  return data.access_token;
}

async function getMeetLinkCount(sheetId, accessToken, email) {
  try {
    const url  = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:B`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return 0;
    const { values = [] } = await resp.json();
    let count = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === email && values[i][1]) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

async function fetchNewMeetLink(sheetId, accessToken, email, countBefore) {
  try {
    const url  = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:B`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return null;
    const { values = [] } = await resp.json();
    const links = [];
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === email && values[i][1]) {
        links.push(values[i][1]);
      }
    }
    return links.length > countBefore ? links[links.length - 1] : null;
  } catch (err) {
    console.error('fetchNewMeetLink error:', err);
    return null;
  }
}
