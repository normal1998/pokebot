// Estime le "prix marche" d'une carte gradee pour pouvoir juger si une annonce est une bonne affaire.
//
// IMPORTANT (limite technique honnete) :
// L'API Browse standard d'eBay ne donne acces qu'aux annonces ACTIVES, pas aux ventes conclues.
// Pour un vrai historique des ventes (le plus fiable pour estimer un prix marche), il faut
// la "Marketplace Insights API" d'eBay, soumise a une demande d'acces specifique aupres d'eBay
// (formulaire a remplir sur developer.ebay.com, approbation pas automatique, non garantie).
//
// En attendant/sans cet acces, ce module utilise une methode de repli : la mediane des prix
// des annonces ACTIVES comparables (hors valeurs extremes). Ce n'est PAS un vrai historique
// de ventes, juste une approximation de ce que les vendeurs demandent actuellement.

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function removeOutliers(values) {
  if (values.length < 4) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  return sorted.filter((v) => v >= low && v <= high);
}

function getMarketPriceFromListings(listings) {
  const prices = listings.map((l) => l.price).filter((p) => typeof p === 'number' && p > 0);
  const cleaned = removeOutliers(prices);
  const usedPrices = cleaned.length ? cleaned : prices;
  const marketPrice = median(usedPrices);
  return {
    marketPrice,
    sampleSize: usedPrices.length,
    comparablePrices: usedPrices.sort((a, b) => a - b),
    method: 'median_active_listings',
  };
}

// ===== Detection du grader et du grade dans le titre =====
// CRITIQUE pour la fiabilite des prix : un PSA 10 et un PSA 6 de la MEME carte n'ont
// rien a voir en valeur. On ne doit jamais les regrouper ensemble, meme si le reste
// du titre est identique. Le grader et le grade sont donc des criteres de regroupement
// A PART ENTIERE, jamais de simples "mots ignores".

const GRADER_PATTERNS = [
  { key: 'PSA', regex: /\bpsa\b/i },
  { key: 'BGS', regex: /\bbgs\b|beckett/i },
  { key: 'CGC', regex: /\bcgc\b/i },
  { key: 'SGC', regex: /\bsgc\b/i },
  { key: 'ACE', regex: /\bace\b/i },
];

function detectGrader(title) {
  const t = title || '';
  for (const { key, regex } of GRADER_PATTERNS) {
    if (regex.test(t)) return key;
  }
  return null;
}

function detectGrade(title, grader) {
  const t = title || '';
  const graderWord = grader ? grader : '(psa|bgs|cgc|sgc|ace|beckett)';
  const re = new RegExp(graderWord + '\\s*(\\d{1,2}(?:\\.\\d)?)', 'i');
  const match = t.match(re);
  if (match) return match[1];
  return null;
}

// eBay renvoie parfois le nom complet du grader (ex: "Professional Sports Authenticator (PSA)")
// au lieu du sigle. On normalise vers le sigle court utilise partout ailleurs dans le bot.
function normalizeGraderName(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('psa') || n.includes('professional sports authenticator')) return 'PSA';
  if (n.includes('bgs') || n.includes('beckett')) return 'BGS';
  if (n.includes('cgc')) return 'CGC';
  if (n.includes('sgc')) return 'SGC';
  if (n.includes('ace')) return 'ACE';
  return name;
}

const STOPWORDS = new Set([
  'pokemon', 'card', 'carte', 'graded', 'gradee', 'tcg',
  'the', 'a', 'de', 'la', 'le', 'des', 'et', 'holo', 'holographic', 'mint', 'near', 'gem', 'nm',
  'excellent', 'etat', 'rare', 'pepite', 'promo', 'edition', 'wotc', 'unlimited', 'shadowless',
  'authentic', 'certified', 'slab', 'slabbed', 'vintage', 'original', 'beckett',
  'psa', 'bgs', 'cgc', 'sgc', 'ace',
]);

function significantWords(title) {
  return new Set(
    (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s.]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w) && !/^\d{1,2}(\.\d)?$/.test(w))
  );
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size && !setB.size) return 0;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Regroupe les annonces par carte probable EN TENANT COMPTE du grade et du grader
// detectes (criteres stricts, jamais melanges), puis par similarite du reste du titre.
function getGroupedMarketPrices(listings, { minSampleSize = 3, similarityThreshold = 0.5 } = {}) {
  const withWords = listings
    .filter((l) => typeof l.price === 'number' && l.price > 0)
    .map((l) => {
      // Priorite aux donnees officielles eBay (conditionDescriptors), bien plus fiables
      // que la detection par regex dans le titre, utilisee seulement en secours.
      const grader = l.officialGrader ? normalizeGraderName(l.officialGrader) : detectGrader(l.title);
      const grade = l.officialGrade || detectGrade(l.title, grader);
      return { listing: l, words: significantWords(l.title), grader, grade };
    });

  const strictGroups = new Map();
  for (const entry of withWords) {
    const key = `${entry.grader || '?'}|${entry.grade || '?'}`;
    if (!strictGroups.has(key)) strictGroups.set(key, []);
    strictGroups.get(key).push(entry);
  }

  const result = new Map();

  for (const entries of strictGroups.values()) {
    const clusters = [];
    for (const entry of entries) {
      let bestCluster = null;
      let bestScore = 0;
      for (const cluster of clusters) {
        const score = jaccardSimilarity(entry.words, cluster.words);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = cluster;
        }
      }
      if (bestCluster && bestScore >= similarityThreshold) {
        bestCluster.items.push(entry);
        bestCluster.words = new Set([...bestCluster.words].filter((w) => entry.words.has(w)));
      } else {
        clusters.push({ words: new Set(entry.words), items: [entry] });
      }
    }

    for (const cluster of clusters) {
      const clusterListings = cluster.items.map((i) => i.listing);
      const grader = cluster.items[0].grader;
      const grade = cluster.items[0].grade;
      if (clusterListings.length < minSampleSize) {
        for (const listing of clusterListings) {
          result.set(listing.listingId, { marketPrice: null, sampleSize: clusterListings.length, comparablePrices: [], grader, grade });
        }
        continue;
      }
      const { marketPrice, sampleSize, comparablePrices } = getMarketPriceFromListings(clusterListings);
      for (const listing of clusterListings) {
        result.set(listing.listingId, { marketPrice, sampleSize, comparablePrices, grader, grade });
      }
    }
  }

  return result;
}

module.exports = { getMarketPriceFromListings, getGroupedMarketPrices, significantWords, jaccardSimilarity, detectGrader, detectGrade, normalizeGraderName };
