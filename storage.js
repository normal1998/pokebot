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
  // Seuil tres bas par defaut (pas de filtrage cache) : toute annonce moins chere que
  // le prix de reference remonte. C'est a l'utilisateur de decider et de resserrer ce
  // seuil lui-meme via le chat s'il veut etre plus selectif, jamais impose en silence.
  config: { defaultThresholdPercent: Number(process.env.DEAL_THRESHOLD_PERCENT || 5) },
  priceTrackerCache: {},
}).write();

// Migration : les veilles creees avant la correction du bug de traduction FR->EN
// peuvent contenir des noms de Pokemon en francais, invisibles dans les annonces
// eBay (redigees en anglais). On les corrige automatiquement au demarrage.
const FR_TO_EN_POKEMON = {
  dracaufeu: 'Charizard', ronflex: 'Snorlax', leviator: 'Gyarados', 'léviator': 'Gyarados',
  evoli: 'Eevee', 'évoli': 'Eevee', salameche: 'Charmander', 'salamèche': 'Charmander',
  carapuce: 'Squirtle', bulbizarre: 'Bulbasaur', tortank: 'Blastoise', ectoplasma: 'Gengar',
  melofee: 'Clefairy', 'mélofée': 'Clefairy', rondoudou: 'Jigglypuff', aquali: 'Vaporeon',
  voltali: 'Jolteon', pyroli: 'Flareon', flagadoss: 'Slowbro', minidraco: 'Dratini',
  draco: 'Dragonair', dracolosse: 'Dragonite', ptera: 'Aerodactyl', 'ptéra': 'Aerodactyl',
  sulfura: 'Moltres', electhor: 'Zapdos', artikodin: 'Articuno',
};
(function migrateFrenchCardNames() {
  const watches = db.get('watches').value();
  let changed = false;
  watches.forEach((w) => {
    if (w.cardName) {
      const translated = FR_TO_EN_POKEMON[w.cardName.toLowerCase()];
      if (translated) {
        db.get('watches').find({ id: w.id }).assign({ cardName: translated }).write();
        changed = true;
      }
    }
  });
  if (changed) console.log('[MIGRATION] Noms de cartes francais traduits en anglais pour la recherche eBay.');
})();

// Migration ponctuelle : une version anterieure du bot marquait TOUTES les annonces
// scannees comme "deja vues", meme celles qui n'etaient pas des affaires, ce qui
// bloquait silencieusement leur re-evaluation pour toujours. On repart sur une liste
// propre une seule fois pour purger cet etat corrompu.
(function resetCorruptedSeenList() {
  const config = db.get('config').value();
  if (!config.seenListResetDone) {
    const before = db.get('seenListingIds').value().length;
    db.set('seenListingIds', []).write();
    db.get('config').assign({ seenListResetDone: true }).write();
    console.log(`[MIGRATION] Liste des annonces "deja vues" reinitialisee (${before} entrees corrompues supprimees).`);
  }
})();

// Migration ponctuelle : vide le cache PokemonPriceTracker une fois, pour que les premiers
// resultats "negatifs" mis en cache avant l'activation des logs de diagnostic soient retentes.
(function resetPriceTrackerCacheOnce() {
  const config = db.get('config').value();
  if (!config.priceTrackerCacheResetDone) {
    db.set('priceTrackerCache', {}).write();
    db.get('config').assign({ priceTrackerCacheResetDone: true }).write();
    console.log('[MIGRATION] Cache PokemonPriceTracker reinitialise.');
  }
})();

function getConfig() {
  return db.get('config').value();
}

// Cache des reponses de l'API PokemonPriceTracker (par carte+grade+grader), pour eviter de
// re-consommer des credits a chaque scan (toutes les 15 min) pour la meme carte. Valable 24h.
function getPriceTrackerCache(key) {
  const safeKey = key.replace(/\./g, '_');
  const entry = db.get('priceTrackerCache').get(safeKey).value();
  if (!entry) return undefined;
  const ageMs = Date.now() - new Date(entry.fetchedAt).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) return undefined; // perime
  return entry.value;
}

function setPriceTrackerCache(key, value) {
  const safeKey = key.replace(/\./g, '_');
  db.get('priceTrackerCache').set(safeKey, { value, fetchedAt: new Date().toISOString() }).write();
}

// Compteur journalier d'appels a l'API PokemonPriceTracker (quota gratuit : 100/jour).
// Sert a autoriser un usage LIMITE et control de cette API meme pour les veilles larges
// ("toutes cartes"), qui sinon n'y avaient jamais acces (trop d'annonces a verifier).
// Se reinitialise automatiquement chaque jour (cle = date du jour).
function getPriceTrackerCallsToday() {
  const today = new Date().toISOString().slice(0, 10);
  const rec = db.get('config').get('priceTrackerUsage').value();
  if (!rec || rec.date !== today) return 0;
  return rec.count;
}

function incrementPriceTrackerCallsToday() {
  const today = new Date().toISOString().slice(0, 10);
  const rec = db.get('config').get('priceTrackerUsage').value();
  const count = (rec && rec.date === today) ? rec.count + 1 : 1;
  db.get('config').assign({ priceTrackerUsage: { date: today, count } }).write();
  return count;
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

function removeDeal(id) {
  db.get('deals').remove({ id }).write();
}

function clearAllDeals() {
  db.set('deals', []).write();
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
  removeDeal,
  clearAllDeals,
  getConfig,
  getPriceTrackerCache,
  setPriceTrackerCache,
  getPriceTrackerCallsToday,
  incrementPriceTrackerCallsToday,
  setDefaultThreshold,
  setScanStatus,
};
