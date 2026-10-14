import { addCommas, npsColor, npsStats } from './utils';
import { cacheGet, cacheGetMaybe, cacheSet, cacheSetMaybe } from './cache';
import { idbGet, idbSet } from './idb-cache';
import { createThrottledFetcher } from './throttled-fetch';
import { buildSummarizeWidget, keywordSummaryPrompt, PRODUCT_SUMMARY_PROMPT, SAMPLE_MAX, summarizeMatches } from './review-summary';
import { buildSearchSection, localSearch, quoteCards, runSearch, searchWith } from './review-search';
import type { SearchAsk } from './review-ask';
import { setupSpaInjector } from './spa-injector';
import { appendStat, buildRecentGauge, createIslandShell, fillRecentGauge } from './score-island';
import { adjust, RECENT_REVIEWS, recentRatio } from './recency';

// The BazaarVoice review API behind dm's and DocMorris's reviews, called the way
// each site's own review widget calls it. Only the client and its display config
// differ per site; `key` names the site's caches.
export interface BvSite {
  key: string;
  client: string;
  token: string;
  displaycode: string;
  referrer: string;
}

export const DM: BvSite = {
  key: 'dm',
  client: 'dm-de',
  token: '18357,main_site,de_DE',
  displaycode: '18357-de_de',
  referrer: 'https://www.dm.de/',
};

export const DOCMORRIS: BvSite = {
  key: 'docmorris',
  client: 'docmorris',
  token: '18405_2_0,new_frontend,de_DE',
  displaycode: '18405_2_0-de_de',
  referrer: 'https://www.docmorris.de/',
};

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const REVIEWS_TTL = 7 * 24 * 60 * 60 * 1000;
const REVIEWS_PAGE = 100; // the most BazaarVoice hands over per request

// A page of a product's reviews, newest first. The product's stats ride along
// with any page; one review is the smallest. (A photo-reviews-only query used to
// go first, but it carries no stats for a product without photo reviews, so most
// products paid for both.)
const reviewsUrl = (site: BvSite, productId: string, limit: number, offset: number, search?: string) => {
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
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.set('sort', 'submissiontime:desc');
  params.set('Offset', String(offset));
  params.set('apiversion', '5.5');
  params.set('displaycode', site.displaycode);
  if (search) params.set('search', search);
  return `https://apps.bazaarvoice.com/bfd/v1/clients/${site.client}/api-products/cv2/resources/data/reviews.json?${params.toString()}`;
};

