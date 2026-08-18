require('dotenv').config();
const express = require('express');
const path = require('path');
const storage = require('./storage');
const { interpretCommand } = require('./nlCommand');
const { startScheduler, scanAllWatches } = require('./scheduler');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => {
    // Empeche le navigateur de garder une vieille version de l'interface en cache,
    // ce qui a cause plusieurs faux "bugs" pendant le developpement.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  },
}));

function findWatchByDescription(desc) {
  const watches = storage.listWatches();
  if (!watches.length) return null;
  if (watches.length === 1 && !desc) return watches[0];
  const lower = (desc || '').toLowerCase();
  return watches.find((w) => {
    const haystack = `${w.cardName} ${w.setName || ''} ${w.grader || ''} ${w.grade || ''}`.toLowerCase();
    return haystack.includes(lower) || lower.includes((w.cardName || '').toLowerCase());
  });
}

app.get('/api/watches', (req, res) => {
  res.json(storage.listWatches());
});

// Suppression directe d'une veille depuis l'interface (bouton, pas besoin de passer par le chat)
app.delete('/api/watches/:id', (req, res) => {
  storage.removeWatch(req.params.id);
  res.json({ ok: true, watches: storage.listWatches() });
});

// Etat de sante du bot : quelles cles sont configurees, dernier scan, etc.
// N'expose jamais les valeurs des cles, seulement si elles sont presentes.
app.get('/api/status', (req, res) => {
  const config = storage.getConfig();
  res.json({
    ebayConfigured: Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET),
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    emailConfigured: Boolean(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ALERT_EMAIL_TO),
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    schedulerRunning: Boolean(process.env.EBAY_CLIENT_ID && process.env.ANTHROPIC_API_KEY),
    scanIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 15),
    defaultThresholdPercent: config.defaultThresholdPercent,
    lastScanAt: config.lastScanAt || null,
    lastScanError: config.lastScanError || null,
  });
});

// Health check simple pour Railway / monitoring
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/deals', (req, res) => {
  res.json(storage.listDeals(200));
});

// Suppression d'une seule affaire detectee (bouton individuel)
app.delete('/api/deals/:id', (req, res) => {
  storage.removeDeal(req.params.id);
  res.json({ ok: true, deals: storage.listDeals(200) });
});

// Suppression de toutes les affaires detectees d'un coup
app.delete('/api/deals', (req, res) => {
  storage.clearAllDeals();
  res.json({ ok: true, deals: [] });
});

app.post('/api/scan-now', async (req, res) => {
  await scanAllWatches();
  res.json({ ok: true });
});

