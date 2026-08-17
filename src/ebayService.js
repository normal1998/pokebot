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

// Construit la requete de recherche a partir des criteres d'une "watch".
// Si aucun nom de carte n'est donne, on scanne TOUTES les cartes gradees Pokemon
// (mode "chasse aux pepites" : on compte sur le calcul de rentabilite pour filtrer,
// pas sur un nom precis).
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
    category_ids: '183454', // categorie eBay "Trading Card Games > Pokemon" gradees (a ajuster si besoin)
    limit: String(limit),
    offset: String(offset),
    sort: 'price',
  });

  const filters = [];
  if (watch.maxPrice) filters.push(`price:[..${watch.maxPrice}]`);
  filters.push('priceCurrency:EUR');
  filters.push('buyingOptions:{FIXED_PRICE|AUCTION}');
  // NB: le filtre officiel conditionIds:{2750} ("Certified - Graded") existe mais s'est
  // revele trop strict en pratique : beaucoup de vendeurs ecrivent "PSA 9" dans le titre
  // sans cocher l'attribut structure correspondant sur eBay, donc ce filtre coupait
  // aussi de vraies cartes gradees. On filtre plutot par mots-cles apres coup (voir plus bas).
  if (filters.length) params.set('filter', filters.join(','));

  const marketplace = process.env.EBAY_MARKETPLACE || 'EBAY_FR';

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
    // Extrait le grade et le grader depuis les donnees structurees eBay (conditionDescriptors),
    // beaucoup plus fiable que de deviner depuis le texte libre du titre.
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

// Exclut les objets qui ne sont clairement PAS des cartes a l'unite : stickers, figurines,
// pin's, peluches, posters, pieces de monnaie, lots de plusieurs cartes non individualisees,
// accessoires (classeurs, protege-cartes, boites vides)... Ces objets contiennent parfois
// "PSA"/"graded" dans leur titre (ex: figurine certifiee) sans etre des cartes a acheter/revendre.
const NOT_A_CARD_PATTERN = /\b(sticker|autocollant|funko|plush|peluche|figure|figurine|pin\b|pins\b|poster|coin\b|pieces?\s*de\s*monnaie|display\s*case|empty\s*slab|boite\s*vide|classeur|binder|sleeve|protege[- ]cartes|playmat|tapis\s*de\s*jeu|lot\s+de\s+\d|bundle|deck\s*box|booster\s*box\s*empty)\b/i;

function isLikelyNotACard(title) {
  return NOT_A_CARD_PATTERN.test(title || '');
}

module.exports = { getAccessToken, searchActiveListings, buildQuery };