// Shared by the stats + reviews BazaarVoice calls.
const requestInit = (site: BvSite): RequestInit => ({
  method: 'GET',
  mode: 'cors',
  credentials: 'omit',
  headers: { accept: '*/*', 'bv-bfd-token': site.token },
  referrer: site.referrer,
});

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

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const fetchStats = async (site: BvSite, productId: string, fetcher: Fetcher = fetch) => {
  const cacheKey = `nps_${site.key}_stats_${productId}`;
  const cached = cacheGetMaybe(cacheKey, CACHE_TTL);
  if (cached) return cached.value;

  try {
    const res = await fetcher(reviewsUrl(site, productId, 1, 0), requestInit(site));
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

interface RatingLabel {
  label: string;
  ends?: [string, string]; // a slider's 1 and its top value
}

// The JSON object starting at `start` in `text`.
const objectAt = (text: string, start: number) => {
  let depth = 0;
  for (let i = start, inString = false; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return '';
};

// The stats name a secondary rating by id only ("EintrittDerWirkung_5"). Its label,
// and a slider's two ends, are in the site's review-widget config: a script whose
// "ratings" object is JSON, at the deployment the bfd token names (zone, locale).
const fetchRatingLabels = async (site: BvSite): Promise<Record<string, RatingLabel> | null> => {
  const cacheKey = `${site.key}_rating_labels`;
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;

  const [, zone, locale] = site.token.split(',');
  try {
    const res = await fetch(`https://apps.bazaarvoice.com/deployments/${site.client}/${zone}/production/${locale}/swat_reviews-config.js`);
    if (!res.ok) return null;
    const js = await res.text();
    const ratings: any[] = Object.values(JSON.parse(objectAt(js, js.indexOf('"ratings":{') + '"ratings":'.length)));
    const labels = Object.fromEntries(ratings.filter((r) => !r.hideDisplay).map((r) => [r.id, {
      // DocMorris marks its retired dimensions "x - …".
      label: String(r.displayLabel).replace(/^x - /, ''),
      ends: r.type === 'SLIDER' ? [r.sliderDimension1Label, r.sliderDimension2Label] : undefined,
    }]));
    cacheSet(cacheKey, labels);
    return labels;
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

// A product card's score for a listing grid, eight requests at a time; a product
// page already visited has its stats cached.
export const cardScores = (site: BvSite) => {
  const throttledFetch = createThrottledFetcher(8);
  return async (productId: string) => getScoreFromStats(await fetchStats(site, productId, throttledFetch));
};

interface BvReview {
  rating: number;
  title: string;
  body: string;
  date: string;
}

const reviewToText = (r: BvReview) => [r.title, r.body].filter(Boolean).join(': ').trim();

const reviewFields = (r: BvReview) => ({ rating: r.rating, title: r.title, body: r.body, meta: r.date });

// One page of reviews, newest first, with the count of every review it's a page of.
const fetchPage = async (site: BvSite, productId: string, offset: number, search?: string) => {
  const res = await fetch(reviewsUrl(site, productId, REVIEWS_PAGE, offset, search), requestInit(site));
  if (!res.ok) throw new Error(`${site.key} reviews ${res.status}`);
  const response = (await res.json())?.response;
  const reviews: BvReview[] = (response?.Results ?? []).map((r: any) => ({
    rating: Number(r.Rating) || 0,
    title: r.Title || '',
    body: r.ReviewText || '',
    date: String(r.SubmissionTime || '').slice(0, 10),
  }));
  return { reviews, total: Number(response?.TotalResults) || 0 };
};

// First of each review text: syndicated copies repeat it verbatim.
const dedupe = (reviews: BvReview[]) => {
  const seen = new Set<string>();
  return reviews.filter((r) => {
    const text = reviewToText(r);
    if (!text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
};

// Every review up to the newest SAMPLE_MAX, newest first: page 0 at once, the
// rest in parallel as soon as `total` says how many there are. `recent` settles
// with the newest RECENT_REVIEWS for the gauge; `all` feeds the Summary/Ask and
// the search. Kept a week in IndexedDB, and only whole: a failed page's hole would
// otherwise be served for the week.
const fetchReviews = (site: BvSite, productId: string, total: Promise<number>) => {
  const cacheKey = `${site.key}_reviews_v4_${productId}`;
  const cached: Promise<BvReview[] | null> = idbGet(cacheKey, REVIEWS_TTL);
  const pages = cached.then((hit) => {
    if (hit) return [];
    const first = fetchPage(site, productId, 0);
    return total.then((count) => [
      first,
      ...Array.from({ length: Math.ceil(Math.min(count, SAMPLE_MAX) / REVIEWS_PAGE) - 1 }, (_, i) => fetchPage(site, productId, (i + 1) * REVIEWS_PAGE)),
    ]);
  });
  const settle = async (of: Promise<Awaited<ReturnType<typeof fetchPage>>>[]) => {
    const settled = await Promise.allSettled(of);
    return { reviews: dedupe(settled.flatMap((p) => (p.status === 'fulfilled' ? p.value.reviews : []))), whole: settled.every((p) => p.status === 'fulfilled') };
  };
  const recent = cached.then(async (hit) => hit ?? (await settle((await pages).slice(0, RECENT_REVIEWS / REVIEWS_PAGE))).reviews);
  const all = cached.then(async (hit) => {
    if (hit) return hit;
    const { reviews, whole } = await settle(await pages);
    if (reviews.length && whole) idbSet(cacheKey, reviews);
    return reviews;
  });
  return { recent, all };
};

const reviewTexts = (reviews: BvReview[]) => reviews.map(reviewToText).filter(Boolean);

// Every review holding `term`, through BazaarVoice's own full-text search. It ORs
// a term's words and drops stop-words ("zu klein" finds every "klein"), so a term
// of several words reads its hits up to SAMPLE_MAX and keeps the ones holding it
// whole; one word takes BazaarVoice's own count and its newest hundred hits.
const searchTerm = async (site: BvSite, productId: string, term: string) => {
  const first = await fetchPage(site, productId, 0, term);
  if (!/\s/.test(term)) return first;
  const offsets = Array.from({ length: Math.ceil(Math.min(first.total, SAMPLE_MAX) / REVIEWS_PAGE) - 1 }, (_, i) => (i + 1) * REVIEWS_PAGE);
  const rest = await Promise.all(offsets.map((offset) => fetchPage(site, productId, offset, term)));
  const reviews = [first, ...rest].flatMap((p) => p.reviews).filter((r) => reviewToText(r).toLowerCase().includes(term));
  return { reviews, total: reviews.length };
};

// Search every review past the Sample through BazaarVoice, one search per OR term.
// One term's count is its own; several terms' is what their union holds. Queries
// are kept, so backspacing doesn't refire them.
const makeReviewSearch = (site: BvSite, productId: string) => {
  const cache = new Map<string, { matches: BvReview[]; total: number }>();
  return async (terms: string[]) => {
    const key = terms.join(' OR ');
    let hit = cache.get(key);
    if (!hit) {
      const found = await Promise.all(terms.map((t) => searchTerm(site, productId, t)));
      const matches = dedupe(found.flatMap((f) => f.reviews));
      hit = { matches, total: found.length === 1 ? found[0].total : matches.length };
      cache.set(key, hit);
    }
    return hit;
  };
};

// Search the Sample itself, which holds every review up to SAMPLE_MAX: exact
// phrases, and no request per query.
const sampleSearch = (reviews: Promise<BvReview[]>) => {
  const find = reviews.then((all) => localSearch(all, reviewFields));
  return async (terms: string[]) => ({ matches: (await find)(terms) });
};

// --- Product page ---

const appendInsights = (wrapper: HTMLElement, stats: any, scoreData: { score: number; nps: number } | null, labels: Record<string, RatingLabel> | null) => {
  const total = Number(stats.TotalReviewCount) || 0;
  const recommended = Number(stats.RecommendedCount) || 0;
  const recommendTotal = recommended + (Number(stats.NotRecommendedCount) || 0);
  const statParts: string[] = [];
  if (scoreData) statParts.push(`<div class="ars-stat"><span class="ars-stat-val" style="color:${npsColor(scoreData.nps)}">${addCommas(scoreData.score)}</span><span class="ars-stat-lbl">score</span></div>`);
  if (total) statParts.push(`<div class="ars-stat"><span class="ars-stat-val">${addCommas(total)}</span><span class="ars-stat-lbl">reviews</span></div>`);
  if (recommendTotal > 0) statParts.push(`<div class="ars-stat" title="${addCommas(recommended)} of ${addCommas(recommendTotal)} recommend it"><span class="ars-stat-val">${Math.round((recommended / recommendTotal) * 100)}%</span><span class="ars-stat-lbl">recommend</span></div>`);
  if (statParts.length) {
    const row = document.createElement('div');
    row.className = 'ars-stats';
    row.innerHTML = statParts.join('<div class="ars-stat-div"></div>');
    wrapper.appendChild(row);
  }

  // Secondary ratings (effect, tolerability…) on one line, under the site's own
  // labels. A slider runs from its bad end to its good end like a rating does,
  // except Passform (fit), which is best in the middle and so goes uncoloured.
  const ratings = (stats.SecondaryRatingsAveragesOrder || []).flatMap((id: string) => {
    const metric = stats.SecondaryRatingsAverages?.[id];
    const named = labels?.[id];
    if (!named || typeof metric?.AverageRating !== 'number' || !(metric.ValueRange > 0)) return [];
    const color = /passform/i.test(named.label) ? '#1C1917' : npsColor((metric.AverageRating / metric.ValueRange) * 100);
    const scale = named.ends ? ` title="1 = ${named.ends[0]}, ${metric.ValueRange} = ${named.ends[1]}"` : '';
    return `<span${scale}>${named.label} <strong style="color:${color};font-weight:700;font-variant-numeric:tabular-nums">${metric.AverageRating.toFixed(1)}</strong></span>`;
  });
  if (ratings.length) {
    const line = document.createElement('div');
    line.style.cssText = 'display:flex;flex-wrap:wrap;gap:2px 14px;font-size:12px;color:#57534E';
    line.innerHTML = ratings.join('');
    wrapper.appendChild(line);
  }
};

interface PdpData {
  stats: any;
  labels: Record<string, RatingLabel> | null;
  scoreData: { score: number; nps: number } | null;
  productId: string;
  reviews: ReturnType<typeof fetchReviews>;
}

// One unified "Review Intelligence" card: a recent-positive gauge (NPS over the
// latest reviews, Amazon-style) + score/review/recommend stats + secondary
// ratings, with the summarize/ask widget below it (5+ reviews).
const buildCard = (
  site: BvSite,
  exampleQuery: string,
  { stats, labels, scoreData, productId, reviews: { recent, all } }: PdpData,
): HTMLElement | null => {
  const total = Number(stats?.TotalReviewCount) || 0;
  const hasRecommend = (Number(stats?.RecommendedCount) || 0) + (Number(stats?.NotRecommendedCount) || 0) > 0;
  if (!scoreData && !hasRecommend && total < 5) return null;

  const wrapper = createIslandShell();

  // Recent-positive gauge — placeholder now, filled once recent reviews load.
  const gauge = buildRecentGauge();
  wrapper.appendChild(gauge);

  appendInsights(wrapper, stats, scoreData, labels);

  if (total >= 5) {
    // Past SAMPLE_MAX, BazaarVoice's own search reaches the reviews the Sample
    // lacks, for the box and for an Ask's Searches alike.
    const remote = total > SAMPLE_MAX ? makeReviewSearch(site, productId) : null;
    const searchAsk: SearchAsk | undefined = remote ? {
      search: searchWith((terms) => remote(terms).then((hit) => hit.matches), reviewToText, (r) => r.rating),
      open: (query) => runSearch(wrapper, query),
    } : undefined;
    const summaryKey = `${site.key}-summary-${productId}`;

    // Above the summarize widget, the same way it sits on the other PDP islands.
    wrapper.appendChild(buildSearchSection({
      reviews: [],
      total,
      search: remote ?? sampleSearch(all),
      fields: reviewFields,
      toText: reviewToText,
      summaryPrompt: keywordSummaryPrompt,
      exampleQuery,
      mountSummarize: summarizeMatches(summaryKey, { searchAsk }),
    }));

    buildSummarizeWidget({
      wrapper,
      cacheKey: summaryKey,
      summaryPrompt: PRODUCT_SUMMARY_PROMPT,
      fetchReviews: () => all.then(reviewTexts),
      searchAsk,
      renderQuote: quoteCards(() => all, reviewToText, reviewFields),
    });
  }

  // Fill the recent-positive gauge from the newest RECENT_REVIEWS, which land
  // first. Drop the gauge if none load; land the adjusted stat (score damped by
  // the recent ratio) beside the others.
  if (total > 0) {
    recent
      .then((reviews) => {
        const ratio = recentRatio(reviews.slice(0, RECENT_REVIEWS).map((r) => r.rating));
        fillRecentGauge(gauge, ratio);
        if (ratio != null && scoreData) {
          const row = wrapper.querySelector<HTMLElement>('.ars-stats');
          if (row) appendStat(row, addCommas(adjust(scoreData.score, ratio)), 'adjusted');
        }
      })
      .catch(() => fillRecentGauge(gauge, null));
  } else {
    gauge.remove();
  }

  return wrapper;
};

export interface BvPdp {
  // The product's BazaarVoice id, from the URL; null off a product page.
  productId: () => string | null;
  // The host's own rating line, which the score badge joins.
  ratingLine: () => Element | null;
  panelAnchor: () => { node: Element; position: 'before' | 'after' } | null;
  exampleQuery: string;
  // Settles once the host page may be written to (a server-rendered host's
  // hydration); the requests start before it.
  ready?: Promise<void>;
}

// The id is in the URL, so load() needs no page DOM — the URL-id single-entity
// PDP shape ADR 0001 describes, same as ikea-pdp/decathlon-pdp. inject() re-runs
// on body mutations until the host has rendered an anchor to attach to.
export const setupBazaarvoicePdp = (site: BvSite, { productId: productIdFromUrl, ratingLine, panelAnchor, exampleQuery, ready }: BvPdp) => {
  const injectScoreBadge = (scoreData: { score: number; nps: number }) => {
    const line = ratingLine();
    if (!line || line.querySelector('.nps-pdp-badge')) return;

    const badge = document.createElement('span');
    badge.className = 'nps-score-badge nps-pdp-badge';
    badge.style.cssText = `color:${npsColor(scoreData.nps)};font-weight:700;font-size:12px;margin-left:8px;white-space:nowrap;`;
    badge.textContent = `${addCommas(scoreData.score)} (${Math.round(scoreData.nps)}%)`;
    line.appendChild(badge);
  };

  setupSpaInjector<PdpData>({
    match: () => !!productIdFromUrl(),
    load: async () => {
      const productId = productIdFromUrl();
      if (!productId) return null;
      const statsPromise = fetchStats(site, productId);
      // Reviews start downloading alongside the stats that size them, not once the
      // host has rendered an anchor for the card.
      const reviews = fetchReviews(site, productId, statsPromise.then((stats) => Number(stats?.TotalReviewCount) || 0));
      // Only a product rated on secondary dimensions needs their labels.
      const labelsPromise = statsPromise.then((stats) => (stats?.SecondaryRatingsAveragesOrder?.length ? fetchRatingLabels(site) : null));
      const [stats, labels] = await Promise.all([statsPromise, labelsPromise, ready]);
      if (!stats) return null;
      return { stats, labels, scoreData: getScoreFromStats(stats), productId, reviews };
    },
    inject: (data) => {
      if (data.scoreData) injectScoreBadge(data.scoreData);

      // Card already placed — skip the anchor resolution on every later mutation.
      if (document.querySelector('.ars-wrapper')) return;

      const anchor = panelAnchor();
      if (!anchor) return;

      const card = buildCard(site, exampleQuery, data);
      if (card) {
        if (anchor.position === 'before') anchor.node.before(card);
        else anchor.node.after(card);
      }
    },
    cleanup: () => document.querySelectorAll('.nps-pdp-badge, .ars-wrapper').forEach((el) => el.remove()),
  });
};
