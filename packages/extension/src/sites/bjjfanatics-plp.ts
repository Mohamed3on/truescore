import { containersBySelector, setupScoreGrid } from '../shared/score-grid';
import { BJJ_FANATICS, cardScores } from '../shared/stamped';

const scoreOf = cardScores(BJJ_FANATICS);
const starsOf = (card: Element) => card.querySelector('.stamped-product-reviews-badge[data-id]');

setupScoreGrid({
  cardSelector: '.product-card__grid-item',
  scoreForCard: (card) => {
    const id = starsOf(card)?.getAttribute('data-id');

    return id ? scoreOf(id) : Promise.resolve(null);
  },
  // The card's info is a flex column: keep the badge from stretching across it.
  placeBadge: (card, badge) => {
    badge.style.alignSelf = 'flex-start';
    starsOf(card)?.after(badge);
  },
  // Search lists every result at once (964 for "guard"), too many to find their
  // row by structure on each re-rank.
  discover: containersBySelector('.search-results, .collection-page__grid-products'),
});
