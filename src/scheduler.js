const cron = require('node-cron');
const { searchActiveListings } = require('./ebayService');
const { getGroupedMarketPrices } = require('./priceReference');
const { evaluateListing } = require('./profitability');
const { notifyDeal } = require('./notifier');
const priceTracker = require('./priceTrackerService');
const storage = require('./storage');

const MAX_PRICETRACKER_CALLS_PER_DAY = 90;
const MAX_BROAD_PRICETRACKER_CALLS_PER_SCAN = 8;

async function scanWatch(watch) {
  try {
    const isBroadWatch = !watch.cardName && !watch.setName;
    let listings = await searchActiveListings(watch, { limit: isBroadWatch ? 200 : 50 });
    if (isBroadWatch) {
      const secondPage = await searchActiveListings(watch, { limit: 200, offset: 200 });
      listings = listings.concat(secondPage);
    }
    console.log(`[SCAN] "${watch.cardName || watch.grader || 'toutes cartes'}" -> ${listings.length} annonce(s) trouvee(s) sur eBay`);
    if (!listings.length) return;

    const threshold = (watch.thresholdPercent !== null && watch.thresholdPercent !== undefined)
      ? watch.thresholdPercent
      : storage.getConfig().defaultThresholdPercent;
    const marketPrices = getGroupedMarketPrices(listings, { minSampleSize: 2 });
    const groupsWithPrice = [...marketPrices.values()].filter(v => v.marketPrice !== null).length;
    console.log(`[SCAN] -> ${groupsWithPrice}/${listings.length} annonce(s) avaient assez de comparables pour etre evaluees`);

    // DIAGNOSTIC TEMPORAIRE : on veut comprendre pourquoi le grader/grade n'est pas
    // detecte sur la majorite des annonces. On log un echantillon de titres reels
    // avec ce qui a ete detecte (ou pas), pour ajuster la detection si besoin.
    // A retirer une fois le probleme identifie.
    const sample = listings.slice(0, 8);
    for (const l of sample) {
      const ref = marketPrices.get(l.listingId);
      console.log(`[DIAG] "${l.title}" | condition eBay: ${l.condition} | officialGrader: ${l.officialGrader || 'aucun'} | officialGrade: ${l.officialGrade || 'aucun'} | grader detecte: ${ref?.grader || 'AUCUN'} | grade detecte: ${ref?.grade || 'AUCUN'}`);
    }

    let bestDiscount = null;
    let evaluatedCount = 0;
    let broadWatchCallsThisScan = 0;

    for (const listing of listings) {
      if (!listing.price) continue;
      const alreadyAlerted = storage.hasSeenListing(listing.listingId);

      const ref = marketPrices.get(listing.listingId);

      if (!ref || !ref.grader) continue;

      let marketPrice = ref.grade ? ref.marketPrice : null;
      let sampleSize = ref.grade ? ref.sampleSize : 0;
      let comparablePrices = ref.grade ? (ref.comparablePrices || []) : [];
      let officialSource = false;
      let priceHistory = [];

      const dailyCallsUsed = storage.getPriceTrackerCallsToday();
      const canUseBroadBudget = isBroadWatch
        && broadWatchCallsThisScan < MAX_BROAD_PRICETRACKER_CALLS_PER_SCAN
        && dailyCallsUsed < MAX_PRICETRACKER_CALLS_PER_DAY;
      if ((!marketPrice || sampleSize < 2) && (!isBroadWatch || canUseBroadBudget) && priceTracker.isConfigured()) {
        const detectedGrader = ref?.grader;
        const detectedGrade = ref?.grade;
        const cacheKey = isBroadWatch
          ? `listing|${listing.listingId}`
          : `${(watch.cardName || '').toLowerCase()}|${detectedGrader || '?'}|${detectedGrade || '?'}`;
        let official = storage.getPriceTrackerCache(cacheKey);
        if (official === undefined) {
          official = await priceTracker.getOfficialPriceForListing(listing, detectedGrader, detectedGrade);
          storage.setPriceTrackerCache(cacheKey, official || null);
          storage.incrementPriceTrackerCallsToday();
          if (isBroadWatch) broadWatchCallsThisScan += 1;
          console.log(`[PRICETRACKER] "${listing.title}" (grader detecte: ${detectedGrader || 'aucun'}, grade detecte: ${detectedGrade || 'aucun'}) -> ${official ? 'prix trouve: ' + official.officialMarketPrice + '€' : 'pas de correspondance ou pas de donnees pour ce grade'}`);
        }
        if (official && official.officialMarketPrice) {
          marketPrice = official.officialMarketPrice;
          sampleSize = official.salesCount || 1;
          priceHistory = official.priceHistory || [];
          officialSource = true;
        }
      }

      if (!marketPrice) continue;

      evaluatedCount += 1;
      const evaluation = evaluateListing(listing, marketPrice, threshold);
      if (bestDiscount === null || evaluation.discountPercent > bestDiscount) bestDiscount = evaluation.discountPercent;
      if (evaluation.isDeal && !alreadyAlerted) {
        let finalEvaluation = evaluation;
        if (!officialSource && priceTracker.isConfigured()) {
          try {
            const listingCacheKey = `listing|${listing.listingId}`;
            let official = storage.getPriceTrackerCache(listingCacheKey);
            if (official === undefined) {
              official = await priceTracker.getOfficialPriceForListing(listing, ref?.grader, ref?.grade);
              storage.setPriceTrackerCache(listingCacheKey, official || null);
              storage.incrementPriceTrackerCallsToday();
            }
            if (official && official.officialMarketPrice) {
              const revaluated = evaluateListing(listing, official.officialMarketPrice, threshold);
              if (!revaluated.isDeal) {
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
    console.log(`[SCAN] -> ${evaluatedCount} annonce(s) reellement evaluee(s) avec un prix de reference (local ou officiel)`);
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
  scanAllWatches();
}

module.exports = { startScheduler, scanAllWatches, scanWatch };