// Point d'entree principal : l'utilisateur ecrit en langage naturel, le bot agit.
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message manquant' });

  try {
    const { action, input } = await interpretCommand(message);
    let reply;

    switch (action) {
      case 'add_watch': {
        // Evite les doublons : si une veille quasi-identique existe deja, on la reactive
        // plutot que d'en creer une nouvelle qui ferait double emploi.
        const normalizedNew = `${(input.cardName || '').toLowerCase()}|${(input.setName || '').toLowerCase()}|${(input.grader || '').toLowerCase()}|${(input.grade || '').toLowerCase()}`;
        const existing = storage.listWatches().find((w) => {
          const normalizedExisting = `${(w.cardName || '').toLowerCase()}|${(w.setName || '').toLowerCase()}|${(w.grader || '').toLowerCase()}|${(w.grade || '').toLowerCase()}`;
          return normalizedExisting === normalizedNew;
        });

        if (existing) {
          if (!existing.active) storage.setWatchActive(existing.id, true);
          if (input.maxPrice) storage.updateWatch(existing.id, { maxPrice: input.maxPrice });
          if (input.thresholdPercent) storage.updateWatch(existing.id, { thresholdPercent: input.thresholdPercent });
          reply = `Cette veille existe deja (${existing.cardName || 'toutes cartes gradees'}${existing.grader ? ' ' + existing.grader : ''}) — je l'ai reactivee${input.maxPrice ? ' et mis a jour le budget' : ''}${input.thresholdPercent ? ' (seuil ' + input.thresholdPercent + '%)' : ''} plutot que d'en creer une en double.`;
          break;
        }

        const watch = storage.addWatch({
          cardName: input.cardName || null,
          setName: input.setName || null,
          grader: input.grader || null,
          grade: input.grade || null,
          maxPrice: input.maxPrice || null,
          thresholdPercent: input.thresholdPercent || null,
        });
        reply = watch.cardName
          ? `Nouvelle veille ajoutee : ${watch.cardName}`
            + `${watch.grader ? ' ' + watch.grader : ''}${watch.grade ? ' ' + watch.grade : ''}`
            + `${watch.maxPrice ? ', budget max ' + watch.maxPrice + ' EUR' : ''}`
            + `${watch.thresholdPercent ? ', seuil ' + watch.thresholdPercent + '%' : ''}.`
          : `Veille large ajoutee : toutes les cartes Pokemon gradees`
            + `${watch.grader ? ' ' + watch.grader : ''}${watch.grade ? ' ' + watch.grade : ''}`
            + `${watch.maxPrice ? ', budget max ' + watch.maxPrice + ' EUR' : ''}`
            + `${watch.thresholdPercent ? ', seuil ' + watch.thresholdPercent + '%' : ''}. `
            + `Le bot compare chaque carte a des cartes similaires (jamais a une carte differente) avant de l'evaluer.`;
        break;
      }
      case 'remove_watch': {
        const match = findWatchByDescription(input.matchDescription);
        if (match) {
          storage.removeWatch(match.id);
          reply = `Veille supprimee : ${match.cardName}.`;
        } else {
          reply = "Je n'ai pas trouve de veille correspondante a supprimer.";
        }
        break;
      }
      case 'pause_watch': {
        const match = findWatchByDescription(input.matchDescription);
        if (match) {
          storage.setWatchActive(match.id, input.active);
          reply = `Veille "${match.cardName}" ${input.active ? 'reactivee' : 'mise en pause'}.`;
        } else {
          reply = "Je n'ai pas trouve de veille correspondante.";
        }
        break;
      }
      case 'update_threshold': {
        if (input.matchDescription) {
          const match = findWatchByDescription(input.matchDescription);
          if (match) {
            storage.updateWatch(match.id, { thresholdPercent: input.thresholdPercent });
            reply = `Seuil mis a jour pour "${match.cardName}" : ${input.thresholdPercent}%.`;
          } else {
            reply = "Je n'ai pas trouve de veille correspondante.";
          }
        } else {
          storage.setDefaultThreshold(input.thresholdPercent);
          reply = `Seuil global mis a jour : ${input.thresholdPercent}% sous le prix marche.`;
        }
        break;
      }
      case 'list_watches': {
        const watches = storage.listWatches();
        reply = watches.length
          ? watches.map((w) => `- ${w.cardName || 'Toutes cartes gradees'}${w.grader ? ' ' + w.grader : ''}${w.grade ? ' ' + w.grade : ''}${w.maxPrice ? ', max ' + w.maxPrice + '€' : ''}${w.active ? '' : ' (en pause)'}`).join('\n')
          : 'Aucune veille configuree pour le moment.';
        break;
      }
      case 'check_results': {
        const allDeals = storage.listDeals(500);
        const config = storage.getConfig();

        if (input.matchDescription) {
          const match = findWatchByDescription(input.matchDescription);
          if (!match) {
            reply = "Je n'ai pas trouve de veille correspondante a cette description.";
            break;
          }
          const matchDeals = allDeals.filter((d) => d.watchId === match.id);
          reply = matchDeals.length
            ? `Oui : ${matchDeals.length} affaire(s) trouvee(s) pour "${match.cardName || 'toutes cartes'}${match.grader ? ' ' + match.grader : ''}". La meilleure decote : ${Math.max(...matchDeals.map((d) => d.evaluation.discountPercent))}%.`
            : `Non, rien trouve pour l'instant pour "${match.cardName || 'toutes cartes'}${match.grader ? ' ' + match.grader : ''}". Le bot scanne toutes les ${process.env.SCAN_INTERVAL_MINUTES || 15} minutes, ca peut prendre un peu de temps.`;
        } else {
          const activeWatches = storage.listWatches().filter((w) => w.active);
          reply = allDeals.length
            ? `Oui : ${allDeals.length} affaire(s) trouvee(s) au total, sur ${activeWatches.length} veille(s) active(s). Derniere trouvee : ${allDeals[0] ? allDeals[0].listing.title : ''}.`
            : `Non, rien trouve pour l'instant sur les ${activeWatches.length} veille(s) active(s). ${config.lastScanAt ? 'Dernier scan : ' + new Date(config.lastScanAt).toLocaleTimeString('fr-FR') + '.' : ''}`;
        }
        break;
      }
      case 'clarify':
      default:
        reply = input.question || "Je n'ai pas compris, peux-tu reformuler ?";
    }

    res.json({ reply, action, watches: storage.listWatches() });
  } catch (err) {
    console.error(err);
    if (err.message.includes('ANTHROPIC_API_KEY')) {
      return res.status(500).json({ error: "La clé API Anthropic n'est pas configurée sur le serveur. Ajoute-la dans les variables d'environnement pour activer le chat." });
    }
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PokeBot demarre sur le port ${PORT}`);
  if (process.env.EBAY_CLIENT_ID && process.env.ANTHROPIC_API_KEY) {
    startScheduler();
  } else {
    console.log('Planificateur non demarre : cles EBAY_CLIENT_ID / ANTHROPIC_API_KEY manquantes.');
  }
});
