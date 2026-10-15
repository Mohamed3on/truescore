import { setupScoreGrid } from '../shared/score-grid';
import { cardScores, PROGRESS } from '../shared/stamped';

const scoreOf = cardScores(PROGRESS);

setupScoreGrid({
  cardSelector: '.product-grid-item[data-product-id]',
  scoreForCard: (card) => scoreOf(card.getAttribute('data-product-id')!),
  // Beside Stamped's stars, not inside them: its redraw would wipe the badge.
  placeBadge: (card, badge) => card.querySelector('.stamped-product-reviews-badge')?.after(badge),
});
