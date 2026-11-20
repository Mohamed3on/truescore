// Booking.com search page: badge and rank every property by its review volume
// weighted by rating; ] / [ step through the best score at each price.
import { parseRatingAndCount } from '../shared/locale-number';
import { orderByCssBand, setupScoreGrid } from '../shared/score-grid';
import { addCommas } from '../shared/utils';

const CARD = '[data-testid="property-card"]';
const REVIEW = '[data-testid="review-score"]';

setupScoreGrid({
  cardSelector: CARD,
  idOf: (card) => card.querySelector<HTMLAnchorElement>('[data-testid="title-link"]')?.href.split('?')[0],
  // Booking localizes the block ("8,6 Fabelhaft 1.437 Bewertungen"), so it's
  // read by its numbers alone — see parseRatingAndCount. The badge's color
  // grades the 10-point rating as a percentage.
  scoreForCard: async (card) => {
    const { rating, count } = parseRatingAndCount(card.querySelector(REVIEW)?.textContent ?? '');

    return count ? { score: Math.round(count * (rating / 10) ** 15), nps: rating * 10, total: count } : null;
  },
  placeBadge: (card, badge) => {
    badge.textContent = `TrueScore ${addCommas(Number(badge.dataset.nps))}`;
    badge.title = `${badge.title}, weighted by rating: reviews × (score/10)^15`;
    badge.style.marginLeft = '0';
    // Under the review count, in the host's label column.
    card.querySelector(REVIEW)?.lastElementChild?.append(badge);
  },
  // The list view stacks its cards in a block, which ignores CSS `order`.
  applyOrder: (container, scored, rest, sunk) => {
    if (container instanceof HTMLElement && getComputedStyle(container).display === 'block') {
      Object.assign(container.style, { display: 'flex', flexDirection: 'column' });
    }

    orderByCssBand(container, scored, rest, sunk);
  },
  // Every card prices the same stay, so "€ 1,235" / "1.235 €" compare as whole
  // amounts (Booking shows no cents in search).
  priceOf: (card) => Number(card.querySelector('[data-testid="price-and-discounted-price"]')?.textContent?.replace(/\D/g, '')) || null,
});
