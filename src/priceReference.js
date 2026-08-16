// Estime le "prix marche" d'une carte gradee pour pouvoir juger si une annonce est une bonne affaire.
//
// IMPORTANT (limite technique honnete) :
// L'API Browse standard d'eBay ne donne acces qu'aux annonces ACTIVES, pas aux ventes conclues.
// Pour un vrai historique des ventes (le plus fiable pour estimer un prix marche), il faut
// la "Marketplace Insights API" d'eBay, soumise a une demande d'acces specifique aupres d'eBay
// (formulaire a remplir sur developer.ebay.com, approbation pas automatique).
//
// En attendant/sans cet acces, ce module utilise une methode de repli robuste :
// on prend la mediane des prix des annonces actives comparables (hors valeurs extremes),
// ce qui donne une bonne approximation du marche pour la plupart des cartes liquides.
//
// Si vous obtenez l'acces a la Marketplace Insights API plus tard, remplacez
// getMarketPrice() par un appel a cette API pour plus de precision.

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
  const marketPrice = median(cleaned.length ? cleaned : prices);
  return {
    marketPrice,
    sampleSize: cleaned.length || prices.length,
    method: 'median_active_listings',
  };
}

// Mots a ignorer pour comparer des titres d'annonces entre eux (grades, graders,
// mots generiques). Sert au mode "toutes les cartes gradees" ou l'on ne peut pas
// comparer des cartes differentes avec un seul prix moyen global.
const STOPWORDS = new Set([
  'pokemon', 'card', 'carte', 'graded', 'gradee', 'tcg', 'psa', 'bgs', 'cgc', 'ace', 'sgc',
  'the', 'a', 'de', 'la', 'le', 'des', 'et', 'holo', 'holographic', 'mint', 'near', 'gem', 'nm',
  'excellent', 'etat', 'rare', 'pepite', 'promo', 'edition', 'wotc', 'unlimited', 'shadowless',
  'authentic', 'certified', 'slab', 'slabbed', 'vintage', 'original',
]);

function significantWords(title) {
  return new Set(
    (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w) && !/^\d+(\.\d+)?$/.test(w))
  );
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size && !setB.size) return 0;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Regroupe les annonces par carte probable en comparant la similarite des titres
// (et pas une correspondance exacte), pour eviter qu'un simple mot en plus dans une
// annonce ("RARE", "PROMO"...) ne la fasse sortir de son groupe de comparaison.
// Necessaire des qu'une veille couvre plusieurs cartes differentes.
function getGroupedMarketPrices(listings, { minSampleSize = 3, similarityThreshold = 0.5 } = {}) {
  const withWords = listings
    .filter((l) => typeof l.price === 'number' && l.price > 0)
    .map((l) => ({ listing: l, words: significantWords(l.title) }));

  const clusters = []; // { words: Set (union), items: [{listing, words}] }
  for (const entry of withWords) {
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
      // Garde uniquement les mots communs pour eviter la derive du cluster au fil des ajouts
      bestCluster.words = new Set([...bestCluster.words].filter((w) => entry.words.has(w)));
    } else {
      clusters.push({ words: new Set(entry.words), items: [entry] });
    }
  }

  const result = new Map(); // listingId -> { marketPrice, sampleSize }
  for (const cluster of clusters) {
    const clusterListings = cluster.items.map((i) => i.listing);
    if (clusterListings.length < minSampleSize) {
      for (const listing of clusterListings) result.set(listing.listingId, { marketPrice: null, sampleSize: clusterListings.length });
      continue;
    }
    const { marketPrice, sampleSize } = getMarketPriceFromListings(clusterListings);
    for (const listing of clusterListings) result.set(listing.listingId, { marketPrice, sampleSize });
  }
  return result;
}

module.exports = { getMarketPriceFromListings, getGroupedMarketPrices, significantWords, jaccardSimilarity };
