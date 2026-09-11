import { createThrottledFetcher } from '../shared/throttled-fetch';
import { fetchItemScore } from '../shared/aliexpress';
import { setupScoreGrid } from '../shared/score-grid';

const CARD = 'a.search-card-item';

const throttledFetch = createThrottledFetcher(8);

// A card links to `/item/<id>.html`, or — for a bundle deal — to a landing page
// naming the item in `productIds=<id>:<sku>`.
const listingId = (card: Element) => card.getAttribute('href')?.match(/(?:\/item\/|[?&]productIds=)(\d+)/)?.[1];

// AliExpress hashes every class on a search card, so find the seller's rating by
// shape instead: the lone leaf span holding a bare number, inside the box that
// draws the stars.
const ratingEl = (card: Element) =>
  [...card.querySelectorAll('span')].find(
    (span) =>
      !span.children.length &&
      /^[0-5]([.,]\d)?$/.test(span.textContent!.trim()) &&
      (span.parentElement?.querySelectorAll('img').length ?? 0) >= 3
  );

setupScoreGrid({
  cardSelector: CARD,
  scoreForCard: (card) => {
    const id = listingId(card);
    return id ? fetchItemScore(throttledFetch, id) : Promise.resolve(null);
  },
  idOf: listingId,
  placeBadge: (card, badge) => {
    // Beside the star average so the two numbers can be read against each other.
    const rating = ratingEl(card);
    if (rating) rating.after(badge);
    else card.append(badge);
  },
  // The row also holds `lazy-load` placeholders that would fight a node move —
  // the default CSS-band ranking touches nothing else.
});
