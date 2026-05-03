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

// --- PDP-specific code ---

const isProductPage = () => /-p\d{6,}\.html/.test(location.pathname);

const addCandidateFromValue = (map: Map<string, number>, value: any, priority = 50) => {
  if (!value) return;
  const normalized = String(value).trim();
  if (!/^\d{5,}$/.test(normalized)) return;
  const existing = map.get(normalized);
  if (existing == null || priority < existing) map.set(normalized, priority);
};

const extractCandidateProductIds = () => {
  const candidates = new Map<string, number>();

  // Highest confidence: structured Product JSON-LD usually contains the main PDP sku.
  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    const text = script.textContent?.trim();
    if (!text || text.length > 500_000) return;

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }

    const stack = [data];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
        continue;
      }
      if (typeof node !== 'object') continue;

      const type = node['@type'];
      const isProduct = Array.isArray(type) ? type.includes('Product') : type === 'Product';
      if (isProduct) {
        addCandidateFromValue(candidates, node.sku, 0);
        addCandidateFromValue(candidates, node.productID, 1);
        addCandidateFromValue(candidates, node.mpn, 2);
      }

      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
  });

  document.querySelectorAll('[data-product-id]').forEach((el) => addCandidateFromValue(candidates, el.getAttribute('data-product-id'), 10));
  document.querySelectorAll('[data-productid]').forEach((el) => addCandidateFromValue(candidates, el.getAttribute('data-productid'), 11));
  document.querySelectorAll('[data-bv-product-id]').forEach((el) => addCandidateFromValue(candidates, el.getAttribute('data-bv-product-id'), 12));
  document.querySelectorAll('meta[itemprop="sku"]').forEach((el) => addCandidateFromValue(candidates, el.getAttribute('content'), 13));
  document.querySelectorAll('input[name="productId"], input[name="dan"], input[name="productid"], input[name="sku"]').forEach((el) => addCandidateFromValue(candidates, (el as HTMLInputElement).value, 14));
  document.querySelectorAll('[data-dan]').forEach((el) => addCandidateFromValue(candidates, el.getAttribute('data-dan'), 40));

  const scripts = document.querySelectorAll(
    'script[type="application/ld+json"], script#__NEXT_DATA__, script[id*="__NEXT_DATA__"], script:not([src])'
  );
  const patterns = [
    { regex: /"sku"\s*:\s*"(\d{5,})"/g, priority: 3 },
    { regex: /"dan"\s*:\s*"(\d{5,})"/g, priority: 5 },
    { regex: /"product(?:I|i)d"\s*:\s*"(\d{5,})"/g, priority: 5 },
    { regex: /"productID"\s*:\s*"(\d{5,})"/g, priority: 5 },
  ];

  for (const script of scripts) {
    const text = script.textContent;
    if (!text || text.length > 1_500_000) continue;
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern.regex)) {
        addCandidateFromValue(candidates, match[1], pattern.priority);
      }
    }
  }

  const urlMatch = location.pathname.match(/-p(\d{6,})\.html/);
  if (urlMatch) addCandidateFromValue(candidates, urlMatch[1], 30);

  return [...candidates.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .map(([id]) => id);
};

