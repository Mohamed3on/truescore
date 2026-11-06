import { setupScoreGrid } from '../shared/score-grid';
import { cardScores, tatamiStore } from '../shared/stamped';

const store = tatamiStore(location.host);

if (store) {
  const scoreOf = cardScores(store);
  const starsOf = (card: Element) => card.querySelector('.stamped-product-reviews-badge[data-id]');

  setupScoreGrid({
    cardSelector: 'li.product[data-handle]',
    scoreForCard: (card) => {
      const stars = starsOf(card);
      const id = stars?.getAttribute('data-id');

      // The title makes Stamped pool the product's family, as its own badge does.
      return id ? scoreOf(id, stars!.getAttribute('data-product-title') ?? undefined) : Promise.resolve(null);
    },
    // Inside Stamped's stars, the only spot on their row (the card's info is a
    // flex column). Stamped redraws them once its script loads, wiping the
    // badge, so it goes back in whenever it's missing.
    placeBadge: (card, badge) => {
      const stars = starsOf(card);

      if (!stars) return;
      const id = stars.getAttribute('data-id');

      // Never back into stars recycled for another product.
      const place = () => {
        // Its drawn line is a block of its own: the badge goes in it, after the stars.
        const line = stars.querySelector('.stamped-badge') ?? stars;

        if (stars.getAttribute('data-id') === id && badge.parentElement !== line) line.append(badge);
      };

      place();
      new MutationObserver(place).observe(stars, { childList: true, subtree: true });
    },
  });
}
