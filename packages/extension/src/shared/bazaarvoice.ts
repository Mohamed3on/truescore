import { addCommas, el, npsColor, npsStats, toneColor } from './utils';
import { cacheGet, cacheGetMaybe, cacheSet, cacheSetMaybe } from './cache';
import { idbGet, idbSet } from './idb-cache';
import { createThrottledFetcher } from './throttled-fetch';
import { SAMPLE_MAX } from './review-summary';
import { buildReviewPanel } from './review-panel';
import { setupSpaInjector } from './spa-injector';
import { appendStat, createIslandShell } from './score-island';
import { RECENT_REVIEWS } from './recency';
import * as z from 'zod/mini';

// The BazaarVoice review API behind dm's, DocMorris's and Rossmann's reviews, called the way
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

export const ROSSMANN: BvSite = {
  key: 'rossmann',
  client: 'rossmann-de',
  token: '16671,main_site,de_DE',
  displaycode: '16671-de_de',
  referrer: 'https://www.rossmann.de/',
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

  // With the product's family: its pack sizes share one, and one set of reviews.
  const requested = products[requestedProductId];

  if (requested?.ReviewStatistics) {
    return { ...requested.ReviewStatistics, FamilyIds: requested.FamilyIds };
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
  const cacheKey = `nps_${site.key}_stats_v2_${productId}`;
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

    const labels = Object.fromEntries(ratings.flatMap((r) => (r.hideDisplay ? [] : [[r.id, {
      // DocMorris marks its retired dimensions "x - …".
      label: String(r.displayLabel).replace(/^x - /, ''),
      ends: r.type === 'SLIDER' ? [r.sliderDimension1Label, r.sliderDimension2Label] : undefined,
    }]])));

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

// --- Product page ---

// A secondary rating's average as the stats report it, on a 1–ValueRange scale.
const SECONDARY_AVERAGE = z.object({ AverageRating: z.number(), ValueRange: z.optional(z.unknown()) });

// The score, review and recommend stats as cells of `row`; the secondary
// ratings as tables, returned for the caller to place.
const insights = (row: HTMLElement, stats: any, scoreData: { score: number; nps: number } | null, labels: Record<string, RatingLabel> | null) => {
  const total = Number(stats.TotalReviewCount) || 0;
  const recommended = Number(stats.RecommendedCount) || 0;
  const recommendTotal = recommended + (Number(stats.NotRecommendedCount) || 0);

  if (scoreData) appendStat(row, addCommas(scoreData.score), 'score', npsColor(scoreData.nps));

  if (total) appendStat(row, addCommas(total), 'reviews');

  if (recommendTotal > 0) {
    appendStat(row, `${Math.round((recommended / recommendTotal) * 100)}%`, 'recommend');
    // SAFETY: appendStat just appended its cell, a <div>, as the row's last child.
    (row.lastElementChild as HTMLElement).title = `${addCommas(recommended)} of ${addCommas(recommendTotal)} recommend it`;
  }

  // Secondary ratings (effect, tolerability…) as two small bar tables, a row
  // each: the site's label, a meter on the rating's 1–N scale, the figure. The
  // fill carries the state on a lighter track of its own hue: stone while a
  // dimension keeps up with the item's overall stars, amber from 0.3 stars
  // behind, red from a whole star. A label pairing synonyms ("Anwender-
  // freundlichkeit / Handhabung") shows its first; hovering a row shows all of
  // it, and a slider's scale. A slider runs from its bad end to its good end
  // like a rating, except Passform (fit), best in the middle: a dot, never lagging.
  const overall = Number(stats.AverageOverallRating) || 0;

  const rows = (stats.SecondaryRatingsAveragesOrder || []).flatMap((id: string) => {
    const read = SECONDARY_AVERAGE.safeParse(stats.SecondaryRatingsAverages?.[id]);
    const named = labels?.[id];
    const range = Number(read.data?.ValueRange);

    if (!named || !read.success || !(range > 1)) return [];
    const metric = read.data;
    const centered = /passform/i.test(named.label);
    const lag = overall && !centered ? overall - metric.AverageRating : 0;
    const tone = lag >= 1 ? 'neg' : lag >= 0.3 ? 'mid' : null;
    const at = Math.min(100, Math.max(0, ((metric.AverageRating - 1) / (range - 1)) * 100));

    const label = el('span', undefined, named.label.split(' / ')[0]);
    label.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const track = el('div');
    track.style.cssText = `position:relative;height:4px;border-radius:2px;background:${tone ? toneColor(tone, 90) : '#E7E5E4'}`;
    const mark = el('div');
    mark.style.cssText = centered
      ? `position:absolute;top:-2px;left:calc(${at}% - 4px);width:8px;height:8px;border-radius:50%;background:#78716C;box-shadow:0 0 0 2px #FAFAF9`
      : `width:${at}%;height:100%;border-radius:0 2px 2px 0;background:${tone ? toneColor(tone, 44) : '#78716C'}`;
    track.append(mark);
    const value = el('span', undefined, metric.AverageRating.toFixed(1));
    value.style.cssText = 'font-weight:700;font-variant-numeric:tabular-nums;color:#1C1917';
    const hover = named.ends ? `${named.label}: 1 = ${named.ends[0]}, ${range} = ${named.ends[1]}` : named.label;

    for (const part of [label, track, value]) part.title = hover;

    return [[label, track, value]];
  });

  if (!rows.length) return null;
  const half = Math.ceil(rows.length / 2);
  const tables = el('div');
  tables.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 24px;font-size:12px;line-height:1.4;color:#57534E';

  for (const column of [rows.slice(0, half), rows.slice(half)]) {
    if (!column.length) continue;
    const table = el('div');
    table.style.cssText = 'flex:1 1 240px;display:grid;grid-template-columns:minmax(0,160px) minmax(56px,1fr) auto;align-items:center;gap:6px 8px';
    table.append(...column.flat());
    tables.append(table);
  }

  return tables;
};

interface PdpData {
  stats: any;
  labels: Record<string, RatingLabel> | null;
  scoreData: { score: number; nps: number } | null;
  productId: string;
  reviews: ReturnType<typeof fetchReviews>;
}

// One unified "Review Intelligence" card: the review panel — its recent-positive
// gauge leading — with the score/review/recommend stats in its row and the
// secondary ratings under them.
const buildCard = (
  site: BvSite,
  exampleQuery: string,
  { stats, labels, scoreData, productId, reviews }: PdpData,
): HTMLElement | null => {
  const total = Number(stats?.TotalReviewCount) || 0;
  const hasRecommend = (Number(stats?.RecommendedCount) || 0) + (Number(stats?.NotRecommendedCount) || 0) > 0;

  if (!scoreData && !hasRecommend && total < 5) return null;

  const wrapper = createIslandShell();

  const { stats: row } = buildReviewPanel(wrapper, {
    // One summary per family, so another pack size of the product keeps it.
    key: `${site.key}-summary-${stats.FamilyIds?.[0] ?? productId}`,
    total,
    ...reviews,
    allMax: SAMPLE_MAX,
    score: scoreData?.score,
    text: reviewToText,
    card: reviewFields,
    searchTerm: (term) => searchTerm(site, productId, term),
    date: (r) => r.date,
    exampleQuery,
  });

  const tables = insights(row!, stats, scoreData, labels);

  if (tables) row!.after(tables);

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
