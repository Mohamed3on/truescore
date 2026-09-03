import { addCommas, npsColor, npsStats } from '../shared/utils';
import { cacheGet, cacheGetMaybe, cacheSet, cacheSetMaybe } from '../shared/cache';
import { buildSummarizeWidget, FILTERED_PRODUCT_SUMMARY_PROMPT, PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';
import { buildSearchSection } from '../shared/review-search';
import { setupSpaInjector } from '../shared/spa-injector';
import { appendStat, buildRecentGauge, createIslandShell, fillRecentGauge } from '../shared/score-island';
import { adjust, recentRatio } from '../shared/recency';

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

// Shared by the stats + reviews BazaarVoice calls.
const REVIEW_REQUEST_INIT: RequestInit = {
  method: 'GET',
  mode: 'cors',
  credentials: 'omit',
  headers: { accept: '*/*', 'bv-bfd-token': BFD_TOKEN },
  referrer: 'https://www.dm.de/',
};

const fetchStats = async (productId: string) => {
  const cacheKey = `nps_dm_stats_${productId}`;
  const cached = cacheGetMaybe(cacheKey, CACHE_TTL);
  if (cached) return cached.value;

  const urls = [buildUrl(productId, true), buildUrl(productId, false)];
  let definitive = true;
  for (const url of urls) {
    try {
      const res = await fetch(url, REVIEW_REQUEST_INIT);
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

  // Both endpoints answered with no stats: this id genuinely has no reviews.
  // Tombstoned so candidate sweeps stop re-firing the same doomed requests;
  // transport failures stay uncached and retry.
  if (definitive) cacheSetMaybe(cacheKey, null);
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
  title: string;
  body: string;
  date: string;
}

const reviewToText = (r: DmReview) => [r.title, r.body].filter(Boolean).join(': ').trim();

// Most-recent reviews (BazaarVoice sorts by submissiontime:desc). All pages fire
// in parallel, so the wall-clock cost is a single round-trip no matter how many
// pages we pull. Feeds both the "recent positive" gauge and LLM summarization.
const fetchReviews = async (productId: string, totalCount = REVIEWS_PAGE * REVIEWS_MAX_PAGES): Promise<DmReview[]> => {
  const cacheKey = `dm_reviews_v3_${productId}`;
  const cached = cacheGet(cacheKey, REVIEWS_TTL);
  if (cached) return cached;

  const pageCount = Math.min(REVIEWS_MAX_PAGES, Math.max(1, Math.ceil(totalCount / REVIEWS_PAGE)));
  const pages = await Promise.allSettled(
    Array.from({ length: pageCount }, (_, i) =>
      fetch(buildReviewsUrl(productId, i * REVIEWS_PAGE), REVIEW_REQUEST_INIT).then((r) => (r.ok ? r.json() : null))
    )
  );

  const seen = new Set<string>();
  const reviews: DmReview[] = [];
  for (const page of pages) {
    if (page.status !== 'fulfilled') continue;
    const results = page.value?.response?.Results;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      const review: DmReview = {
        rating: Number(r.Rating) || 0,
        title: r.Title || '',
        body: r.ReviewText || '',
        date: String(r.SubmissionTime || '').slice(0, 10),
      };
      const text = reviewToText(review);
      if (text && !seen.has(text)) {
        seen.add(text);
        reviews.push(review);
      }
    }
  }
  if (reviews.length) cacheSet(cacheKey, reviews);
  return reviews;
};

const reviewTexts = (reviews: DmReview[]) => reviews.map(reviewToText).filter(Boolean);

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

// dm uses two PDP URL formats: legacy `...-p1298306.html` and the newer
// `/p/d/1298306/<slug>`. The id in the path is dm's routing key and doubles as
// the BazaarVoice product id, so it is the whole resolution — the slug is
// decorative (`/p/d/3087729/x` resolves fine).
const productIdFromUrl = () => {
  const match =
    location.pathname.match(/-p(\d{6,})\.html/) || location.pathname.match(/\/p\/[a-z]+\/(\d{6,})\b/);
  return match?.[1] ?? null;
};

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
      <div style="flex:1;height:5px;background:#E7E5E4;border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${npsColor(pct)};border-radius:3px"></div></div>
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

const cleanup = () => {
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

  const wrapper = createIslandShell();

  // Recent-positive gauge — placeholder now, filled once recent reviews load.
  const gauge = buildRecentGauge();
  wrapper.appendChild(gauge);

  appendInsights(wrapper, stats, scoreData);

  // Filled with the review-search section once the corpus lands; sits above the
  // summarize widget the same way it does on the other PDP islands.
  const searchSlot = document.createElement('div');
  wrapper.appendChild(searchSlot);

  if (total >= 5 && productId) {
    buildSummarizeWidget({
      wrapper,
      cacheKey: `dm-summary-${productId}`,
      summaryPrompt: PRODUCT_SUMMARY_PROMPT,
      fetchReviews: () => fetchReviews(productId, total).then(reviewTexts),
    });
  }

  // Fill the recent-positive gauge from the most-recent reviews (shares the cache
  // with summarize, so it's one fetch per product). Drop the gauge if none load;
  // land the adjusted stat (score damped by the recent ratio) beside the others.
  if (total > 0 && productId) {
    fetchReviews(productId, total)
      .then((reviews) => {
        const ratio = recentRatio(reviews.map((r) => r.rating));
        fillRecentGauge(gauge, ratio);
        if (ratio != null && scoreData) {
          const row = wrapper.querySelector<HTMLElement>('.ars-stats');
          if (row) appendStat(row, addCommas(adjust(scoreData.score, ratio)), 'adjusted');
        }
        if (reviews.length >= 5) {
          searchSlot.appendChild(buildSearchSection({
            reviews,
            fields: (r) => ({ rating: r.rating, title: r.title, body: r.body, meta: r.date }),
            toText: reviewToText,
            summaryPrompt: FILTERED_PRODUCT_SUMMARY_PROMPT,
            exampleQuery: 'Duft OR Haut',
          }));
        }
      })
      .catch(() => fillRecentGauge(gauge, null));
  } else {
    gauge.remove();
  }

  return wrapper;
};

const injectUi = (scoreData: any, stats: any, productId: string) => {
  if (scoreData) injectScoreBadgeNearRating(scoreData);

  // Card already placed — skip the anchor resolution on every later mutation.
  if (document.querySelector('.ars-wrapper')) return true;

  const anchor = resolvePanelAnchor();
  if (!anchor) return false;

  const card = buildCard(stats, scoreData, productId);
  if (card) {
    if (anchor.position === 'before') anchor.node.before(card);
    else anchor.node.after(card);
  }

  return true;
};

// The id is in the URL, so load() needs no page DOM — the URL-id single-entity
// PDP shape ADR 0001 describes, same as ikea-pdp/decathlon-pdp. inject() re-runs
// on body mutations until dm has rendered an anchor to attach to.
setupSpaInjector<{ stats: any; scoreData: { score: number; nps: number } | null; productId: string }>({
  match: () => !!productIdFromUrl(),
  load: async () => {
    const productId = productIdFromUrl();
    if (!productId) return null;
    const stats = await fetchStats(productId);
    if (!stats) return null;
    return { stats, scoreData: getScoreFromStats(stats), productId };
  },
  inject: ({ stats, scoreData, productId }) => injectUi(scoreData, stats, productId),
  cleanup,
});
