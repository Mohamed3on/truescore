import { setupScoreGrid } from '../shared/score-grid';
import { computeScore, fetchReviews, storeCode } from '../shared/helpfulcrowd';

const code = storeCode();
const SLOT = '[data-hc="product-rating"][data-hc-id]';

if (code) setupScoreGrid({
  // The slot's wrapper, which holds the badge too, so ] / [ find the card from it.
  cardSelector: `:has(> ${SLOT})`,
  scoreForCard: async (card) => computeScore(await fetchReviews(code, card.querySelector(SLOT)!.getAttribute('data-hc-id')!)),
  // Beside HelpfulCrowd's stars, not inside them: its script fills the slot.
  placeBadge: (card, badge) => card.querySelector(SLOT)!.after(badge),
});
