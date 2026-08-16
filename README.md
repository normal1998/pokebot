# PokeBot — Veille de cartes Pokémon gradées sur eBay

Bot de veille + calcul de rentabilité, pilotable entièrement en langage naturel via une interface web de type chat.

## Ce que fait le bot

1. Toutes les X minutes (réglable), interroge l'API eBay pour chaque "veille" active.
2. Estime le prix marché de la carte (médiane des annonces actives comparables).
3. Calcule la décote et le ROI potentiel si revente.
4. Si l'annonce est en dessous du seuil défini, l'enregistre et envoie une alerte (email et/ou Telegram).
5. Tu pilotes tout ça en écrivant des phrases dans l'interface web ("cherche des Pikachu VMAX CGC 9.5 sous 80€", "mets en pause la veille Dracaufeu", "baisse le seuil à 15%"...).

## Ce qu'il te faut avant de démarrer

| Élément | Obligatoire ? | Où l'obtenir |
|---|---|---|
| Clés eBay (App ID + Cert ID, environnement **Production**) | Oui | developer.ebay.com — en cours pour toi |
| Clé API Anthropic (pour comprendre le langage naturel) | Oui | console.anthropic.com |
| Adresse email + mot de passe d'application SMTP | Optionnel (alerte email) | Gmail : compte Google > Sécurité > Mots de passe des applications |
| Bot Telegram (token) | Optionnel (alerte Telegram) | Parler à @BotFather sur Telegram, taper /newbot |

## Configuration

1. Copie `.env.example` en `.env`.
2. Remplis les valeurs au fur et à mesure que tu les obtiens.
3. Installe les dépendances : `npm install`
4. Lance en local pour tester : `npm start`
5. Ouvre `http://localhost:3000`

## Déploiement en continu (recommandé : Railway)

Pour que le bot tourne 24/7 (pas seulement quand ton ordinateur est allumé) :

1. Pousse ce dossier dans un repo GitHub (privé de préférence, il contiendra des indices sur ta config même si les vraies clés restent dans les variables d'environnement Railway, jamais dans le code).
2. Sur Railway, crée un nouveau service à partir de ce repo.
3. Dans l'onglet "Variables" du service Railway, ajoute toutes les variables de `.env.example` avec tes vraies valeurs.
4. Railway détecte automatiquement `npm start` et déploie.
5. Une fois déployé, Railway te donne une URL publique (ex: `pokebot-production.up.railway.app`) : c'est ton interface web, accessible depuis ton téléphone aussi.

## Limites importantes à connaître

- **Prix marché estimé, pas garanti** : faute d'accès à l'API "Marketplace Insights" d'eBay (accès sur demande, non garanti), le bot utilise la médiane des annonces actives comparables comme approximation du marché. C'est fiable pour les cartes liquides (beaucoup d'annonces), moins pour les cartes rares avec peu d'offres.
- **Catégorie eBay** : le filtre de catégorie dans `ebayService.js` (`category_ids`) peut nécessiter un ajustement selon le marketplace eBay (FR/US/etc). Vérifiable et modifiable facilement.
- **Un seul site pour l'instant (eBay)** : c'est la seule source avec une API officielle stable. Étendre à Cardmarket ou d'autres sites nécessiterait du scraping, plus fragile et à la légalité incertaine — à évaluer au cas par cas si tu veux qu'on l'ajoute plus tard.

## Structure du projet

```
pokebot/
├── src/
│   ├── server.js         → serveur web + API + logique de chat
│   ├── ebayService.js    → connexion à l'API eBay
│   ├── priceReference.js → estimation du prix marché
│   ├── profitability.js  → calcul de rentabilité
│   ├── nlCommand.js       → interprétation du langage naturel (Claude)
│   ├── notifier.js        → envoi des alertes email/Telegram
│   ├── scheduler.js       → planification des scans
│   └── storage.js         → stockage des veilles et affaires trouvées
├── public/
│   └── index.html         → interface web (chat + tableau de bord)
├── data/db.json            → base de données locale (créée automatiquement)
├── .env.example
└── package.json
```
