const cron = require('node-cron');
const { searchActiveListings } = require('./ebayService');
const { getGroupedMarketPrices } = require('./priceReference');
const { evaluateListing } = require('./profitability');
const { notifyDeal } = require('./notifier');
const priceTracker = require('./priceTrackerService');
const storage = require('./storage');

async function scanWatch(watch) {
  try {
    // Veille large (aucun nom de carte precis) : on recupere plus d'annonces
    // car elles couvrent des cartes tres differentes. On agrege 2 pages (jusqu'a 400
    // annonces) pour augmenter les chances d'avoir plusieurs exemplaires de la meme carte
    // a comparer entre eux (necessaire pour evaluer une decote de facon fiable).
    const isBroadWatch = !watch.cardName && !watch.setName;
    let listings = await searchActiveListings(watch, { limit: isBroadWatch ? 200 : 50 });
    if (isBroadWatch) {
      const secondPage = await searchActiveListings(watch, { limit: 200, offset: 200 });
      listings = listings.concat(secondPage);
    }
    console.log(`[SCAN] "${watch.cardName || watch.grader || 'toutes cartes'}" -> ${listings.length} annonce(s) trouvee(s) sur eBay`);
    if (!listings.length) return;

    const threshold = watch.thresholdPercent || storage.getConfig().defaultThresholdPercent;
    // minSampleSize a 3 : avec le grade et le grader desormais stricts (jamais melanges),
    // 3 annonces vraiment comparables donnent un prix de reference fiable.
    // Pour une veille ciblee (carte precise), le volume d'annonces est naturellement plus
    // faible qu'une veille large : 2 annonces vraiment comparables suffisent a estimer un
    // prix de reference correct. Pour une veille large, on garde 3 (plus de marge d'erreur
    // possible avec le regroupement par similarite de titre sur un gros volume).
    const marketPrices = getGroupedMarketPrices(listings, { minSampleSize: isBroadWatch ? 3 : 2 });
    const groupsWithPrice = [...marketPrices.values()].filter(v => v.marketPrice !== null).length;
    console.log(`[SCAN] -> ${groupsWithPrice}/${listings.length} annonce(s) avaient assez de comparables pour etre evaluees`);

    let bestDiscount = null;

    for (const listing of listings) {
      if (!listing.price) continue;
      // On ne marque "vu" que les annonces qui ONT declenche une alerte (pour ne pas
      // re-alerter deux fois sur la meme affaire). Les annonces qui n'etaient pas des
      // affaires restent re-evaluables aux scans suivants, notamment si le seuil change.
      const alreadyAlerted = storage.hasSeenListing(listing.listingId);

      const ref = marketPrices.get(listing.listingId);
      let marketPrice = ref ? ref.marketPrice : null;
      let sampleSize = ref ? ref.sampleSize : 0;
      let comparablePrices = ref ? ref.comparablePrices || [] : [];
      let officialSource = false;
      let priceHistory = [];

      // Cas frequent sur une veille ciblee (carte precise) : pas assez d'annonces eBay
      // similaires pour estimer un prix "maison" fiable. Dans ce cas, si la cle API est
      // configuree, on interroge directement la source officielle pour CETTE carte —
      // elle n'a pas besoin de plusieurs annonces eBay actives, elle a sa propre base de
      // ventes passees. Mise en cache 24h par carte+grade pour ne pas gaspiller le quota
      // gratuit (100 requetes/jour) sur les memes cartes scannees toutes les 15 minutes.
      if ((!marketPrice || sampleSize < 2) && !isBroadWatch && priceTracker.isConfigured()) {
        const detectedGrader = ref?.grader;
        const detectedGrade = ref?.grade;
        const cacheKey = `${(watch.cardName || '').toLowerCase()}|${detectedGrader || '?'}|${detectedGrade || '?'}`;
        let official = storage.getPriceTrackerCache(cacheKey);
        if (official === undefined) {
          official = await priceTracker.getOfficialPriceForListing(listing, detectedGrader, detectedGrade);
          storage.setPriceTrackerCache(cacheKey, official || null);
          console.log(`[PRICETRACKER] "${listing.title}" (grader detecte: ${detectedGrader || 'aucun'}, grade detecte: ${detectedGrade || 'aucun'}) -> ${official ? 'prix trouve: ' + official.officialMarketPrice + '€' : 'pas de correspondance ou pas de donnees pour ce grade'}`);
        }
        if (official && official.officialMarketPrice) {
          marketPrice = official.officialMarketPrice;
          sampleSize = official.salesCount || 1;
          priceHistory = official.priceHistory || [];
          officialSource = true;
        }
      }

      if (!marketPrice) continue; // toujours pas assez d'information, on ne devine pas

      const evaluation = evaluateListing(listing, marketPrice, threshold);
      if (bestDiscount === null || evaluation.discountPercent > bestDiscount) bestDiscount = evaluation.discountPercent;
      if (evaluation.isDeal && !alreadyAlerted) {
        // Si on n'a pas encore de validation officielle (deal trouve via l'estimation locale
        // sur une veille large par ex.), on tente une derniere validation avant d'alerter.
        let finalEvaluation = evaluation;
        if (!officialSource && priceTracker.isConfigured()) {
          try {
            const official = await priceTracker.getOfficialPriceForListing(listing, ref?.grader, ref?.grade);
            if (official && official.officialMarketPrice) {
              const revaluated = evaluateListing(listing, official.officialMarketPrice, threshold);
              if (!revaluated.isDeal) {
                storage.markListingSeen(listing.listingId);
                continue;
              }
              finalEvaluation = revaluated;
              priceHistory = official.priceHistory || [];
              officialSource = true;
            }
          } catch (e) {
            console.error('Validation prix officiel echouee, on garde l\'estimation locale:', e.message);
          }
        }

        storage.markListingSeen(listing.listingId);
        const deal = storage.addDeal({
          watchId: watch.id,
          watchLabel: watch.cardName || (watch.grader ? 'Toutes cartes ' + watch.grader : 'Toutes cartes gradees'),
          listing,
          evaluation: finalEvaluation,
          marketSampleSize: sampleSize,
          comparablePrices,
          priceHistory,
          officialSource,
          detectedGrader: ref?.grader,
          detectedGrade: ref?.grade,
          isAuction: Boolean(listing.isAuction),
        });
        await notifyDeal({ listing, evaluation: finalEvaluation });
        console.log(`[DEAL] ${listing.title} -> ${finalEvaluation.discountPercent}% sous le marche (${officialSource ? 'source officielle' : 'estimation locale'})`);
      }
    }
    console.log(`[SCAN] -> meilleure decote trouvee ce scan : ${bestDiscount !== null ? bestDiscount + '%' : 'aucune (0 annonce evaluable)'} (seuil requis: ${threshold}%)`);
  } catch (err) {
    console.error(`Erreur lors du scan de la veille "${watch.cardName || 'toutes cartes'}":`, err.message);
    throw err;
  }
}

async function scanAllWatches() {
  const watches = storage.listWatches().filter((w) => w.active);
  console.log(`Scan de ${watches.length} veille(s) actives...`);
  let firstError = null;
  for (const watch of watches) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await scanWatch(watch);
    } catch (err) {
      firstError = firstError || err.message;
    }
  }
  storage.setScanStatus({ error: firstError });
}

function startScheduler() {
  const intervalMinutes = Number(process.env.SCAN_INTERVAL_MINUTES || 15);
  const cronExpr = `*/${intervalMinutes} * * * *`;
  console.log(`Planificateur demarre : scan toutes les ${intervalMinutes} minutes.`);
  cron.schedule(cronExpr, scanAllWatches);
  // Premier scan immediat au demarrage
  scanAllWatches();
}

module.exports = { startScheduler, scanAllWatches, scanWatch };
