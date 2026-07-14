// Etsy's listing cards and search results show the *shop's* stars, never the
// item's. An item's own review data lives behind the listing page's review
// sheet, served by two bespoke specs that this module wraps: the star histogram
// plus review bodies (`deep_dive_reviews`), and the per-transaction variation
// labels (`listing_async_review_variations`).

import { npsStats } from './utils';
import { cacheGet, cacheSet } from './cache';

const DEEP_DIVE = '/api/v3/ajax/bespoke/member/neu/specs/deep_dive_reviews';
const DEEP_DIVE_SPEC = 'Etsy\\Modules\\ListingPage\\Reviews\\DeepDive\\AsyncApiSpec';
const VARIATIONS = 'listing_async_review_variations';
const VARIATIONS_SPEC = 'Etsy\\Modules\\ListingPage\\Reviews\\VariationsApiSpec';

const SCORE_TTL = 30 * 24 * 60 * 60 * 1000;

// Etsy serves reviews eight to a page and ignores every page-size parameter it
// doesn't recognise, so more reviews only ever means more requests.
export const REVIEWS_PER_PAGE = 8;

// A page index past the last one still returns the histogram, but with no review
// bodies attached — a third of the payload when the counts are all we want.
const HISTOGRAM_ONLY_PAGE = 9999;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface EtsyReview {
  transactionId: number;
  rating: number;
  text: string;
  date?: string;
}

// One of Etsy's curated review aspects (Quality, Sizing & Fit, …). Etsy tags
// every review against a fixed vocabulary and hands back per-aspect sentiment
// already tallied — a breakdown a star average can't express.
export interface Topic {
  tag: string; // the value to filter reviews by (e.g. "Shipping & Packaging")
  name: string; // display label; Etsy sometimes renames (→ "Delivery & Packaging")
  total: number; // reviews mentioning this aspect
  pos: number;
  neg: number;
}

export interface ItemScore {
  score: number;
  nps: number;
  total: number;
  // Rides along in the same histogram response, so the breakdown costs no extra
  // request. Absent from pre-v2 cache entries — always read defensively.
  topics: Topic[];
}

export interface ListingMeta {
  listingId: string;
  shopId: string;
  categoryPath: string[];
}

const csrfToken = () =>
  document.querySelector<HTMLMetaElement>('meta[name="csrf_nonce"]')?.content ?? null;

// `listing_id` is in the URL; `shop_id` and the taxonomy path exist only in the
// page's inlined JSON. The path is inlined solely for listings whose reviews
// carry a purchased variant, so its absence means "no variants to break down" —
// never a reason to give up on the score or the reviews themselves.
export const listingMeta = (): ListingMeta | null => {
  const listingId = location.pathname.match(/\/listing\/(\d+)/)?.[1];
  if (!listingId) return null;

  const html = document.documentElement.innerHTML;
  const shopId = html.match(/"shop_id":(\d+)/)?.[1];
  if (!shopId) return null;

  const categoryPath = html.match(/"category_path":\[([\d,]+)\]/)?.[1];
  return { listingId, shopId, categoryPath: categoryPath ? categoryPath.split(',') : [] };
};

const deepDive = async (
  fetcher: Fetcher,
  listingId: string,
  shopId: string,
  page: number,
  sort: 'Suggested' | 'Recent',
  tagFilters: string[] = []
) => {
  const csrf = csrfToken();
  if (!csrf) return null;

  const res = await fetcher(DEEP_DIVE, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      specs: {
        deep_dive_reviews: [DEEP_DIVE_SPEC, {
          listing_id: Number(listingId),
          shop_id: Number(shopId),
          scope: 'listingReviews', // the seam: `shopReviews` would give the seller's
          page,
          sort_option: sort,
          rating_filter: null,
          tag_filters: tagFilters, // an aspect tag narrows to reviews mentioning it, server-side
          review_highlight_transaction_id: null,
          should_lazy_load_images: true,
          should_show_variations: false,
        }],
      },
    }),
  });
  if (!res.ok) return null;
  return (await res.json())?.jsData ?? null;
};

