import { addCommas, npsColor } from '../shared/utils';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { fetchItemScore } from '../shared/etsy';

const CARD = '.v2-listing-card[data-listing-id][data-shop-id]';

const throttledFetch = createThrottledFetcher(8);

const fetchScore = (listingId: string, shopId: string) =>
  fetchItemScore(throttledFetch, listingId, shopId);

const injectBadge = (card: Element, { score, nps, total }: { score: number; nps: number; total: number }) => {
  const badge = document.createElement('span');
  badge.style.cssText = `color:${npsColor(nps)};font-weight:600;font-size:12px;white-space:nowrap;`;
  badge.textContent = `${addCommas(score)} (${Math.round(nps)}%)`;
  badge.title = `${addCommas(total)} item reviews`;

  // Sit beside the shop's stars so the two numbers can be read against each
  // other. A shop page rates itself in the header and leaves its own cards
  // starless, so there the badge goes under the price instead.
  const stars = card.querySelector('clg-static-review-stars');
  if (stars) {
    badge.style.marginLeft = '6px';
    stars.after(badge);
  } else {
    card.querySelector('.v2-listing-card__info')?.append(badge);
  }
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
