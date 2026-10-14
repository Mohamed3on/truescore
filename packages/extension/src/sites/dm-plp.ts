import { setupScoreGrid } from '../shared/score-grid';
import { cardScores, DM } from '../shared/bazaarvoice';

const scoreOf = cardScores(DM);

// dm nests its tiles in a `product-tiles` grid, or falls back to an ol/ul.
const discover = (cards: Element[]) => {
  const containers = new Set<Element>();
  for (const card of cards) {
    const container =
      card.closest('[data-dmid="product-tiles"]') || card.closest('ol') || card.closest('ul');
    if (container) containers.add(container);
  }
  return containers;
};

setupScoreGrid({
  cardSelector: '[data-dmid="product-tile"][data-dan]',
  scoreForCard: (card) => {
    const productId = card.getAttribute('data-dan');
    return productId ? scoreOf(productId) : Promise.resolve(null);
  },
  placeBadge: (card, badge) => {
    const rating = card.querySelector('[data-dmid="product-tile-rating"]');
    const fallback = card.querySelector('[data-dmid="price-infos"]');
    if (rating) rating.after(badge);
    else if (fallback) fallback.after(badge);
  },
  discover,
});
