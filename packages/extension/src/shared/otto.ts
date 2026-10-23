import { cacheGetMaybe, cacheSetMaybe } from './cache';
import { idbGet, idbSet } from './idb-cache';
import { createThrottledFetcher } from './throttled-fetch';
import { SAMPLE_MAX } from './review-summary';
import { RECENT_REVIEWS } from './recency';
import { npsStats } from './utils';

// Otto renders its reviews on its own servers: a product's star histogram in its
// pages, its reviews as HTML fragments, 30 to a page. Kasada guards the pages
// but not these same-origin requests from the extension.

export interface OttoReview {
  rating: number;
  title: string;
  body: string;
  date: string;
}

const HISTOGRAM_TTL = 7 * 24 * 60 * 60 * 1000;
const REVIEWS_TTL = 7 * 24 * 60 * 60 * 1000;
const PAGE = 30;

// A list page asks for every card at once.
const throttled = createThrottledFetcher(6);

// The star histogram's counts by star, from a product page or its reviews page.
// The counts read the same under Chrome's page translation: "(1.234)".
export const histogram = (root: ParentNode): Record<number, number> | null => {
  const rows = [...root.querySelectorAll<HTMLElement>('#pdp_cr_histogram [data-num-of-stars]')];
  if (!rows.length) return null;
  return Object.fromEntries(rows.map((row) => [Number(row.dataset.numOfStars), Number(row.textContent!.replace(/\D/g, '')) || 0]));
};

export const scoreOf = (counts: Record<number, number> | null) => {
  const total = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0;
  return total ? { ...npsStats(counts![5] ?? 0, counts![1] ?? 0, total), total } : null;
};

// A list card's score, from its product's reviews page past the last review
// page: the histogram without a list of reviews. A product with no reviews has
// no histogram and is tombstoned.
export const cardScore = async (productId: string) => {
  const key = `otto_histogram_v1_${productId}`;
  const cached = cacheGetMaybe(key, HISTOGRAM_TTL);
  if (cached) return scoreOf(cached.value);
  const res = await throttled(`/kundenbewertungen/${productId}/?page=999`);
  if (!res.ok) return null;
  const counts = histogram(new DOMParser().parseFromString(await res.text(), 'text/html'));
  cacheSetMaybe(key, counts);
  return scoreOf(counts);
};

// One page of a product's reviews, newest first.
const fetchPage = async (productId: string, page: number): Promise<OttoReview[]> => {
  const res = await throttled(`/dcs/cr/reviews/${productId}?sort=byDate&page=${page}`);
  if (!res.ok) throw new Error(`otto reviews ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  return [...doc.querySelectorAll<HTMLElement>('.pdp_cr-item-content')].map((item) => ({
    rating: Number(item.dataset.rating) || 0,
    title: item.querySelector('.js_pdp_cr-item__title')?.textContent?.trim() ?? '',
    body: item.querySelector('.js_pdp_cr-item__reviewText')?.textContent?.trim() ?? '',
    // "von Markus S. aus Berlin am 29.11.2025"
    date: item.querySelector('.js_pdp_cr-item__customer')?.textContent?.match(/(\d\d)\.(\d\d)\.(\d{4})/)?.slice(1).reverse().join('-') ?? '',
  }));
};

// Every review up to the newest SAMPLE_MAX, all pages at once: `recent` settles
// with the newest RECENT_REVIEWS for the gauge, `all` with the rest. Kept a week
// in IndexedDB, and only whole, so a failed page's hole is never served.
export const fetchReviews = (productId: string, total: number) => {
  const key = `otto_reviews_v1_${productId}`;
  const cached: Promise<OttoReview[] | null> = idbGet(key, REVIEWS_TTL);
  const pages = cached.then((hit) => (hit ? [] : Array.from({ length: Math.ceil(Math.min(total, SAMPLE_MAX) / PAGE) }, (_, i) => fetchPage(productId, i + 1))));
  const settle = async (of: Promise<OttoReview[]>[]) => {
    const settled = await Promise.allSettled(of);
    return { reviews: settled.flatMap((p) => (p.status === 'fulfilled' ? p.value : [])), whole: settled.every((p) => p.status === 'fulfilled') };
  };
  const recent = cached.then(async (hit) => hit ?? (await settle((await pages).slice(0, Math.ceil(RECENT_REVIEWS / PAGE)))).reviews);
  const all = cached.then(async (hit) => {
    if (hit) return hit;
    const { reviews, whole } = await settle(await pages);
    if (reviews.length && whole) idbSet(key, reviews);
    return reviews;
  });
  return { recent, all };
};
