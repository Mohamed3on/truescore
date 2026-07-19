import { npsStats } from '../shared/utils';
import { cacheGet, cacheGetMaybe, cacheSet, cacheSetMaybe } from '../shared/cache';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { setupScoreGrid } from '../shared/score-grid';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const API_BASE = 'https://apps.bazaarvoice.com/bfd/v1/clients/dm-de/api-products/cv2/resources/data/reviews.json';
const BFD_TOKEN = '18357,main_site,de_DE';
const throttledFetch = createThrottledFetcher(8);

const buildUrl = (productId: string, withMediaFilter: boolean) => {
  const params = new URLSearchParams();
  params.set('resource', 'reviews');
  params.set('action', withMediaFilter ? 'PHOTOS_TYPE' : 'REVIEWS_N_STATS');
  params.append('filter', `productid:eq:${productId}`);
  params.append('filter', 'contentlocale:eq:de*,de_DE,de_DE');
  params.append('filter', 'isratingsonly:eq:false');
  if (withMediaFilter) params.append('filter', 'HasMedia:eq:true');
  params.set('filter_reviews', 'contentlocale:eq:de*,de_DE,de_DE');
  params.set('include', withMediaFilter ? 'authors,products,comments' : 'products');
  params.set('filteredstats', 'reviews');
  params.set('Stats', 'Reviews');
  params.set('limit', '1');
  params.set('offset', '0');
  if (withMediaFilter) params.set('limit_comments', '3');
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

  const urls = [buildUrl(productId, true), buildUrl(productId, false)];
  let definitive = true;
  for (const url of urls) {
    try {
      const res = await throttledFetch(url, requestInit);
      if (!res.ok) { definitive = false; continue; }
      const json = await res.json();
      const stats = extractStats(json, productId);
      if (stats) {
        cacheSet(cacheKey, stats);
        return stats;
      }
    } catch {
      definitive = false;
    }
  }

  // Both endpoints answered with no stats: a review-less product. Tombstoned so
  // recreated cards don't refire the request; transport failures stay uncached.
  if (definitive) cacheSetMaybe(cacheKey, null);
  return null;
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
  const cacheKey = `nps_dm_score_${productId}`;
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
