// Amazon search page - sort by rating score
import { addCommas } from '../shared/utils';

const CACHE_KEY = 'amz-rating-cache';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

const sortFunction = (a: [number, Element], b: [number, Element]) => (a[0] === b[0] ? 0 : a[0] < b[0] ? 1 : -1);

const htmlToElement = (html: string) => {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstChild as Element;
};

const getCache = () => {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    const now = Date.now();
    for (const key in cache) {
      if (now - cache[key].ts > CACHE_TTL) delete cache[key];
    }
    return cache;
  } catch { return {}; }
};

const saveCache = (cache: any) => {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
};

const getRatingPercentage = (ratingText: string) => {
  try {
    const template = htmlToElement(ratingText);
    const totalReviews = parseInt(
      template.querySelector('[data-hook="total-review-count"]')?.textContent?.trim().replace(/\D/g, '') || '0', 10
    );
    const fiveStars = parseInt(
      template.querySelector('#histogramTable li:first-child .a-section.a-spacing-none.a-text-right')?.textContent?.trim().replace('%', '') || '0', 10
    );
    const oneStars = parseInt(
      template.querySelector('#histogramTable li:last-child .a-section.a-spacing-none.a-text-right span:last-child')?.textContent?.trim().replace('%', '') || '0', 10
    );
    return { fiveStars, oneStars, totalReviews };
  } catch (e) {
    console.error('Error parsing rating:', e);
    return { fiveStars: 0, oneStars: 0, totalReviews: 0 };
  }
};

const getRatingScores = async (productSIN: string, elementToReplace: Element, cache: any) => {
  try {
    const now = Date.now();
    let ratings = cache[productSIN];
    if (!ratings || now - ratings.ts > CACHE_TTL) {
      const resp = await fetch(
        `/gp/customer-reviews/widgets/average-customer-review/popover/ref=dpx_acr_pop_?contextId=dpx&asin=${productSIN}`,
        { method: 'GET', mode: 'cors', credentials: 'include' }
      );
      if (!resp.ok) throw new Error('Failed to fetch ratings');
      const text = await resp.text();
      const parsed = getRatingPercentage(text);
      ratings = { ...parsed, ts: now };
      if (parsed.totalReviews > 0) cache[productSIN] = ratings;
    }
    const scorePercentage = ratings.fiveStars - ratings.oneStars;
    const scoreAbsolute = Math.round(ratings.totalReviews * (scorePercentage / 100));
    const calculatedScore = Math.round(scoreAbsolute * (scorePercentage / 100)) || 0;
    elementToReplace.textContent = ` ${addCommas(calculatedScore)} ratio: (${scorePercentage}%)`;
    return { calculatedScore };
  } catch (e) {
    console.error(`Failed to get rating for ${productSIN}:`, e);
    return { calculatedScore: 0 };
  }
};

let resultObs: MutationObserver | null = null;
let observedContainer: Element | null = null;
const pauseObs = () => { if (resultObs) resultObs.disconnect(); };
const resumeObs = () => {
  if (resultObs && observedContainer?.isConnected)
    resultObs.observe(observedContainer, { childList: true });
};

const sortAmazonResults = async () => {
  const items = document.querySelectorAll('.s-result-item[data-asin]:not([data-asin=""]):not(.AdHolder)');
  const seenASINs = new Set<string>();
  const fetchPromises: Promise<[number, Element]>[] = [];
  const noRatingItems: [number, Element][] = [];
  const cache = getCache();

  for (const item of items) {
    if (item.querySelector('.s-shopping-adviser')) continue;
    const productSIN = item.getAttribute('data-asin');
    if (!productSIN || seenASINs.has(productSIN)) continue;

    const swatchASINs = [...item.querySelectorAll('[data-csa-c-swatch-url]')]
      .map(el => (el.getAttribute('data-csa-c-swatch-url')?.match(/\/dp\/([A-Z0-9]{10})/) || [])[1])
      .filter(Boolean);
    if (swatchASINs.some(a => seenASINs.has(a))) { item.remove(); continue; }
    swatchASINs.forEach(a => seenASINs.add(a));
    seenASINs.add(productSIN);

    const numberOfRatingsElement =
      item.querySelector('[data-cy="reviews-block"] a span.a-size-mini') ||
      item.querySelector('[data-cy="reviews-block"] .a-row.a-size-small a span.a-size-small') ||
      item.querySelector('.sg-row .a-spacing-top-micro .a-link-normal span.a-size-base');

    if (!numberOfRatingsElement) { noRatingItems.push([0, item]); continue; }

    fetchPromises.push(
      getRatingScores(productSIN, numberOfRatingsElement, cache).then(({ calculatedScore }) => [calculatedScore, item] as [number, Element])
    );
  }

  const results = await Promise.allSettled(fetchPromises);
  saveCache(cache);

  const itemsArr: [number, Element][] = results
    .filter((r): r is PromiseFulfilledResult<[number, Element]> => r.status === 'fulfilled')
    .map(r => r.value)
    .concat(noRatingItems);

  itemsArr.sort(sortFunction);

  const searchResults = document.querySelector('.s-result-list.s-search-results') || document.querySelector('#mainResults .s-result-list');
  if (searchResults && itemsArr.length > 0) {
    pauseObs();
    for (const [, item] of itemsArr) item.remove();
    const refNode = searchResults.firstChild;
    for (const [, item] of itemsArr) searchResults.insertBefore(item, refNode);
    resumeObs();
  }
};

(async function main() {
  const isSearchPage = () => /s\?k|s\?i|s\?|\/b\//.test(location.href);

  let sorting = false, pendingSort = false;
  const debouncedSort = (() => {
    let timer: ReturnType<typeof setTimeout>;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (sorting) { pendingSort = true; return; }
        sorting = true;
        await sortAmazonResults();
        sorting = false;
        if (pendingSort) { pendingSort = false; debouncedSort(); }
      }, 300);
    };
  })();

  const watchResults = () => {
    const container = document.querySelector('.s-result-list.s-search-results, #mainResults .s-result-list');
    if (!container || container === observedContainer) return;
    pauseObs();
    observedContainer = container;
    resultObs = new MutationObserver(debouncedSort);
    resultObs.observe(container, { childList: true });
  };

  if (isSearchPage()) { await sortAmazonResults(); watchResults(); }

  const onNavigate = () => {
    if (!isSearchPage()) return;
    debouncedSort();
    const bodyObs = new MutationObserver(() => {
      const container = document.querySelector('.s-result-list.s-search-results, #mainResults .s-result-list');
      if (container && container !== observedContainer) {
        bodyObs.disconnect();
        watchResults();
        debouncedSort();
      }
    });
    bodyObs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => bodyObs.disconnect(), 10000);
  };

  const origPush = history.pushState;
  history.pushState = function(...args: any[]) { origPush.apply(this, args); onNavigate(); };
  const origReplace = history.replaceState;
  history.replaceState = function(...args: any[]) { origReplace.apply(this, args); onNavigate(); };
  window.addEventListener('popstate', onNavigate);
})();
