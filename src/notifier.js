const nodemailer = require('nodemailer');
let TelegramBot;
try {
  // Chargement optionnel : si le token n'est pas configure, on ne charge pas la lib.
  TelegramBot = require('node-telegram-bot-api');
} catch (e) {
  TelegramBot = null;
}

let mailTransport = null;
function getMailTransport() {
  if (mailTransport) return mailTransport;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return mailTransport;
}

let telegramBot = null;
function getTelegramBot() {
  if (telegramBot) return telegramBot;
  if (!TelegramBot || !process.env.TELEGRAM_BOT_TOKEN) return null;
  telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  return telegramBot;
}

function formatDealMessage(deal) {
  return (
    `Bonne affaire detectee !\n\n`
    + `${deal.listing.title}\n`
    + `Prix: ${deal.evaluation.totalCost} EUR (port inclus)\n`
    + `Prix marche estime: ${deal.evaluation.marketPrice} EUR\n`
    + `Decote: ${deal.evaluation.discountPercent}%\n`
    + `Profit potentiel estime: ${deal.evaluation.estimatedProfit} EUR (ROI ${deal.evaluation.roiPercent}%)\n`
    + `Lien: ${deal.listing.url}`
  );
}

async function notifyDeal(deal) {
  const message = formatDealMessage(deal);
  const results = { email: false, telegram: false };

  const transport = getMailTransport();
  if (transport && process.env.ALERT_EMAIL_TO) {
    try {
      await transport.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.ALERT_EMAIL_TO,
        subject: `[PokeBot] Affaire: ${deal.listing.title}`,
        text: message,
      });
      results.email = true;
    } catch (e) {
      console.error('Erreur envoi email:', e.message);
    }
  }

  const bot = getTelegramBot();
  if (bot && process.env.TELEGRAM_CHAT_ID) {
    try {
      await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
      results.telegram = true;
    } catch (e) {
      console.error('Erreur envoi Telegram:', e.message);
    }
  }

  return results;
}

module.exports = { notifyDeal };
