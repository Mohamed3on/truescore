import { cacheGet, cacheSet } from './cache';
import { createThrottledFetcher } from './throttled-fetch';
import { npsStats } from './utils';

// HelpfulCrowd (helpfulcrowd.com), the review app behind some Shopify stores
// (Wear The Peace). Its storefront widget serves a product's reviews to the
// store's own origin as a script that writes their HTML, five to a page, so any
// store running it is read the same way, keyed by its HelpfulCrowd store code.

export interface HcReview { rating: number; body: string }
export interface ReviewBundle { total: number; reviews: HcReview[] }

const REVIEWS_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 5;
// The newest 50 reviews: the page size is fixed and each page weighs ~100 KB.
const MAX_PAGES = 10;

// A collection page asks for every card at once.
const throttled = createThrottledFetcher(6);

// The store's code, from the loader Shopify adds for the app (inline, its
// slashes escaped, until the loader turns it into a script tag).
export const storeCode = (): string | null => {
  for (const s of document.scripts) {
    const m = (s.src || s.textContent || '').match(/helpfulcrowd\.com\\?\/res\\?\/shopify\\?\/(\w+)/);
    if (m) return m[1];
  }
  return null;
};

const parsePage = (js: string): ReviewBundle => {
  const html = js.match(/var html = (".*")/)?.[1];
  if (!html) throw new Error('HelpfulCrowd page without reviews');
  // A JS string Rails escaped: JSON, bar its \' \` and \$.
  const json = html.replace(/\\(.)/g, (pair, c: string) => ("'`$".includes(c) ? c : pair));
  const doc = new DOMParser().parseFromString(JSON.parse(json), 'text/html');
  const reviews = [...doc.querySelectorAll('.hc-widget-card[data-model="review"]')].map((card) => ({
    rating: card.querySelectorAll('.hc-widget-card__rating .hc-icon--star').length,
    body: card.querySelector('.hc-review__feedback')?.textContent?.trim() ?? '',
  }));
  const total = Number(js.match(/productTabReviewBadge\)\.html\('(\d+)'\)/)?.[1] ?? reviews.length);
  return { total, reviews };
};

// A product HelpfulCrowd holds no reviews for answers 404.
const fetchPage = async (code: string, id: string, page: number): Promise<ReviewBundle> => {
  const res = await throttled(`https://app.helpfulcrowd.com/f/${code}/products/${id}/reviews.js?page=${page}`);
  if (res.status === 404) return { total: 0, reviews: [] };
  if (!res.ok) throw new Error(`HelpfulCrowd ${res.status}`);
  return parsePage(await res.text());
};

// Page 1 gives the total, then the rest of the sample goes out at once. A failed
// page fails the whole fetch, so no sample with a hole is ever cached.
export const fetchReviews = async (code: string, id: string): Promise<ReviewBundle> => {
  const key = `helpfulcrowd-reviews-v1-${code}-${id}`;
  const cached = cacheGet(key, REVIEWS_CACHE_MS) as ReviewBundle | null;
  if (cached) return cached;
  const first = await fetchPage(code, id, 1);
  const pages = Math.min(MAX_PAGES, Math.ceil(first.total / PAGE_SIZE));
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => fetchPage(code, id, i + 2)));
  const bundle = { total: first.total, reviews: [first, ...rest].flatMap((p) => p.reviews) };
  cacheSet(key, bundle);
  return bundle;
};

// The sample's 5★/1★ shares scaled to the product's full count, as Stamped's.
export const computeScore = ({ total, reviews }: ReviewBundle) => {
  if (!reviews.length) return null;
  const five = reviews.filter((r) => r.rating === 5).length;
  const one = reviews.filter((r) => r.rating === 1).length;
  const n = Math.max(total, reviews.length);
  const scale = n / reviews.length;
  return { ...npsStats(five * scale, one * scale, n), total: n };
};
