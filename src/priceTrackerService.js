// Source de prix officielle et specialisee (pokemonpricetracker.com), en complement de
// l'estimation "maison" basee sur les annonces eBay actives.
//
// Principe : notre propre estimation (priceReference.js) sert de PREMIER FILTRE rapide et
// gratuit pour reperer les annonces potentiellement interessantes parmi des centaines de
// resultats. Des qu'une annonce depasse le seuil de decote, on fait UN appel a cette API pour
// (1) identifier precisement la carte via son titre et (2) recuperer son vrai prix de marche
// (ventes eBay reelles, par grade exact) + un historique de prix pour le graphique.
// On ne l'appelle jamais pour les centaines d'annonces "normales" scannees a chaque cycle,
// afin de rester dans le quota gratuit (100 credits/jour).

const fetch = require('node-fetch');

const BASE_URL = 'https://www.pokemonpricetracker.com/api/v2';

// Anti-spam : espace les appels d'au moins 1.2s pour ne jamais depasser la limite de
// frequence de l'API gratuite (erreur HTTP 429 "Too Many Requests" sinon).
let lastCallAt = 0;
const MIN_DELAY_MS = 1200;
async function throttle() {
  const wait = lastCallAt + MIN_DELAY_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
}

function isConfigured() {
  return Boolean(process.env.POKEMONPRICETRACKER_API_KEY);
}

async function parseTitle(title) {
  if (!isConfigured()) return null;
  try {
    await throttle();
    const res = await fetch(`${BASE_URL}/parse-title`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.POKEMONPRICETRACKER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, options: { fuzzyMatching: true, maxSuggestions: 1, includeConfidence: true } }),
    });
    if (!res.ok) {
      console.log(`[PRICETRACKER] parse-title a echoue (HTTP ${res.status})`);
      return null;
    }
    const json = await res.json();
    const match = json?.data?.matches?.[0];
    if (!match || !match.tcgPlayerId) return null;
    return {
      tcgPlayerId: match.tcgPlayerId,
      confidence: match.confidence || match.matchScore || null,
      parsedGrade: json?.data?.parsed?.grade || null,
      parsedGrader: json?.data?.parsed?.grader || null,
    };
  } catch (e) {
    console.error('Erreur parse-title PokemonPriceTracker:', e.message);
    return null;
  }
}

// Recupere le vrai prix de marche (ventes eBay reelles) pour une carte + un grade precis,
// ainsi qu'un historique de prix pour le graphique.
async function getOfficialMarketData(tcgPlayerId, grader, grade) {
  if (!isConfigured()) return null;
  try {
    await throttle();
    const params = new URLSearchParams({
      tcgPlayerId: String(tcgPlayerId),
      includeEbay: 'true',
      includeHistory: 'true',
      days: '90',
    });
    const res = await fetch(`${BASE_URL}/cards?${params.toString()}`, {
      headers: { Authorization: `Bearer ${process.env.POKEMONPRICETRACKER_API_KEY}` },
    });
    if (!res.ok) {
      console.log(`[PRICETRACKER] cards a echoue (HTTP ${res.status})`);
      return null;
    }
    const json = await res.json();
    const card = Array.isArray(json.data) ? json.data[0] : json.data;
    if (!card) return null;

    // Construit la cle de grade (ex: "psa10", "bgs9_5") pour aller chercher la bonne valeur
    const graderKey = (grader || '').toLowerCase();
    const gradeKey = grade ? String(grade).replace('.', '_') : null;
    const ebayKey = gradeKey ? `${graderKey}${gradeKey}` : null;
    const ebayData = ebayKey && card.ebay ? card.ebay[ebayKey] : null;

    if (!ebayData || !ebayData.avg) return null;

    // Historique de prix pour le graphique (si disponible pour ce grade precis)
    const history = card.priceHistory?.ebay?.[ebayKey] || card.priceHistory?.variants?.[ebayKey] || [];

    return {
      officialMarketPrice: ebayData.avg || ebayData.median,
      salesCount: ebayData.salesCount || ebayData.count || null,
      cardName: card.name,
      setName: card.setName,
      priceHistory: Array.isArray(history)
        ? history.map((point) => ({
            date: point.date || point.timestamp,
            price: point.price || point.value,
          })).filter((p) => p.date && typeof p.price === 'number')
        : [],
    };
  } catch (e) {
    console.error('Erreur cards PokemonPriceTracker:', e.message);
    return null;
  }
}

// Fonction combinee pratique : a partir du titre d'une annonce eBay, tente de recuperer
// le vrai prix de marche officiel. Retourne null si pas configure / pas trouve / pas assez confiant.
async function getOfficialPriceForListing(listing, detectedGrader, detectedGrade) {
  const parsed = await parseTitle(listing.title);
  if (!parsed) {
    console.log(`[PRICETRACKER] Aucune carte identifiee pour le titre "${listing.title}"`);
    return null;
  }
  if (parsed.confidence !== null && parsed.confidence < 0.5) {
    console.log(`[PRICETRACKER] Correspondance trouvee mais confiance trop faible (${parsed.confidence}) pour "${listing.title}"`);
    return null;
  }

  const grader = parsed.parsedGrader || detectedGrader;
  const grade = parsed.parsedGrade || detectedGrade;
  if (!grader || !grade) {
    console.log(`[PRICETRACKER] Carte identifiee (tcgPlayerId ${parsed.tcgPlayerId}) mais grade/grader inconnu pour "${listing.title}"`);
    return null;
  }

  const marketData = await getOfficialMarketData(parsed.tcgPlayerId, grader, grade);
  if (!marketData) {
    console.log(`[PRICETRACKER] Carte identifiee (tcgPlayerId ${parsed.tcgPlayerId}) mais pas de donnees eBay pour ${grader} ${grade}`);
  }
  return marketData;
}

module.exports = { isConfigured, parseTitle, getOfficialMarketData, getOfficialPriceForListing };
