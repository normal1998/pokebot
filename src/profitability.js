// Calcule si une annonce est une bonne affaire par rapport au prix marche estime,
// en tenant compte des frais (port + une estimation de frais de revente si l'utilisateur revend).

const EBAY_SELLER_FEE_PERCENT = 0.13; // frais moyens vendeur eBay (a ajuster selon categorie)

function evaluateListing(listing, marketPrice, thresholdPercent) {
  const totalCost = listing.price + (listing.shippingCost || 0);
  if (!marketPrice || marketPrice <= 0) {
    return { isDeal: false, reason: 'Prix marche indisponible (echantillon insuffisant)' };
  }

  const discountPercent = ((marketPrice - totalCost) / marketPrice) * 100;

  // Rentabilite estimee si revendu au prix marche, apres frais eBay
  const estimatedResaleNet = marketPrice * (1 - EBAY_SELLER_FEE_PERCENT);
  const estimatedProfit = estimatedResaleNet - totalCost;
  const roiPercent = totalCost > 0 ? (estimatedProfit / totalCost) * 100 : 0;

  // Prix maximum a payer pour rester rentable (= le point ou le profit devient nul).
  // Utile en particulier pour les encheres : sert de plafond a ne pas depasser en enchérissant,
  // frais de port non inclus (a ajouter separement selon le vendeur).
  const maxProfitablePrice = Math.round(estimatedResaleNet * 100) / 100;

  const isDeal = discountPercent >= thresholdPercent;

  return {
    isDeal,
    totalCost: Math.round(totalCost * 100) / 100,
    marketPrice: Math.round(marketPrice * 100) / 100,
    discountPercent: Math.round(discountPercent * 10) / 10,
    estimatedProfit: Math.round(estimatedProfit * 100) / 100,
    roiPercent: Math.round(roiPercent * 10) / 10,
    maxProfitablePrice,
  };
}

module.exports = { evaluateListing };
