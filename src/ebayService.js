// Acces a l'API officielle eBay (Browse API).
// Doc: https://developer.ebay.com/api-docs/buy/browse/overview.html
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

async function searchActiveListings(watch, { limit = 50, offset = 0 } = {}) {
  const token = await getAccessToken();
  const query = buildQuery(watch);

  const params = new URLSearchParams({
    q: query,
    category_ids: '183454',
    limit: String(limit),
    offset: String(offset),
    sort: 'price',
  });

  const filters = [];
  if (watch.maxPrice) filters.push(`price:[..${watch.maxPrice}]`);
  filters.push('buyingOptions:{FIXED_PRICE|AUCTION}');
  // CORRECTIF IMPORTANT : la categorie eBay utilisee (183454) contient en realite un
  // melange de cartes GRADEES et de cartes BRUTES/accessoires -- ce n'est PAS une
  // categorie exclusivement "cartes gradees" comme on le pensait. Jusqu'ici, on essayait
  // de deviner apres coup (titre/regex) si chaque annonce etait bien gradee, ce qui
  // echouait souvent (beaucoup de vendeurs ne mettent pas "PSA" clairement dans le titre),
  // laissant trop peu d'annonces exploitables une fois le tri fait cote client.
  // On demande maintenant a eBay de ne renvoyer QUE les objets ayant le condition
  // structure officiel "Graded" (conditionId 2750) -- filtrage fait cote serveur eBay,
  // bien plus fiable qu'une regex sur un texte libre mal renseigne par le vendeur.
  filters.push('conditionIds:{2750}');
  if (filters.length) params.set('filter', filters.join(','));

  const marketplace = process.env.EBAY_MARKETPLACE || 'EBAY_US';

  const res = await fetch(`${EBAY_ENV}/buy/browse/v1/item_summary/search?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplace,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Erreur recherche eBay (${res.status}): ${text}`);
  }

  const json = await res.json();
  return (json.itemSummaries || []).map((item) => {
    let officialGrader = null;
    let officialGrade = null;
    if (item.condition === 'Graded' && Array.isArray(item.conditionDescriptors)) {
      for (const desc of item.conditionDescriptors) {
        const values = (desc.values || []).map((v) => v.content).filter(Boolean);
        if (desc.name === 'Professional Grader' && values[0]) officialGrader = values[0];
        if (desc.name === 'Grade' && values[0]) officialGrade = values[0];
      }
    }

    const isAuction = Array.isArray(item.buyingOptions) && item.buyingOptions.includes('AUCTION');

    return {
      listingId: item.itemId,
      title: item.title,
      price: item.price ? parseFloat(item.price.value) : null,
      currency: item.price ? item.price.currency : 'EUR',
      url: item.itemWebUrl,
      imageUrl: item.image ? item.image.imageUrl : null,
      condition: item.condition,
      officialGrader,
      officialGrade,
      isAuction,
      bidCount: item.bidCount || null,
      shippingCost: item.shippingOptions && item.shippingOptions[0]
        ? parseFloat(item.shippingOptions[0].shippingCost?.value || 0)
        : 0,
      seller: item.seller ? item.seller.username : null,
      buyingOptions: item.buyingOptions,
    };
  }).filter((listing) => !isLikelyNotACard(listing.title));
}

const NOT_A_CARD_KEYWORDS = [
  'sticker', 'autocollant', 'funko', 'plush', 'peluche', 'figure', 'figurine',
  'pin', 'pins', 'poster', 'coin',
  'pieces?\\s*de\\s*monnaie',
  'display\\s*case', 'empty\\s*slab', 'boite\\s*vide',
  'classeur', 'binder', 'sleeve', 'protege[- ]cartes',
  'playmat', 'tapis\\s*de\\s*jeu',
  'lot\\s+de\\s+\\d', 'bundle', 'deck\\s*box', 'booster\\s*box\\s*empty',
  'pick\\s*your', 'you\\s*pick', 'u\\s*pick', 'choose\\s*your', 'select\\s*your',
  'pick\\s*a\\s*card', 'your\\s*choice', 'pick\\s*one',
  '(?:pick|choix)\\s*\\d+\\s*carte',
];
const NOT_A_CARD_PATTERN = new RegExp('\\b(' + NOT_A_CARD_KEYWORDS.join('|') + ')\\b', 'i');

function isLikelyNotACard(title) {
  return NOT_A_CARD_PATTERN.test(title || '');
}

module.exports = { getAccessToken, searchActiveListings, buildQuery };