const extractExpectedReviewCount = () => {
  const script = document.querySelector('script[data-dmid="review-ui-seo-information"]');
  if (!script?.textContent) return null;
  try {
    const json = JSON.parse(script.textContent);
    const count = Number(json?.aggregateRating?.ratingCount);
    return Number.isFinite(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
};

const buildInsightsPanel = (stats: any) => {
  if (!stats) return null;

  let html = '';

  const recommended = Number(stats.RecommendedCount) || 0;
  const notRecommended = Number(stats.NotRecommendedCount) || 0;
  const recommendTotal = recommended + notRecommended;
  if (recommendTotal > 0) {
    const recPct = Math.round((recommended / recommendTotal) * 100);
    html += `<div style="margin-bottom:10px;display:flex;align-items:center;gap:6px;font-size:13px">
      <strong>${recPct}%</strong> recommend this
      <span style="color:#888;font-size:11px">(${recommended}/${recommendTotal})</span>
    </div>`;
  }

  const secondaryOrder = stats.SecondaryRatingsAveragesOrder || [];
  const secondary = stats.SecondaryRatingsAverages || {};
  for (const key of secondaryOrder) {
    const metric = secondary[key];
    if (!metric || typeof metric.AverageRating !== 'number' || typeof metric.ValueRange !== 'number' || metric.ValueRange <= 0) {
      continue;
    }
    const pct = (metric.AverageRating / metric.ValueRange) * 100;
    const hue = Math.min(120, Math.max(0, (pct - 50) * 3));
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
      <span style="width:170px;flex-shrink:0;font-size:12px;overflow-wrap:break-word">${key}</span>
      <div style="flex:1;height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:hsl(${hue},70%,40%);border-radius:3px"></div>
      </div>
      <span style="width:28px;text-align:right;font-size:12px;font-weight:600">${metric.AverageRating.toFixed(1)}</span>
    </div>`;
  }

  if (!html) return null;

  const panel = document.createElement('div');
  panel.className = 'nps-insights nps-dm-insights';
  panel.style.cssText = 'margin:12px 0;padding:14px;border-radius:8px;background:#f5f5f5;line-height:1.5;color:#333;';
  panel.innerHTML = html; // safe: browser extension with controlled data
  return panel;
};

let generation = 0;
let activeObserver: MutationObserver | null = null;
let initInProgress = false;
let initDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const cleanup = () => {
  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = null;
  }
  document.querySelectorAll('.nps-dm-insights').forEach((el) => el.remove());
  document.querySelectorAll('.nps-dm-rating-badge').forEach((el) => el.remove());
};

const injectScoreBadgeNearRating = (scoreData: { score: number; nps: number }) => {
  const ratingSummary = document.querySelector('[data-dmid="product-detail-rating-summary"]');
  if (!ratingSummary || ratingSummary.querySelector('.nps-dm-rating-badge')) return false;

  const badge = document.createElement('span');
  badge.className = 'nps-score-badge nps-dm-rating-badge';
  badge.style.cssText = `color:${npsColor(scoreData.nps)};font-weight:700;font-size:12px;margin-left:8px;white-space:nowrap;`;
  badge.textContent = `${addCommas(scoreData.score)} (${Math.round(scoreData.nps)}%)`;
  ratingSummary.appendChild(badge);
  return true;
};

const resolvePanelAnchor = () => {
  const ratingSummary = document.querySelector('[data-dmid="product-detail-rating-summary"]');
  const ratingBlock = ratingSummary?.closest('a')?.parentElement?.parentElement;
  if (ratingBlock) return { node: ratingBlock, position: 'after' as const };

  const buybox = document.querySelector('[data-dmid="buybox"]');
  if (buybox) return { node: buybox, position: 'before' as const };

  const reviewAnchor =
    document.querySelector('#dm_bv_container') ||
    document.querySelector('[data-bv-show="reviews"]');
  if (reviewAnchor) return { node: reviewAnchor, position: 'before' as const };

  const title = document.querySelector('[data-dmid="detail-page-headline-product-title"], h1');
  if (title) return { node: title, position: 'after' as const };

  return null;
};

const injectUi = (scoreData: any, stats: any) => {
  const anchor = resolvePanelAnchor();
  if (!anchor) return false;

  if (scoreData) {
    injectScoreBadgeNearRating(scoreData);
  }

  if (!document.querySelector('.nps-dm-insights')) {
    const panel = buildInsightsPanel(stats);
    if (panel) {
      if (anchor.position === 'before') anchor.node.before(panel);
      else anchor.node.after(panel);
    }
  }

  return true;
};

const init = async () => {
  if (!isProductPage()) return;
  if (initInProgress) return;
  initInProgress = true;

  try {
    // Avoid redundant re-fetch if UI is already present.
    if (document.querySelector('.nps-dm-rating-badge')) {
      return;
    }

    const gen = ++generation;
    cleanup();

    const candidates = extractCandidateProductIds();
    if (!candidates.length) return;
    const expectedReviewCount = extractExpectedReviewCount();

    let stats: any = null;
    let fallbackStats: any = null;
    let fallbackTotal = -1;
    for (const productId of candidates) {
      const candidateStats = await fetchStats(productId);
      if (gen !== generation) return;
      if (!candidateStats) continue;

      const candidateTotal = Number(candidateStats.TotalReviewCount) || 0;
      if (candidateTotal > fallbackTotal) {
        fallbackTotal = candidateTotal;
        fallbackStats = candidateStats;
      }

      if (expectedReviewCount != null && candidateTotal === expectedReviewCount) {
        stats = candidateStats;
        break;
      }

      if (expectedReviewCount == null && (candidateStats.RatingDistribution?.length || candidateTotal > 0)) {
        stats = candidateStats;
        break;
      }
    }
    if (!stats) stats = fallbackStats;
    if (!stats) return;

    const scoreData = getScoreFromStats(stats);
    const tryInject = () => {
      if (gen !== generation) {
        if (activeObserver) activeObserver.disconnect();
        return;
      }
      injectUi(scoreData, stats);
    };

    tryInject();
    activeObserver = new MutationObserver(tryInject);
    activeObserver.observe(document.body, { childList: true, subtree: true });
  } finally {
    initInProgress = false;
  }
};

const scheduleInit = () => {
  clearTimeout(initDebounceTimer!);
  initDebounceTimer = setTimeout(() => {
    if (isProductPage()) init();
  }, 200);
};

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  if (isProductPage()) scheduleInit();
  else cleanup();
}).observe(document, { childList: true, subtree: true });

const domObserver = new MutationObserver(() => {
  if (!isProductPage()) return;
  if (document.querySelector('.nps-dm-rating-badge')) return;
  scheduleInit();
});

domObserver.observe(document.body, { childList: true, subtree: true });
scheduleInit();
