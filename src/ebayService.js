// Acces a l'API officielle eBay (Browse API).
const fetch = require('node-fetch');

let cachedToken = null;
let tokenExpiresAt = 0;

const EBAY_ENV = 'https://api.ebay.com'; // production

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET manquants dans les variables d\'environnement.');
  }
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(`${EBAY_ENV}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Echec authentification eBay (${res.status}): ${text}`);
  }

  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedToken;
}

function buildQuery(watch) {
  const parts = [watch.cardName, watch.setName, watch.grader, watch.grade ? `${watch.grade}` : null]
    .filter(Boolean);
  if (!watch.cardName && !watch.setName) parts.push('pokemon');
  if (!watch.grader) parts.push('graded');
  return parts.join(' ');
}
