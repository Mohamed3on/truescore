import { npsStats } from '../shared/utils';
import { cacheGet, cacheGetMaybe, cacheSet, cacheSetMaybe } from '../shared/cache';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { setupScoreGrid } from '../shared/score-grid';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const API_BASE = 'https://apps.bazaarvoice.com/bfd/v1/clients/dm-de/api-products/cv2/resources/data/reviews.json';
const BFD_TOKEN = '18357,main_site,de_DE';
const throttledFetch = createThrottledFetcher(8);

// The product's stats ride along with any page of its reviews; one review is the
// smallest page. (A photo-reviews-only query used to go first, but it carries no
// stats for a product without photo reviews, so most products paid for both.)
const buildUrl = (productId: string) => {
  const params = new URLSearchParams();
  params.set('resource', 'reviews');
  params.set('action', 'REVIEWS_N_STATS');
  params.append('filter', `productid:eq:${productId}`);
  params.append('filter', 'contentlocale:eq:de*,de_DE,de_DE');
  params.append('filter', 'isratingsonly:eq:false');
  params.set('filter_reviews', 'contentlocale:eq:de*,de_DE,de_DE');
  params.set('include', 'products');
  params.set('filteredstats', 'reviews');
  params.set('Stats', 'Reviews');
  params.set('limit', '1');
  params.set('offset', '0');
  params.set('sort', 'submissiontime:desc');
  params.set('Offset', '0');
  params.set('apiversion', '5.5');
  params.set('displaycode', '18357-de_de');
  return `${API_BASE}?${params.toString()}`;
};

const extractStats = (payload: any, requestedProductId: string) => {
  const response = payload?.response;
  const products = response?.Includes?.Products;
  if (!products) return null;

  if (products[requestedProductId]?.ReviewStatistics) {
    return products[requestedProductId].ReviewStatistics;
  }

  const productsOrder = response?.Includes?.ProductsOrder || [];
  for (const id of productsOrder) {
    const stats = products[id]?.ReviewStatistics;
    if (stats) return stats;
  }

  for (const id of Object.keys(products)) {
    const stats = products[id]?.ReviewStatistics;
    if (stats) return stats;
  }

  return null;
};

const fetchStats = async (productId: string) => {
  const cacheKey = `nps_dm_stats_${productId}`;
  const cached = cacheGetMaybe(cacheKey, CACHE_TTL);
  if (cached) return cached.value;

  const requestInit: RequestInit = {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    headers: {
      accept: '*/*',
      'bv-bfd-token': BFD_TOKEN,
    },
    referrer: 'https://www.dm.de/',
  };

  try {
    const res = await throttledFetch(buildUrl(productId), requestInit);
    if (!res.ok) return null;
    const stats = extractStats(await res.json(), productId);
    // An answer with no stats: this id genuinely has no reviews. Tombstoned so
    // recreated cards stop re-firing the same doomed request; transport failures
    // stay uncached and retry.
    if (stats) cacheSet(cacheKey, stats);
    else cacheSetMaybe(cacheKey, null);
    return stats;
  } catch {
    return null;
  }
};

const getScoreFromStats = (stats: any) => {
  const dist = stats?.RatingDistribution;
  if (!dist?.length) return null;

  let five = 0;
  let one = 0;
  let total = Number(stats.TotalReviewCount) || 0;
  if (!total) total = dist.reduce((sum: number, entry: any) => sum + (entry?.Count || 0), 0);
  if (!total) return null;

  for (const entry of dist) {
    if (entry?.RatingValue === 5) five = entry?.Count || 0;
    if (entry?.RatingValue === 1) one = entry?.Count || 0;
  }

  return { ...npsStats(five, one, total), total, five, one };
};

const fetchScore = async (productId: string) => {
  const cacheKey = `nps_dm_score_v2_${productId}`; // v2: scores keep their sign (netScore)
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;

  const pdpCached = cacheGet(`nps_dm_stats_${productId}`, CACHE_TTL);
  if (pdpCached?.RatingDistribution?.length) {
    const score = getScoreFromStats(pdpCached);
    if (score) {
      cacheSet(cacheKey, score);
      return score;
    }
  }

  const stats = await fetchStats(productId);
  if (stats) {
    const score = getScoreFromStats(stats);
    if (score) {
      cacheSet(cacheKey, score);
      return score;
    }
  }

  return null;
};

// dm nests its tiles in a `product-tiles` grid, or falls back to an ol/ul.
const discover = (cards: Element[]) => {
  const containers = new Set<Element>();
  for (const card of cards) {
    const container =
      card.closest('[data-dmid="product-tiles"]') || card.closest('ol') || card.closest('ul');
    if (container) containers.add(container);
  }
  return containers;
};

setupScoreGrid({
  cardSelector: '[data-dmid="product-tile"][data-dan]',
  scoreForCard: (card) => {
    const productId = card.getAttribute('data-dan');
    return productId ? fetchScore(productId) : Promise.resolve(null);
  },
  placeBadge: (card, badge) => {
    const rating = card.querySelector('[data-dmid="product-tile-rating"]');
    const fallback = card.querySelector('[data-dmid="price-infos"]');
    if (rating) rating.after(badge);
    else if (fallback) fallback.after(badge);
  },
  discover,
});
