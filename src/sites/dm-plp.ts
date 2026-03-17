import { addCommas, npsColor } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const API_BASE = 'https://apps.bazaarvoice.com/bfd/v1/clients/dm-de/api-products/cv2/resources/data/reviews.json';
const BFD_TOKEN = '18357,main_site,de_DE';

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
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;

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
  for (const url of urls) {
    try {
      const res = await fetch(url, requestInit);
      if (!res.ok) continue;
      const json = await res.json();
      const stats = extractStats(json, productId);
      if (stats) {
        cacheSet(cacheKey, stats);
        return stats;
      }
    } catch {}
  }

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

  const nps = ((five - one) / total) * 100;
  const score = Math.round((five - one) * ((five - one) / total));
  return { score, nps, total, five, one };
};

// --- PLP-specific code ---

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

const injectBadge = (tile: Element, scoreData: { score: number; nps: number }) => {
  if (tile.querySelector('.nps-score-badge')) return;

  const badge = document.createElement('span');
  badge.className = 'nps-score-badge';
  badge.style.cssText = `color:${npsColor(scoreData.nps)};font-weight:600;font-size:12px;margin-left:6px;white-space:nowrap;`;
  badge.textContent = `${addCommas(scoreData.score)} (${Math.round(scoreData.nps)}%)`;

  const rating = tile.querySelector('[data-dmid="product-tile-rating"]');
  const fallback = tile.querySelector('[data-dmid="price-infos"]');

  if (rating) rating.after(badge);
  else if (fallback) fallback.after(badge);
};

const tileFromChild = (child: Element) => {
  if (child.matches?.('[data-dmid="product-tile"][data-dan]')) return child;
  return child.querySelector('[data-dmid="product-tile"][data-dan]');
};

const sortContainer = (container: Element) => {
  const children = [...container.children];
  const scoredProducts: { child: Element; score: number }[] = [];
  const unscoredProducts: Element[] = [];
  const nonProducts: Element[] = [];

  for (const child of children) {
    const tile = tileFromChild(child);
    if (!tile) {
      nonProducts.push(child);
      continue;
    }

    const scoreAttr = tile.getAttribute('data-nps');
    const score = scoreAttr == null ? Number.NaN : Number(scoreAttr);
    if (Number.isFinite(score)) scoredProducts.push({ child, score });
    else unscoredProducts.push(child);
  }

  scoredProducts.sort((a, b) => b.score - a.score);
  if (!scoredProducts.length) return;

  sorting = true;
  for (const { child } of scoredProducts) container.appendChild(child);
  for (const child of unscoredProducts) container.appendChild(child);
  for (const child of nonProducts) container.appendChild(child);
  sorting = false;
};

const sortTiles = (tiles: Element[]) => {
  const containers = new Set<Element>();
  for (const tile of tiles) {
    const container =
      tile.closest('[data-dmid="product-tiles"]') ||
      tile.closest('ol') ||
      tile.closest('ul');
    if (container) containers.add(container);
  }
  for (const container of containers) sortContainer(container);
};

let sorting = false;

const processTiles = () => {
  if (sorting) return;

  const tiles = [...document.querySelectorAll('[data-dmid="product-tile"][data-dan]:not([data-nps-done])')];
  if (!tiles.length) return;

  const promises: Promise<void>[] = [];
  for (const tile of tiles) {
    tile.setAttribute('data-nps-done', '1');
    const productId = tile.getAttribute('data-dan');
    if (!productId) continue;

    promises.push(
      fetchScore(productId)
        .then((scoreData) => {
          if (!scoreData || Number.isNaN(scoreData.nps)) return;
          tile.setAttribute('data-nps', String(scoreData.score));
          injectBadge(tile, scoreData);
        })
        .catch(() => {})
    );
  }

  if (promises.length) {
    Promise.all(promises).then(() => {
      sortTiles(tiles);
    });
  }
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const debouncedProcess = () => {
  clearTimeout(debounceTimer!);
  debounceTimer = setTimeout(processTiles, 200);
};

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    processTiles();
    return;
  }
  debouncedProcess();
}).observe(document.body, { childList: true, subtree: true });

processTiles();
