require('dotenv').config();
const express = require('express');
const path = require('path');
const storage = require('./storage');
const { interpretCommand } = require('./nlCommand');
const { startScheduler, scanAllWatches } = require('./scheduler');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
        const watch = storage.addWatch({
          cardName: input.cardName || null,
          setName: input.setName || null,
          grader: input.grader || null,
          grade: input.grade || null,
          maxPrice: input.maxPrice || null,
          thresholdPercent: null,
        });
        reply = watch.cardName
          ? `Nouvelle veille ajoutee : ${watch.cardName}`
            + `${watch.grader ? ' ' + watch.grader : ''}${watch.grade ? ' ' + watch.grade : ''}`
            + `${watch.maxPrice ? ', budget max ' + watch.maxPrice + ' EUR' : ''}.`
          : `Veille large ajoutee : toutes les cartes Pokemon gradees`
            + `${watch.grader ? ' ' + watch.grader : ''}${watch.grade ? ' ' + watch.grade : ''}`
            + `${watch.maxPrice ? ', budget max ' + watch.maxPrice + ' EUR' : ''}. `
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
          ? watches.map((w) => `- ${w.cardName}${w.grader ? ' ' + w.grader : ''}${w.grade ? ' ' + w.grade : ''}${w.active ? '' : ' (en pause)'}`).join('\n')
          : 'Aucune veille configuree pour le moment.';
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
