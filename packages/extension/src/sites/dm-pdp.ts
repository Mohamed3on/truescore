import { addCommas, npsColor, npsStats } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { buildSummarizeWidget, PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';

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

const REVIEWS_TTL = 24 * 60 * 60 * 1000; // 24h
const REVIEWS_PAGE = 30; // BazaarVoice page size dm itself uses
const REVIEWS_MAX_PAGES = 5; // up to 150 most-recent reviews, fetched in parallel

const buildReviewsUrl = (productId: string, offset: number) => {
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
  params.set('limit', String(REVIEWS_PAGE));
  params.set('offset', String(offset));
  params.set('sort', 'submissiontime:desc');
  params.set('Offset', String(offset));
  params.set('apiversion', '5.5');
  params.set('displaycode', '18357-de_de');
  return `${API_BASE}?${params.toString()}`;
};

interface DmReview {
  rating: number;
  text: string;
}

// Most-recent reviews (BazaarVoice sorts by submissiontime:desc). All pages fire
// in parallel, so the wall-clock cost is a single round-trip no matter how many
// pages we pull. Feeds both the "recent positive" gauge and LLM summarization.
const fetchReviews = async (productId: string, totalCount = REVIEWS_PAGE * REVIEWS_MAX_PAGES): Promise<DmReview[]> => {
  const cacheKey = `dm_reviews_v2_${productId}`;
  const cached = cacheGet(cacheKey, REVIEWS_TTL);
  if (cached) return cached;

  const requestInit: RequestInit = {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    headers: { accept: '*/*', 'bv-bfd-token': BFD_TOKEN },
    referrer: 'https://www.dm.de/',
  };

  const pageCount = Math.min(REVIEWS_MAX_PAGES, Math.max(1, Math.ceil(totalCount / REVIEWS_PAGE)));
  const pages = await Promise.allSettled(
    Array.from({ length: pageCount }, (_, i) =>
      fetch(buildReviewsUrl(productId, i * REVIEWS_PAGE), requestInit).then((r) => (r.ok ? r.json() : null))
    )
  );

  const seen = new Set<string>();
  const reviews: DmReview[] = [];
  for (const page of pages) {
    if (page.status !== 'fulfilled') continue;
    const results = page.value?.response?.Results;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      const text = [r.Title, r.ReviewText].filter(Boolean).join(': ').trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        reviews.push({ rating: Number(r.Rating) || 0, text });
      }
    }
  }
  if (reviews.length) cacheSet(cacheKey, reviews);
  return reviews;
};

const reviewTexts = (reviews: DmReview[]) => reviews.map((r) => r.text);

