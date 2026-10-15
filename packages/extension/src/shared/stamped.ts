import { cacheGet, cacheSet } from './cache';
import { npsStats } from './utils';

// Stamped (stamped.io), the review app behind some Shopify stores' product
// pages (BJJ Fanatics, Progress Jiu Jitsu). Its public widget API answers to
// the store's own widget key, so every review comes straight from it.

export interface StampedStore {
  apiKey: string;
  storeUrl: string;
  cacheKey: (productId: string) => string;
}

export interface ProductInfo {
  id: string;
  sku: string;
  name: string;
}

export interface StampedReview {
  id?: number;
  reviewRating: number;
  reviewTitle?: string;
  reviewMessage?: string;
  reviewOptionsList?: { message?: string; value?: string }[];
  productName?: string;
  productVariantName?: string | null;
}

export interface ReviewBundle { total: number; reviews: StampedReview[] }

const REVIEWS_CACHE_MS = 14 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export const getProductInfo = (): ProductInfo | null => {
  const widget = document.getElementById('stamped-main-widget') as HTMLElement | null;
  const id = widget?.dataset.productId || widget?.getAttribute('data-product-id');
  const sku = widget?.dataset.productSku || widget?.getAttribute('data-product-sku');
  const name = widget?.dataset.name || widget?.getAttribute('data-name');
  if (!id || !sku || !name) return null;
  return { id, sku, name };
};

// minRating=1 disables Stamped's silent default filter that hides non-5★ reviews
// from the public widget — without it, total + reviews are missing the 4★/3★/2★ ones.
const stampedUrl = (store: StampedStore, page: number, info: ProductInfo) =>
  `https://stamped.io/api/widget/reviews?productId=${encodeURIComponent(info.id)}` +
  `&productSKU=${encodeURIComponent(info.sku)}` +
  `&productName=${encodeURIComponent(info.name)}` +
  `&apiKey=${store.apiKey}&storeUrl=${store.storeUrl}` +
  `&take=${PAGE_SIZE}&page=${page}&sort=recent&minRating=1`;

const fetchPage = async (store: StampedStore, page: number, info: ProductInfo) => {
  const res = await fetch(stampedUrl(store, page, info));
  if (!res.ok) return null;
  return res.json() as Promise<{ total?: number; data?: StampedReview[] }>;
};

const dedupeById = (reviews: StampedReview[]): StampedReview[] => {
  const seen = new Set<number | string>();
  const out: StampedReview[] = [];
  for (const r of reviews) {
    const key = r.id ?? `${r.reviewTitle ?? ''}|${r.reviewMessage ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
};

// The review count in the page's own structured data. Stamped's total, which
// page 1 reports, can run higher (519 against 425 on one course).
const pageReviewCount = () => {
  let count = 0;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    for (const m of (script.textContent ?? '').matchAll(/"reviewCount"\s*:\s*"?(\d+)/g)) count = Math.max(count, Number(m[1]));
  }
  return count;
};

const fetchAllReviews = async (store: StampedStore, info: ProductInfo): Promise<ReviewBundle> => {
  const cacheKey = store.cacheKey(info.id);
  const cached = cacheGet(cacheKey, REVIEWS_CACHE_MS) as ReviewBundle | null;

  // With a cache, page 1 goes alone — it gives the current `total` plus the
  // newest reviews, so we can detect new ones and incrementally refresh. Cold,
  // the pages the page's own review count calls for go out with it.
  const upfront = cached ? 1 : Math.min(MAX_PAGES, Math.max(1, Math.ceil(pageReviewCount() / PAGE_SIZE)));
  const early = Array.from({ length: upfront }, (_, i) => fetchPage(store, i + 1, info).catch(() => null));
  const first = await early[0];
  if (!first) {
    if (cached) return cached;
    throw new Error('Stamped API unavailable');
  }
  const total = first.total ?? 0;
  const firstData = first.data || [];

  if (cached && cached.total === total && cached.reviews.length) return cached;

  const merged: StampedReview[] = [...firstData];

  // Incremental: a small bump means new reviews fit in page 1 — merge with cache.
  if (cached && total > cached.total && total - cached.total <= PAGE_SIZE) {
    merged.push(...cached.reviews);
    const deduped = dedupeById(merged);
    const bundle = { total, reviews: deduped };
    cacheSet(cacheKey, bundle);
    return bundle;
  }

  // Otherwise refetch the rest in parallel — past those already under way.
  let complete = true;
  const remaining = Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE)) - 1;
  if (remaining > 0) {
    const rest = await Promise.all(
      Array.from({ length: remaining }, (_, i) => early[i + 1] ?? fetchPage(store, i + 2, info).catch(() => null))
    );
    for (const r of rest) {
      if (r?.data) merged.push(...r.data);
      else complete = false;
    }
  }

  const deduped = dedupeById(merged);
  const bundle = { total, reviews: deduped };
  // A sample with a failed page is shown but never cached, so the next visit
  // refetches it whole — a cached hole was served (and merged into) for good.
  if (complete && deduped.length) cacheSet(cacheKey, bundle);
  return bundle;
};

// Paints from cache at once, then confirms against the API in the background,
// rendering again only if the review count actually moved since the cached
// snapshot. The Stamped API is cold-start slow (~9s first hit), so blocking the
// panel on it makes the widget feel absent. `stays` says whether a render is the
// one left on screen: an auto-summary waits on it, or a replaced panel and its
// replacement would both summarize — two paid calls.
export const loadReviews = async (
  store: StampedStore,
  info: ProductInfo,
  render: (bundle: ReviewBundle, stays: boolean | Promise<boolean>) => void,
) => {
  const cached = cacheGet(store.cacheKey(info.id), REVIEWS_CACHE_MS) as ReviewBundle | null;
  const freshPromise = fetchAllReviews(store, info).catch(() => null);
  const moved = (fresh: ReviewBundle | null) => !!fresh && (!cached || fresh.total !== cached.total);

  if (cached?.reviews.length) render(cached, freshPromise.then((fresh) => !moved(fresh)));

  const fresh = await freshPromise;
  if (moved(fresh)) render(fresh!, true);
};

// The 5★/1★ tallies cover only the fetched sample (≤ MAX_PAGES pages, minus any
// that failed), so they're shares of the sample scaled to Stamped's full count —
// never sample counts over `total`, which read 1,000 of 2,500 5★ reviews as 40%.
export const computeScore = ({ total, reviews }: ReviewBundle) => {
  if (!reviews.length) return null;
  let five = 0, one = 0;
  for (const r of reviews) {
    if (r.reviewRating === 5) five++;
    else if (r.reviewRating === 1) one++;
  }
  const n = Math.max(total, reviews.length);
  const scale = n / reviews.length;
  return { ...npsStats(five * scale, one * scale, n), total: n };
};

const MIN_REVIEW_CHARS = 20;

export const reviewToText = (r: StampedReview): string => {
  const head = [r.reviewTitle, r.reviewMessage].filter(Boolean).join(': ').trim();
  if (head.length < MIN_REVIEW_CHARS) return '';
  const meta = (r.reviewOptionsList || [])
    .map(o => o.message && o.value ? `${o.message}: ${o.value}` : '')
    .filter(Boolean)
    .join(' | ');
  return [meta && `[${meta}]`, head].filter(Boolean).join(' ').trim();
};
