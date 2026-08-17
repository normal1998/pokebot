// Traduit une phrase en francais (ou autre langue) tapee par l'utilisateur
// en une action structuree que le bot peut executer (ajouter une veille,
// la supprimer, changer le seuil de rentabilite, etc.)
// Utilise l'API Claude (Anthropic) avec "tool use" pour forcer une sortie structuree fiable.

const fetch = require('node-fetch');

const TOOLS = [
  {
    name: 'add_watch',
    description: "Ajoute une nouvelle veille (recherche automatique) de cartes Pokemon gradees sur eBay.",
    input_schema: {
      type: 'object',
      properties: {
        cardName: { type: 'string', description: "Nom du Pokemon/de la carte si l'utilisateur en cite un precis, ex: 'Dracaufeu'. Laisser VIDE si l'utilisateur veut surveiller TOUTES les cartes gradees sans distinction (ex: 'trouve-moi n'importe quelle carte gradee pas chere')." },
        setName: { type: 'string', description: "Nom du set/extension si precise, sinon vide" },
        grader: { type: 'string', description: "Organisme de gradation: PSA, BGS, CGC, ACE, SGC, ou vide si indifferent" },
        grade: { type: 'string', description: "Note minimale ou exacte recherchee, ex: '9', '10', '9-10'" },
        maxPrice: { type: 'number', description: "Budget maximum en euros, 0 si non precise" },
        thresholdPercent: { type: 'number', description: "Seuil de decote (%) sous le prix marche pour declencher une alerte SI l'utilisateur en precise un dans sa demande (ex: 'decote d'au moins 5%', 'seuil a 10%'). Laisser vide/absent si non precise, le seuil par defaut sera utilise." },
      },
      required: [],
    },
  },
  {
    name: 'remove_watch',
    description: "Supprime une veille existante d'apres une description approximative.",
    input_schema: {
      type: 'object',
      properties: {
        matchDescription: { type: 'string', description: "Description permettant d'identifier la veille a supprimer" },
      },
      required: ['matchDescription'],
    },
  },
  {
    name: 'pause_watch',
    description: 'Met en pause ou reactive une veille existante.',
    input_schema: {
      type: 'object',
      properties: {
        matchDescription: { type: 'string' },
        active: { type: 'boolean', description: 'true pour reactiver, false pour mettre en pause' },
      },
      required: ['matchDescription', 'active'],
    },
  },
  {
    name: 'update_threshold',
    description: "Change le seuil de decote (%) en dessous du prix marche a partir duquel une annonce est consideree comme une bonne affaire, pour une veille donnee ou globalement.",
    input_schema: {
      type: 'object',
      properties: {
        matchDescription: { type: 'string', description: "vide si le changement est global" },
        thresholdPercent: { type: 'number' },
      },
      required: ['thresholdPercent'],
    },
  },
  {
    name: 'list_watches',
    description: 'Liste les veilles actuellement configurees. A utiliser si l\'utilisateur demande un recapitulatif.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'clarify',
    description: "A utiliser si la demande de l'utilisateur est ambigue et qu'il faut lui poser une question avant d'agir.",
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
];

async function interpretCommand(userText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquant.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: "Tu es l'assistant d'un bot de veille de cartes Pokemon gradees sur eBay. "
        + "Traduis la demande de l'utilisateur en UN SEUL appel d'outil approprie. "
        + "Si l'utilisateur donne plusieurs criteres en une phrase, capture-les tous dans les parametres. "
        + "IMPORTANT: les annonces eBay sont redigees en tres grande majorite en ANGLAIS, meme sur eBay France. "
        + "Si l'utilisateur donne un nom de Pokemon en francais (ex: Dracaufeu, Ronflex, Leviator, Evoli, "
        + "Salameche, Carapuce, Bulbizarre, Tortank, Ectoplasma, Melofee), tu DOIS mettre le nom ANGLAIS "
        + "officiel du Pokemon dans cardName (ex: Charizard, Snorlax, Gyarados, Eevee, Charmander, Squirtle, "
        + "Bulbasaur, Blastoise, Gengar, Clefairy), pas le nom francais, sinon la recherche eBay ne trouvera rien. "
        + "Si l'utilisateur ne precise pas de grade ou de grader, laisse le champ vide (n'invente rien) "
        + "et cree la veille quand meme avec ce qui est donne — NE POSE PAS de question, un champ vide "
        + "signifie juste 'indifferent'. Si l'utilisateur tape juste un nom de Pokemon seul (ex: 'Gengar', "
        + "'Mewtwo'), c'est une demande d'ajout de veille pour ce Pokemon, gradee, sans autre precision : "
        + "utilise add_watch directement avec ce nom, ne demande pas de precisions supplementaires. "
        + "N'utilise clarify QUE si le message est vraiment incomprehensible ou hors-sujet (pas juste incomplet). "
        + "Si l'utilisateur veut surveiller TOUTES les cartes gradees sans viser un Pokemon precis "
        + "(ex: 'trouve-moi des pepites', 'n'importe quelle carte gradee pas chere', 'toutes les cartes gradees'), "
        + "laisse cardName VIDE plutot que d'inventer un nom de carte.",
      messages: [{ role: 'user', content: userText }],
      tools: TOOLS,
      tool_choice: { type: 'any' },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Erreur API Claude (${res.status}): ${text}`);
  }

  const data = await res.json();
  const toolUse = data.content.find((c) => c.type === 'tool_use');
  if (!toolUse) {
    const textBlock = data.content.find((c) => c.type === 'text');
    return { action: 'clarify', input: { question: textBlock ? textBlock.text : "Je n'ai pas compris la demande." } };
  }
  return { action: toolUse.name, input: toolUse.input };
}

module.exports = { interpretCommand };
