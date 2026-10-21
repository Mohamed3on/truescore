import { setupScoreGrid } from '../shared/score-grid';
import { computeScore, fetchReviews, storeCode } from '../shared/helpfulcrowd';

const code = storeCode();

if (code) setupScoreGrid({
  cardSelector: '[data-hc="product-rating"][data-hc-id]',
  scoreForCard: async (card) => computeScore(await fetchReviews(code, card.getAttribute('data-hc-id')!)),
  // Beside HelpfulCrowd's stars, not inside them: its script fills the slot.
  placeBadge: (card, badge) => card.after(badge),
});
