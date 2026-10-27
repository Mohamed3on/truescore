import { setupScoreGrid } from '../shared/score-grid';
import { productIdOf, productScore } from '../shared/printful';

// A catalog card links its product by slug; the id behind it comes from the
// product's page. A card without stars has no reviews to fetch.
const CARD = '.catalog-product-card';
const REVIEWS = '.catalog-product-card__reviews';
const idOf = (card: Element) => card.querySelector('a[href]')?.getAttribute('href')?.split('#')[0];

setupScoreGrid({
  cardSelector: CARD,
  idOf,
  scoreForCard: async (card) => {
    const path = card.querySelector(REVIEWS) && idOf(card);
    const id = path ? await productIdOf(path) : null;

    return id ? productScore(id) : null;
  },
  placeBadge: (card, badge) => card.querySelector(REVIEWS)?.append(badge),
});
