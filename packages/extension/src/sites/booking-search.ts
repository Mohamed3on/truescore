// Booking.com search page - sort by combined score
import { parseRatingAndCount } from '../shared/locale-number';

let sortingEnabled = false;
const scoresByUrl = new Map<string, number>();

// Booking localizes the block ("8,6 Fabelhaft 1.437 Bewertungen"), so it's read
// by its numbers alone — see parseRatingAndCount.
const calculateScore = (reviewText: string) => {
  const { rating, count } = parseRatingAndCount(reviewText);
  return Math.round(count * Math.pow(rating / 10, 15));
};

// The score block's text minus our own badge (appended inside it), whose
// digits would otherwise read as the review count on a re-parse.
const reviewTextOf = (card: Element) => {
  const block = card.querySelector('[data-testid="review-score"]')?.cloneNode(true) as Element | undefined;
  block?.querySelector('.score')?.remove();
  return block?.textContent;
};

const getCardScore = (card: Element) => {
  const url = (card.querySelector('a') as HTMLAnchorElement)?.href?.split('?')[0];
  if (url && scoresByUrl.has(url)) return scoresByUrl.get(url)!;
  const reviewText = reviewTextOf(card);
  // Score not rendered yet — 0 for this pass, but uncached so a later pass
  // reads the real value instead of locking the URL to 0.
  if (!reviewText) return 0;
  const score = calculateScore(reviewText);
  if (url) scoresByUrl.set(url, score);
  return score;
};

const addScoreBadge = (card: Element, score: number) => {
  const reviewEl = card.querySelector('[data-testid="review-score"]');
  if (!reviewEl?.textContent || reviewEl.querySelector('.score')) return;
  const badge = document.createElement('div');
  badge.className = 'score';
  badge.textContent = score.toLocaleString();
  badge.style.cssText = 'font-weight:600; background:#003580; color:white; padding:2px 6px; border-radius:4px; margin-left:8px';
  reviewEl.appendChild(badge);
};

// Cards sit either directly in one list or each inside its own wrapper div; the
// sortable unit is whatever is a direct child of the shared parent. Non-card
// siblings keep their slots — only the units permute between theirs.
const sortCards = (cards: Element[]) => {
  const shared = cards.every(card => card.parentElement === cards[0].parentElement);
  const units = shared ? cards : cards.map(card => card.parentElement!);
  const container = units[0]?.parentElement;
  if (!container || units.some(unit => unit?.parentElement !== container)) return;

  const sorted = cards
    .map((card, i) => ({ unit: units[i], score: getCardScore(card) }))
    .sort((a, b) => b.score - a.score)
    .map(({ unit }) => unit);

  const unitSet = new Set(units);
  let next = 0;
  const desired = [...container.children].map(child => (unitSet.has(child) ? sorted[next++] : child));
  if (desired.every((child, i) => container.children[i] === child)) return;
  for (const child of desired) container.appendChild(child);
};

const isOutOfOrder = (cards: Element[]) => {
  for (let i = 1; i < cards.length; i++) {
    if (getCardScore(cards[i]) > getCardScore(cards[i - 1])) return true;
  }
  return false;
};

const applySortAndBadges = () => {
  const cards = [...document.querySelectorAll('[data-testid="property-card"]')];
  if (!cards.length) return;
  if (isOutOfOrder(cards)) sortCards(cards);
  cards.forEach(card => addScoreBadge(card, getCardScore(card)));
};

const createSortButton = () => {
  const header = document.querySelector('h1');
  if (!header || document.querySelector('#sort-btn') || !document.querySelector('[data-testid="property-card"]')) return;
  const button = document.createElement('button');
  button.id = 'sort-btn';
  button.textContent = 'Sort by score';
  button.style.cssText = 'border-radius:8px; background:#0071c2; color:white; padding:10px; font-weight:bold; margin-top:10px';
  button.onclick = () => { sortingEnabled = true; applySortAndBadges(); };
  header.parentElement!.style.cssText = 'display:flex; justify-content:space-between; align-items:center';
  header.parentElement!.appendChild(button);
};

setTimeout(createSortButton, 1500);

let debounceTimer: ReturnType<typeof setTimeout>;
new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    createSortButton();
    if (sortingEnabled) applySortAndBadges();
  }, 200);
}).observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.message === 'TabUpdated') {
    sortingEnabled = false;
    scoresByUrl.clear();
    setTimeout(createSortButton, 1500);
  }
});
