// Google Maps search results: an opt-in sort by review count. ⌥Z (or a click on
// the chip beside "Results") sorts the loaded results, and again restores Maps'
// order; ⌥⇧Z (shift-click) first scrolls the list until Maps has loaded every
// result. Maps lays the feed out as a flex column, so the sort is CSS `order`
// only — Maps' nodes never move. A new search starts unsorted.
import { parseRatingAndCount } from '../shared/locale-number';

const RESULT = '[role="article"]';
// Material Symbols' "sort": the chip is this icon alone, since Maps' header
// row wraps when full and its own "Sort by" (on some searches) leaves ~120px.
const SORT_ICON =
  '<svg viewBox="0 -960 960 960" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M120-240v-80h240v80H120Zm0-200v-80h480v80H120Zm0-200v-80h720v80H120Z"/></svg>';
let loading = false;

const findFeed = () => document.querySelector<HTMLElement>('[role="feed"]');

// "Results for <query>": a sort stays on through map moves, loaded pages and a
// place opened and closed (Maps rebuilds the feed), and drops with a new query.
const queryOf = (feed: HTMLElement) => feed.getAttribute('aria-label') ?? '';
let sortedQuery: string | null = null;

// "4.1 stars 6,263 Reviews", localized — read by its numbers.
const reviewCount = (result: Element) =>
  parseRatingAndCount(result.querySelector('.ZkP5Je')?.getAttribute('aria-label') ?? '').count;

const setOrder = (el: HTMLElement, order: string) => {
  if (el.style.order !== order) el.style.order = order;
};

// Results permute among their own slots; the header, dividers and Maps' loading
// row keep theirs. Orders are negative so whatever Maps appends before the next
// pass lands at the bottom, where Maps put it, rather than above the header.
const applySort = (feed: HTMLElement) => {
  const kids = [...feed.children] as HTMLElement[];
  const slots = kids.flatMap((kid, i) => (kid.querySelector(RESULT) ? [i] : []));
  const ranked = slots.map((i) => ({ kid: kids[i], n: reviewCount(kids[i]) })).sort((a, b) => b.n - a.n);
  const slot = new Map(kids.map((kid, i) => [kid, i]));
  ranked.forEach(({ kid }, r) => slot.set(kid, slots[r]));
  for (const [kid, i] of slot) setOrder(kid, String(i - kids.length));
};

const clearSort = (feed: HTMLElement) => {
  sortedQuery = null;
  for (const kid of feed.children) setOrder(kid as HTMLElement, '');
};

const toggle = (feed: HTMLElement) => {
  if (sortedQuery === queryOf(feed)) clearSort(feed);
  else sortedQuery = queryOf(feed);
  sync();
};

// Maps pages results in as the feed scrolls: hold it at the bottom until Maps
// prints its end-of-list note, or adds nothing for a few seconds.
const loadAllAndSort = async (feed: HTMLElement) => {
  if (loading) return;
  loading = true;
  sync();
  const query = queryOf(feed);
  let count = 0;
  let idleSince = Date.now();
  while (feed.isConnected && queryOf(feed) === query && !feed.querySelector('.HlvSq') && Date.now() - idleSince < 6000) {
    feed.scrollTop = feed.scrollHeight;
    await new Promise((r) => setTimeout(r, 300));
    const n = feed.querySelectorAll(RESULT).length;
    if (n > count) {
      count = n;
      idleSince = Date.now();
    }
  }
  loading = false;
  if (queryOf(feed) === query) sortedQuery = query;
  feed.scrollTop = 0;
  sync();
};

const mountChip = (feed: HTMLElement) => {
  const row = feed.querySelector('h1')?.parentElement; // Maps' "Results" heading
  if (!row) return;
  let chip = row.querySelector<HTMLButtonElement>('.ts-review-sort');
  if (!chip) {
    chip = row.appendChild(document.createElement('button'));
    chip.className = 'ts-review-sort';
    chip.ariaLabel = 'Sort by number of reviews';
    chip.title = 'Most reviewed first (⌥Z)\nShift-click: load every result first (⌥⇧Z)';
    chip.addEventListener('click', (e) => (e.shiftKey ? loadAllAndSort(feed) : toggle(feed)));
  }
  // While ⌥⇧Z loads, the count so far stands in for the icon.
  const label = loading ? `${feed.querySelectorAll(RESULT).length}…` : '';
  if (chip.dataset.label !== label) {
    chip.dataset.label = label;
    if (label) chip.textContent = label;
    else chip.innerHTML = SORT_ICON;
  }
  const pressed = String(sortedQuery === queryOf(feed));
  if (chip.getAttribute('aria-pressed') !== pressed) chip.setAttribute('aria-pressed', pressed);
};

const sync = () => {
  const feed = findFeed();
  if (!feed) return;
  if (sortedQuery === queryOf(feed)) applySort(feed);
  else if (sortedQuery != null) clearSort(feed);
  mountChip(feed);
};

// Captured, and taken even in the search box, where focus stays after a search:
// there ⌥Z would only type Ω.
document.addEventListener(
  'keydown',
  (e) => {
    if (e.code !== 'KeyZ' || !e.altKey || e.metaKey || e.ctrlKey) return;
    const feed = findFeed();
    if (!feed) return;
    e.preventDefault();
    if (e.shiftKey) loadAllAndSort(feed);
    else toggle(feed);
  },
  true,
);

// Maps' DOM settles between interactions (a handful of mutation batches while
// panning) and a pass takes well under a millisecond, so resync on every batch:
// before paint, so a header Maps re-renders never shows without its chip.
new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
