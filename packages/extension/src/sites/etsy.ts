import { createThrottledFetcher } from '../shared/throttled-fetch';
import { fetchItemScore } from '../shared/etsy';
import { setupScoreGrid, orderByCssImportant } from '../shared/score-grid';

const CARD = '.v2-listing-card[data-listing-id][data-shop-id]';

const throttledFetch = createThrottledFetcher(8);

setupScoreGrid({
  cardSelector: CARD,
  scoreForCard: (card) =>
    fetchItemScore(throttledFetch, card.getAttribute('data-listing-id')!, card.getAttribute('data-shop-id')!),
  placeBadge: (card, badge) => {
    // Sit beside the shop's stars so the two numbers can be read against each
    // other. A shop page rates itself in the header and leaves its own cards
    // starless, so there the badge goes under the info block instead.
    const stars = card.querySelector('clg-static-review-stars');
    if (stars) stars.after(badge);
    else card.querySelector('.v2-listing-card__info')?.append(badge);
  },
  // Etsy pins each card with `wt-order-*` utility classes that declare `order`
  // as `!important`, so ranking has to out-`!important` them — style-only, no
  // node moves for a host re-render to fight.
  applyOrder: orderByCssImportant,
});