// Net sentiment over the item's own histogram, cached per listing so a search
// grid and the listing page itself never pay for the same request twice.
export const fetchItemScore = async (
  fetcher: Fetcher,
  listingId: string,
  shopId: string
): Promise<ItemScore | null> => {
  const key = `nps_etsy_v2_${listingId}`; // v2: entries now also carry topic tags
  const cached = cacheGet(key, SCORE_TTL);
  if (cached) return cached;

  const js = await deepDive(fetcher, listingId, shopId, HISTOGRAM_ONLY_PAGE, 'Suggested');
  const counts = js?.ratingCounts;
  const total = counts?.All;
  if (!total) return null;

  const topics: Topic[] = (js?.tagFilters ?? [])
    .map((t: any): Topic => ({
      tag: t.tag,
      name: t.name || t.tag,
      total: t.frequency || 0,
      pos: t.num_pos || 0,
      neg: t.num_neg || 0,
    }))
    .filter((t: Topic) => t.tag && t.total > 0);

  const result = { ...npsStats(counts['5'] || 0, counts['1'] || 0, total), total, topics };
  cacheSet(key, result);
  return result;
};

export const fetchRecentReviews = async (
  fetcher: Fetcher,
  { listingId, shopId }: ListingMeta,
  page: number
): Promise<EtsyReview[]> => {
  const js = await deepDive(fetcher, listingId, shopId, page, 'Recent');
  return (js?.reviews ?? []).map((r: any) => ({
    transactionId: r.transactionId,
    rating: r.reviewInfo?.rating ?? 0,
    text: (r.reviewContent?.reviewText ?? '').trim(),
  }));
};

// Reviews that mention one aspect tag, filtered server-side so this spans every
// matching review. Sorted newest-first, not by 'Suggested': Etsy's relevance
// order leads with glowing 5★ reviews and buries the complaints — and an
// aspect's complaints are exactly what the reader clicked in to find.
export const fetchTopicReviews = async (
  fetcher: Fetcher,
  { listingId, shopId }: ListingMeta,
  tag: string,
  page = 1
): Promise<EtsyReview[]> => {
  const js = await deepDive(fetcher, listingId, shopId, page, 'Recent', [tag]);
  return (js?.reviews ?? []).map((r: any) => ({
    transactionId: r.transactionId,
    rating: r.reviewInfo?.rating ?? 0,
    text: (r.reviewContent?.reviewText ?? '').trim(),
    date: r.reviewInfo?.reviewDate ?? '',
  }));
};

// Which variant each reviewer actually bought, keyed by transaction. Etsy hands
// this back as rendered HTML, and refuses the request without both the
// `x-etsy-protection` header and the listing's `category_path` — an empty path
// answers 200 with an empty body, so don't bother asking.
export const fetchVariations = async (
  fetcher: Fetcher,
  { listingId, shopId, categoryPath }: ListingMeta,
  transactionIds: number[]
): Promise<Map<number, [string, string][]>> => {
  const found = new Map<number, [string, string][]>();
  if (!categoryPath.length) return found;

  const qs = new URLSearchParams();
  qs.set('log_performance_metrics', 'false');
  qs.append(`specs[${VARIATIONS}][]`, VARIATIONS_SPEC);
  for (const id of transactionIds) qs.append(`specs[${VARIATIONS}][1][transaction_ids][]`, String(id));
  qs.set(`specs[${VARIATIONS}][1][shop_id]`, shopId);
  qs.set(`specs[${VARIATIONS}][1][listing_id]`, listingId);
  for (const c of categoryPath) qs.append(`specs[${VARIATIONS}][1][category_path][]`, c);

  const res = await fetcher(`/api/v3/ajax/bespoke/public/neu/specs/${VARIATIONS}?${qs}`, {
    credentials: 'include',
    headers: { 'x-requested-with': 'XMLHttpRequest', 'x-etsy-protection': '1' },
  });
  if (!res.ok) return found;

  const html = (await res.json())?.output?.[VARIATIONS];
  if (!html) return found;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const block of doc.querySelectorAll('[data-variation]')) {
    const id = Number(block.getAttribute('data-variation'));
    const pairs: [string, string][] = [];
    for (const item of block.querySelectorAll('.variation-info')) {
      const [dim, value] = [...item.querySelectorAll('p')].map((p) => (p.textContent ?? '').trim());
      if (dim && value) pairs.push([dim.replace(/:$/, ''), value]);
    }
    if (pairs.length) found.set(id, pairs);
  }
  return found;
};