// Amazon's "% recent positive": NPS over the most-recent reviews — (5★ − 1★) / count.
const recentPositiveRatio = (reviews: DmReview[]): number | null => {
  if (!reviews.length) return null;
  let five = 0;
  let one = 0;
  for (const r of reviews) {
    if (r.rating === 5) five++;
    else if (r.rating === 1) one++;
  }
  return (five - one) / reviews.length;
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

// --- PDP-specific code ---

// dm uses two PDP URL formats: legacy `...-p1298306.html` and the newer `/p/d/1298306/<slug>`.
const isProductPage = () =>
  /-p\d{6,}\.html/.test(location.pathname) || /\/p\/[a-z]+\/\d{6,}\b/.test(location.pathname);

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

  const urlMatch =
    location.pathname.match(/-p(\d{6,})\.html/) || location.pathname.match(/\/p\/[a-z]+\/(\d{6,})\b/);
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

const insightsColor = (pct: number) => `hsl(${Math.min(120, Math.max(0, (pct - 50) * 3))},70%,40%)`;

// Recommend rate (its own line) + key stats + any secondary ratings. The big
// gauge above this is the recent-positive score, built in buildCard.
const appendInsights = (wrapper: HTMLElement, stats: any, scoreData: { score: number; nps: number } | null) => {
  const recommended = Number(stats.RecommendedCount) || 0;
  const recommendTotal = recommended + (Number(stats.NotRecommendedCount) || 0);
  if (recommendTotal > 0) {
    const recPct = Math.round((recommended / recommendTotal) * 100);
    const line = document.createElement('div');
    line.style.cssText = 'font-size:12.5px;color:#57534E';
    line.innerHTML = `<strong style="color:#1C1917;font-weight:700">${recPct}%</strong> recommend this <span style="color:#A8A29E;font-size:11px">(${addCommas(recommended)}/${addCommas(recommendTotal)})</span>`;
    wrapper.appendChild(line);
  }

  const total = Number(stats.TotalReviewCount) || 0;
  const statParts: string[] = [];
  if (scoreData) statParts.push(`<div class="ars-stat"><span class="ars-stat-val" style="color:${npsColor(scoreData.nps)}">${addCommas(scoreData.score)}</span><span class="ars-stat-lbl">score</span></div>`);
  if (total) statParts.push(`<div class="ars-stat"><span class="ars-stat-val">${addCommas(total)}</span><span class="ars-stat-lbl">reviews</span></div>`);
  if (statParts.length) {
    const row = document.createElement('div');
    row.className = 'ars-stats';
    row.innerHTML = statParts.join('<div class="ars-stat-div"></div>');
    wrapper.appendChild(row);
  }

  // Secondary ratings (e.g. scent, effectiveness) as compact bars, when present.
  const secondaryOrder = stats.SecondaryRatingsAveragesOrder || [];
  const secondary = stats.SecondaryRatingsAverages || {};
  let barsHtml = '';
  for (const key of secondaryOrder) {
    const metric = secondary[key];
    if (!metric || typeof metric.AverageRating !== 'number' || typeof metric.ValueRange !== 'number' || metric.ValueRange <= 0) continue;
    const pct = (metric.AverageRating / metric.ValueRange) * 100;
    barsHtml += `<div style="display:flex;align-items:center;gap:8px">
      <span style="width:150px;flex-shrink:0;font-size:11.5px;color:#57534E;overflow-wrap:break-word">${key}</span>
      <div style="flex:1;height:5px;background:#E7E5E4;border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${insightsColor(pct)};border-radius:3px"></div></div>
      <span style="width:26px;text-align:right;font-size:12px;font-weight:700;color:#1C1917">${metric.AverageRating.toFixed(1)}</span>
    </div>`;
  }
  if (barsHtml) {
    const bars = document.createElement('div');
    bars.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-top:2px';
    bars.innerHTML = barsHtml;
    wrapper.appendChild(bars);
  }
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
  document.querySelectorAll('.ars-wrapper').forEach((el) => el.remove());
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

// One unified "Review Intelligence" card: a recent-positive gauge (NPS over the
// latest reviews, Amazon-style) + recommend rate + score/review stats + secondary
// bars, with the summarize/ask widget below it (5+ reviews).
const buildCard = (stats: any, scoreData: { score: number; nps: number } | null, productId: string): HTMLElement | null => {
  const total = Number(stats?.TotalReviewCount) || 0;
  const hasRecommend = (Number(stats?.RecommendedCount) || 0) + (Number(stats?.NotRecommendedCount) || 0) > 0;
  if (!scoreData && !hasRecommend && total < 5) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'ars-wrapper';
  const header = document.createElement('div');
  header.className = 'ars-header';
  header.innerHTML = '<span class="ars-header-accent">&#x25C8;</span> Review Intelligence';
  wrapper.appendChild(header);

  // Recent-positive gauge — placeholder now, filled once recent reviews load.
  const gauge = document.createElement('div');
  gauge.className = 'ars-gauge';
  gauge.style.cursor = 'default';
  gauge.innerHTML = `
    <div class="ars-gauge-label"><span class="ars-gauge-pct">—</span> recent positive <span class="ars-scan-spinner" data-ars="scanning"></span></div>
    <div class="ars-gauge-track"><div class="ars-gauge-fill" style="transform:scaleX(0)"></div></div>`;
  wrapper.appendChild(gauge);

  appendInsights(wrapper, stats, scoreData);

  if (total >= 5 && productId) {
    buildSummarizeWidget({
      wrapper,
      cacheKey: `dm-summary-${productId}`,
      summaryPrompt: PRODUCT_SUMMARY_PROMPT,
      fetchReviews: () => fetchReviews(productId, total).then(reviewTexts),
    });
  }

  // Fill the recent-positive gauge from the most-recent reviews (shares the cache
  // with summarize, so it's one fetch per product). Drop the gauge if none load.
  const stopScan = () => {
    const sp = gauge.querySelector('[data-ars="scanning"]');
    if (sp) {
      sp.classList.add('ars-scan-done');
      sp.addEventListener('animationend', () => sp.remove(), { once: true });
    }
  };
  if (total > 0 && productId) {
    fetchReviews(productId, total)
      .then((reviews) => {
        stopScan();
        const ratio = recentPositiveRatio(reviews);
        if (ratio == null) return gauge.remove();
        const pct = Math.round(ratio * 100);
        const color = npsColor(pct);
        (gauge.querySelector('.ars-gauge-pct') as HTMLElement).textContent = `${pct}%`;
        (gauge.querySelector('.ars-gauge-pct') as HTMLElement).style.color = color;
        const fill = gauge.querySelector('.ars-gauge-fill') as HTMLElement;
        fill.style.background = color;
        fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
      })
      .catch(() => {
        stopScan();
        gauge.remove();
      });
  } else {
    gauge.remove();
  }

  return wrapper;
};

const injectUi = (scoreData: any, stats: any, productId: string) => {
  const anchor = resolvePanelAnchor();
  if (!anchor) return false;

  if (scoreData) injectScoreBadgeNearRating(scoreData);

  if (!document.querySelector('.ars-wrapper')) {
    const card = buildCard(stats, scoreData, productId);
    if (card) {
      if (anchor.position === 'before') anchor.node.before(card);
      else anchor.node.after(card);
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
    let matchedProductId = '';
    let fallbackStats: any = null;
    let fallbackProductId = '';
    let fallbackTotal = -1;
    for (const productId of candidates) {
      const candidateStats = await fetchStats(productId);
      if (gen !== generation) return;
      if (!candidateStats) continue;

      const candidateTotal = Number(candidateStats.TotalReviewCount) || 0;
      if (candidateTotal > fallbackTotal) {
        fallbackTotal = candidateTotal;
        fallbackStats = candidateStats;
        fallbackProductId = productId;
      }

      if (expectedReviewCount != null && candidateTotal === expectedReviewCount) {
        stats = candidateStats;
        matchedProductId = productId;
        break;
      }

      if (expectedReviewCount == null && (candidateStats.RatingDistribution?.length || candidateTotal > 0)) {
        stats = candidateStats;
        matchedProductId = productId;
        break;
      }
    }
    if (!stats) {
      stats = fallbackStats;
      matchedProductId = fallbackProductId;
    }
    if (!stats) return;

    const scoreData = getScoreFromStats(stats);
    const tryInject = () => {
      if (gen !== generation) {
        if (activeObserver) activeObserver.disconnect();
        return;
      }
      injectUi(scoreData, stats, matchedProductId);
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
  // Client-side route change: invalidate any in-flight init and drop the previous
  // product's badge/card so it can't linger as a stale score, then re-init if the
  // new URL is itself a product page. scheduleInit's debounce waits for the new
  // page's DOM (incl. JSON-LD) to settle before resolving the product.
  generation++;
  initInProgress = false;
  cleanup();
  if (isProductPage()) scheduleInit();
}).observe(document, { childList: true, subtree: true });

const domObserver = new MutationObserver(() => {
  if (!isProductPage()) return;
  if (document.querySelector('.nps-dm-rating-badge')) return;
  scheduleInit();
});

domObserver.observe(document.body, { childList: true, subtree: true });
scheduleInit();
