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
    const marketPrices = getGroupedMarketPrices(listings, { minSampleSize: 3 });
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
      if (!ref || ref.marketPrice === null) continue; // pas assez de comparables, on ne devine pas

      const evaluation = evaluateListing(listing, ref.marketPrice, threshold);
      if (bestDiscount === null || evaluation.discountPercent > bestDiscount) bestDiscount = evaluation.discountPercent;
      if (evaluation.isDeal && !alreadyAlerted) {
        // Avant d'alerter, on valide (si la cle API est configuree) le prix marche
        // aupres d'une source officielle specialisee (vraies ventes eBay par grade exact),
        // plus fiable que notre estimation "maison". On ne fait cet appel QUE pour les
        // candidats deja reperes comme affaires, pour rester dans le quota gratuit.
        let finalEvaluation = evaluation;
        let priceHistory = [];
        let officialSource = false;

        if (priceTracker.isConfigured()) {
          try {
            const official = await priceTracker.getOfficialPriceForListing(listing, ref.grader, ref.grade);
            if (official && official.officialMarketPrice) {
              const revaluated = evaluateListing(listing, official.officialMarketPrice, threshold);
              if (!revaluated.isDeal) {
                // La source officielle dit que ce n'est finalement pas une bonne affaire :
                // on fait confiance a la source officielle et on n'alerte pas.
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
          marketSampleSize: ref.sampleSize,
          comparablePrices: ref.comparablePrices || [],
          priceHistory,
          officialSource,
          detectedGrader: ref.grader,
          detectedGrade: ref.grade,
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
