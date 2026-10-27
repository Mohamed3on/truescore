import { cacheGet, cacheGetMaybe, cacheSet, cacheSetMaybe } from './cache';
import { idbGet, idbSet } from './idb-cache';
import { createThrottledFetcher } from './throttled-fetch';
import { SAMPLE_MAX } from './review-summary';
import { RECENT_REVIEWS } from './recency';
import { npsStats } from './utils';

// Printful's catalog serves a product's reviews from its own RPC, behind the
// page's Yii CSRF token: filtered by stars, newest first, at most 50 a page.
// Its pages name a product by slug; the numeric id the RPC wants sits only in
// the product page's HTML.

export interface PrintfulReview {
  rating: number;
  body: string;
  date: string;
  color: string;
  size: string;
}

const ID_TTL = 365 * 24 * 60 * 60 * 1000;
const COUNTS_TTL = 7 * 24 * 60 * 60 * 1000;
const REVIEWS_TTL = 7 * 24 * 60 * 60 * 1000;
const PAGE = 50;

// A category page asks for every card at once.
const throttled = createThrottledFetcher(6);

interface RpcItem { overallRating: number; review: string | null; createdAt: number; variantInfo?: { color?: string; size?: string } }

interface RpcPage { total: number; totalCountBeforeFilters: number; items: RpcItem[] }

const getReviews = async (productId: string, page: number, perPage: number, stars: number[] = []): Promise<RpcPage> => {
  const res = await throttled('/rpc/product-reviews-rpc/get-reviews', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '',
    },
    body: JSON.stringify({ productId: Number(productId), page, perPage, stars, sortBy: 'most_recent' }),
  });

  if (!res.ok) throw new Error(`printful reviews ${res.status}`);

  return (await res.json()).result.reviews;
};

// The id in a product page's HTML: a Vue prop, `:product-id` until the app
// mounts it. Kept a year: an id never changes.
const ID_ATTR = /product-id="(\d+)"/;

export const pageProductId = () => document.querySelector('[product-id], [\\:product-id]')?.outerHTML.match(ID_ATTR)?.[1] ?? null;

export const productIdOf = async (path: string): Promise<string | null> => {
  const key = `printful_id_v1_${path}`;
  const cached = cacheGet(key, ID_TTL);

  if (cached) return cached;
  const res = await throttled(path);

  if (!res.ok) return null;
  const id = (await res.text()).match(ID_ATTR)?.[1] ?? null;

  if (id) cacheSet(key, id);

  return id;
};

// The 5★ and 1★ counts out of the total, two one-review pages. A product with
// no reviews is tombstoned.
export const productScore = async (productId: string) => {
  const key = `printful_counts_v1_${productId}`;
  const cached = cacheGetMaybe(key, COUNTS_TTL);
  let counts: { five: number; one: number; total: number } | null;

  if (cached) counts = cached.value;
  else {
    const [five, one] = await Promise.all([getReviews(productId, 1, 1, [5]), getReviews(productId, 1, 1, [1])]);
    counts = five.totalCountBeforeFilters ? { five: five.total, one: one.total, total: five.totalCountBeforeFilters } : null;
    cacheSetMaybe(key, counts);
  }

  return counts && { ...npsStats(counts.five, counts.one, counts.total), total: counts.total };
};

const fetchPage = async (productId: string, page: number): Promise<PrintfulReview[]> =>
  (await getReviews(productId, page, PAGE)).items.map((r) => ({
    rating: r.overallRating,
    body: r.review?.trim() ?? '',
    date: new Date(r.createdAt * 1000).toISOString().slice(0, 10),
    color: r.variantInfo?.color ?? '',
    size: r.variantInfo?.size ?? '',
  }));

// Every review up to the newest SAMPLE_MAX, all pages at once: `recent` settles
// with the newest RECENT_REVIEWS for the gauge, `all` with the rest. Kept a week
// in IndexedDB, and only whole, so a failed page's hole is never served.
export const fetchReviews = (productId: string, total: number) => {
  const key = `printful_reviews_v2_${productId}`;
  const cached: Promise<PrintfulReview[] | null> = idbGet(key, REVIEWS_TTL);
  const pages = cached.then((hit) => (hit ? [] : Array.from({ length: Math.ceil(Math.min(total, SAMPLE_MAX) / PAGE) }, (_, i) => fetchPage(productId, i + 1))));

  const settle = async (of: Promise<PrintfulReview[]>[]) => {
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
