// Booking.com search page - sort by combined score
let sortingEnabled = false;
const scoresByUrl = new Map<string, number>();

const calculateScore = (reviewText: string) => {
  const rating = parseFloat(reviewText.match(/\d+(\.\d+)?/)?.[0] || '0') / 10;
  const reviewCount = parseInt(reviewText.match(/(\d+(?:,\d+)*)\s*reviews?/i)?.[1]?.replace(/,/g, '') || '0');
  return Math.round(reviewCount * Math.pow(rating, 15));
};

const getCardScore = (card: Element) => {
  const url = (card.querySelector('a') as HTMLAnchorElement)?.href?.split('?')[0];
  if (url && scoresByUrl.has(url)) return scoresByUrl.get(url)!;
  const reviewText = card.querySelector('[data-testid="review-score"]')?.textContent || '';
  const score = calculateScore(reviewText);
  if (url) scoresByUrl.set(url, score);
  return score;
};

const addScoreBadge = (card: Element, score: number) => {
  const reviewEl = card.querySelector('[data-testid="review-score"]');
  if (!reviewEl || reviewEl.querySelector('.score')) return;
  const badge = document.createElement('div');
  badge.className = 'score';
  badge.textContent = score.toLocaleString();
  badge.style.cssText = 'font-weight:600; background:#003580; color:white; padding:2px 6px; border-radius:4px; margin-left:8px';
  reviewEl.appendChild(badge);
};

const sortCards = (cards: Element[], container: Element) => {
  const isWrapped = !cards.every(c => c.parentElement === container);
  [...cards]
    .sort((a, b) => getCardScore(b) - getCardScore(a))
    .forEach(card => container.appendChild(isWrapped ? card.parentElement! : card));
  [...container.children]
    .filter(el => !el.matches('[data-testid="property-card"]') && !el.querySelector('[data-testid="property-card"]'))
    .forEach(el => container.appendChild(el));
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
  if (isOutOfOrder(cards)) sortCards(cards, cards[0].parentElement!);
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

new MutationObserver(() => {
  createSortButton();
  if (sortingEnabled) applySortAndBadges();
}).observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.message === 'TabUpdated') {
    sortingEnabled = false;
    scoresByUrl.clear();
    setTimeout(createSortButton, 1500);
  }
});
