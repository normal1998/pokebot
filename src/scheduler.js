const cron = require('node-cron');
const { searchActiveListings } = require('./ebayService');
const { getGroupedMarketPrices } = require('./priceReference');
const { evaluateListing } = require('./profitability');
const { notifyDeal } = require('./notifier');
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
    // minSampleSize a 2 (au lieu de 3) : deux annonces quasi-identiques suffisent pour
    // estimer un prix de reference fiable, surtout utile sur les veilles larges ou les
    // doublons exacts d'une meme carte sont rares dans un echantillon divers.
    const marketPrices = getGroupedMarketPrices(listings, { minSampleSize: 2 });
    const groupsWithPrice = [...marketPrices.values()].filter(v => v.marketPrice !== null).length;
    console.log(`[SCAN] -> ${groupsWithPrice}/${listings.length} annonce(s) avaient assez de comparables pour etre evaluees`);

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
