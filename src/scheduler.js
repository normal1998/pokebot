const cron = require('node-cron');
const { searchActiveListings } = require('./ebayService');
const { getGroupedMarketPrices } = require('./priceReference');
const { evaluateListing } = require('./profitability');
const { notifyDeal } = require('./notifier');
const storage = require('./storage');

async function scanWatch(watch) {
  try {
    // Veille large (aucun nom de carte precis) : on recupere plus d'annonces
    // car elles couvrent des cartes tres differentes.
    const isBroadWatch = !watch.cardName && !watch.setName;
    const listings = await searchActiveListings(watch, { limit: isBroadWatch ? 200 : 50 });
    console.log(`[SCAN] "${watch.cardName || watch.grader || 'toutes cartes'}" -> ${listings.length} annonce(s) trouvee(s) sur eBay`);
    if (!listings.length) return;

    const threshold = watch.thresholdPercent || storage.getConfig().defaultThresholdPercent;
    const marketPrices = getGroupedMarketPrices(listings, { minSampleSize: isBroadWatch ? 3 : 2 });

    for (const listing of listings) {
      if (!listing.price) continue;
      if (storage.hasSeenListing(listing.listingId)) continue;
      storage.markListingSeen(listing.listingId);

      const ref = marketPrices.get(listing.listingId);
      if (!ref || ref.marketPrice === null) continue; // pas assez de comparables, on ne devine pas

      const evaluation = evaluateListing(listing, ref.marketPrice, threshold);
      if (evaluation.isDeal) {
        const deal = storage.addDeal({
          watchId: watch.id,
          listing,
          evaluation,
          marketSampleSize: ref.sampleSize,
        });
        await notifyDeal({ listing, evaluation });
        console.log(`[DEAL] ${listing.title} -> ${evaluation.discountPercent}% sous le marche (echantillon: ${ref.sampleSize})`);
      }
    }
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
