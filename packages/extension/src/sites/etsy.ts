import { addCommas, npsColor, npsStats } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { createThrottledFetcher } from '../shared/throttled-fetch';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const CARD = '.v2-listing-card[data-listing-id][data-shop-id]';
const SPEC = 'Etsy\\Modules\\ListingPage\\Reviews\\DeepDive\\AsyncApiSpec';
const ENDPOINT = '/api/v3/ajax/bespoke/member/neu/specs/deep_dive_reviews';

const throttledFetch = createThrottledFetcher(8);

// The stars on a listing card are the *shop's*, not the item's. Only the review
// sheet on the listing page knows the item's own histogram, and this is the
// endpoint behind it — `scope: 'listingReviews'` is what keeps the seller's
// reviews out. Asking for a page past the last one returns the histogram with no
// review bodies attached, which is all we need and a third of the payload.
const fetchScore = async (listingId: string, shopId: string) => {
  const key = `nps_etsy_${listingId}`;
  const cached = cacheGet(key, CACHE_TTL);
  if (cached) return cached;

  const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf_nonce"]')?.content;
  if (!csrf) return null;

  const res = await throttledFetch(ENDPOINT, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      specs: {
        deep_dive_reviews: [SPEC, {
          listing_id: Number(listingId),
          shop_id: Number(shopId),
          scope: 'listingReviews',
          page: 9999,
          sort_option: 'Suggested',
          rating_filter: null,
          tag_filters: [],
          review_highlight_transaction_id: null,
          should_lazy_load_images: true,
          should_show_variations: false,
        }],
      },
    }),
  });
  if (!res.ok) return null;

  const counts = (await res.json())?.jsData?.ratingCounts;
  const total = counts?.All;
  if (!total) return null;

  const result = { ...npsStats(counts['5'] || 0, counts['1'] || 0, total), total };
  cacheSet(key, result);
  return result;
};

const injectBadge = (card: Element, { score, nps, total }: { score: number; nps: number; total: number }) => {
  const badge = document.createElement('span');
  badge.style.cssText = `color:${npsColor(nps)};font-weight:600;font-size:12px;margin-left:6px;white-space:nowrap;`;
  badge.textContent = `${addCommas(score)} (${Math.round(nps)}%)`;
  badge.title = `${addCommas(total)} item reviews`;
  card.querySelector('clg-static-review-stars')?.after(badge);
};

const bearer = (child: Element) => (child.matches(CARD) ? child : child.querySelector(CARD));

// Etsy nests cards differently on every surface: search wraps each card in a grid
// `li`, listing-page recommendations make the card itself the `li`, and shop
// pages drop them straight into a `div` carousel. So find the row by structure
// rather than by selector — the nearest ancestor holding two or more cards.
const containerOf = (card: Element) => {
  let el = card;
  while (el.parentElement) {
    const parent = el.parentElement;
    if ([...parent.children].filter(bearer).length >= 2) return parent;
    el = parent;
  }
  return null;
};

let sorting = false;

const sortContainers = (cards: Element[]) => {
  const containers = new Set<Element>();
  for (const card of cards) {
    const container = containerOf(card);
    if (container) containers.add(container);
  }

  sorting = true;
  for (const container of containers) {
    const scored: { child: Element; score: number }[] = [];
    const rest: Element[] = [];
    for (const child of [...container.children]) {
      const nps = bearer(child)?.getAttribute('data-nps');
      if (nps != null) scored.push({ child, score: parseFloat(nps) });
      else rest.push(child);
    }
    if (scored.length < 2) continue;

    scored.sort((a, b) => b.score - a.score);
    // The containers are flex rows whose children Etsy pins with `wt-order-*`
    // utility classes, so moving a node alone leaves it where it was. Those
    // classes declare `order` as `!important`, hence the priority here.
    // appendChild keeps tab order matching what's on screen.
    [...scored.map((s) => s.child), ...rest].forEach((child, i) => {
      (child as HTMLElement).style.setProperty('order', String(i), 'important');
      container.appendChild(child);
    });
  }
  sorting = false;
};

// Scores land one request at a time; re-sort as they do, but at most once a
// frame so a slow batch doesn't reshuffle the grid on every response.
let sortQueued = false;
const scheduleSort = (cards: Element[]) => {
  if (sortQueued) return;
  sortQueued = true;
  requestAnimationFrame(() => {
    sortQueued = false;
    sortContainers(cards);
  });
};

const processCards = () => {
  if (sorting) return;
  const cards = [...document.querySelectorAll(`${CARD}:not([data-nps-done])`)];
  if (!cards.length) return;

  for (const card of cards) {
    card.setAttribute('data-nps-done', '1');
    fetchScore(card.getAttribute('data-listing-id')!, card.getAttribute('data-shop-id')!)
      .then((data) => {
        if (!data || isNaN(data.nps)) return;
        card.setAttribute('data-nps', String(data.score));
        injectBadge(card, data);
        scheduleSort(cards);
      })
      .catch(() => {});
  }

  // A card Etsy renders after the last sort still carries its `wt-order-*` class,
  // whose low value would float it above everything already placed. Give the new
  // batch an explicit order now rather than waiting on a score that may not come.
  scheduleSort(cards);
};

let debounceTimer: ReturnType<typeof setTimeout>;
const debouncedProcess = () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processCards, 200);
};

processCards();
new MutationObserver(debouncedProcess).observe(document.body, { childList: true, subtree: true });
