// Stockage simple sur fichier JSON (pas besoin de base de donnees externe).
// Contient : les criteres de veille (watches) et l'historique des affaires trouvees (deals).
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const adapter = new FileSync(path.join(__dirname, '..', 'data', 'db.json'));
const db = low(adapter);

db.defaults({
  watches: [],
  deals: [],
  seenListingIds: [],
  config: { defaultThresholdPercent: Number(process.env.DEAL_THRESHOLD_PERCENT || 30) },
}).write();

function getConfig() {
  return db.get('config').value();
}

function setDefaultThreshold(thresholdPercent) {
  db.get('config').assign({ defaultThresholdPercent: thresholdPercent }).write();
}

function setScanStatus({ error = null, at = new Date().toISOString() } = {}) {
  db.get('config').assign({ lastScanAt: at, lastScanError: error }).write();
}

function listWatches() {
  return db.get('watches').value();
}

function addWatch(watch) {
  const record = {
    id: uuidv4(),
    active: true,
    createdAt: new Date().toISOString(),
    ...watch,
  };
  db.get('watches').push(record).write();
  return record;
}

function removeWatch(id) {
  db.get('watches').remove({ id }).write();
}

function setWatchActive(id, active) {
  db.get('watches').find({ id }).assign({ active }).write();
}

function updateWatch(id, changes) {
  db.get('watches').find({ id }).assign(changes).write();
  return db.get('watches').find({ id }).value();
}

function hasSeenListing(listingId) {
  return db.get('seenListingIds').includes(listingId).value();
}

function markListingSeen(listingId) {
  db.get('seenListingIds').push(listingId).write();
  // Garde uniquement les 5000 derniers ids pour ne pas grossir indefiniment
  const all = db.get('seenListingIds').value();
  if (all.length > 5000) {
    db.set('seenListingIds', all.slice(all.length - 5000)).write();
  }
}

function addDeal(deal) {
  const record = {
    id: uuidv4(),
    foundAt: new Date().toISOString(),
    ...deal,
  };
  db.get('deals').push(record).write();
  return record;
}

function listDeals(limit = 100) {
  return db.get('deals').orderBy(['foundAt'], ['desc']).take(limit).value();
}

module.exports = {
  db,
  listWatches,
  addWatch,
  removeWatch,
  setWatchActive,
  updateWatch,
  hasSeenListing,
  markListingSeen,
  addDeal,
  listDeals,
  getConfig,
  setDefaultThreshold,
  setScanStatus,
};
