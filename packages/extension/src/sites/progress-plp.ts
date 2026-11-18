import { setupScoreGrid } from '../shared/score-grid';
import { cardScores, PROGRESS } from '../shared/stamped';

const scoreOf = cardScores(PROGRESS);

setupScoreGrid({
  // Collections wrap each card in .pj-card; search puts bare <a> cards in its grid.
  cardSelector: '[data-pj-grid] > :has([data-wpd-product-id])',
  scoreForCard: (card) => scoreOf(card.querySelector('[data-wpd-product-id]')!.getAttribute('data-wpd-product-id')!),
  // Inside the theme's stars: the title row spreads its items apart.
  placeBadge: (card, badge) => card.querySelector('.pj-product-card__rating')?.append(badge),
});
