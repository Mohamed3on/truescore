import { netScore } from '@truescore/gmaps-shared';
import { idbGet, idbSet } from '../shared/idb-cache';
import { couldReach, rankPicks, type RankedPick } from '../shared/better-picks';
import { adjust, recentRatio } from '../shared/recency';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { addCommas, el } from '../shared/utils';
import { buildMediaSummary } from '../shared/review-summary';
import { buildSearchSection, runSearch, searchWith } from '../shared/review-search';
import { shrunkAverage } from './goodreads-picks';
import { goodreadsViewerCacheScope, shelfScoreCacheTtl } from './goodreads-shelf-cache';

const DAY_MS = 24 * 60 * 60 * 1000;

const CONFIG = {
  BOOK_CACHE_MS: 14 * DAY_MS,
  /** A book page that can't be scored (gone, or served without stats) is left alone this long. */
  DEAD_BOOK_CACHE_MS: 3 * DAY_MS,
  /** The recent % moves with every new rating, so it is refreshed daily. */
  RECENT_CACHE_MS: 1 * DAY_MS,
  SHELVES_CACHE_MS: 7 * DAY_MS,
  SHELF_PAGE_CACHE_MS: 7 * DAY_MS,
  PICKS_CACHE_MS: 7 * DAY_MS,
  SUMMARY_CACHE_MS: 14 * DAY_MS,
  MAX_CONCURRENCY: 15,
  PAGE_BATCH: 2,
  MAX_PAGES: 25,
  /** How many candidate shelves are scored at once while picking one. */
  SHELF_PROBE_BATCH: 3,
  AVG_RATING_TOLERANCE: 0.3,
  /** How many shelf-typical ratings the book's own average is weighed against (see shrunkAverage). */
  AVG_PRIOR_WEIGHT: 100,
  IGNORED_SHELF_THRESHOLD: -2,
  DEBUG: false,
};

const debug = (...args: any[]) => CONFIG.DEBUG && console.log('[GR]', ...args);

const STYLES = `
  .gr-similar {
    margin: 24px 0;
    padding: 20px;
    background: #f4f1ea;
    border: 1px solid #e4ddd0;
    border-radius: 8px;
    font-family: 'Lato', 'Merriweather Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    max-width: 720px;
    box-sizing: border-box;
  }
  .gr-similar-header {
    font-family: 'Merriweather', Georgia, serif;
    font-size: 20px;
    font-weight: 700;
    color: #382110;
    margin: 0 0 4px 0;
    letter-spacing: -.01em;
  }
  .gr-similar-shelf { color: #00635d; font-style: italic; }
  .gr-similar-sub {
    font-size: 13px;
    color: #8b7355;
    margin: 0 0 16px 0;
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  .gr-similar-sub a { color: #00635d; text-decoration: none; }
  .gr-similar-sub a:hover { text-decoration: underline; }
  .gr-similar-ref strong { color: #382110; font-weight: 700; }

  .gr-similar-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
  .gr-similar-item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 12px;
    background: #fff;
    border: 1px solid #e4ddd0;
    border-radius: 6px;
    transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease;
  }
  .gr-similar-item:hover {
    border-color: #00635d;
    box-shadow: 0 2px 8px rgba(0, 99, 93, .1);
    transform: translateX(2px);
  }
  .gr-similar-cover {
    width: 44px;
    height: 68px;
    object-fit: cover;
    border-radius: 2px;
    flex-shrink: 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .2);
    background: #e4ddd0;
  }
  .gr-similar-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .gr-similar-title {
    display: block;
    font-family: 'Merriweather', Georgia, serif;
    font-size: 14px;
    font-weight: 700;
    color: #382110 !important;
    text-decoration: none;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gr-similar-title:hover { color: #00635d !important; text-decoration: none; }
  .gr-similar-author { font-size: 12px; color: #8b7355; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The viewer's own shelf for a pick, read off the shelf row: Goodreads' words, its green. */
  .gr-similar-shelf-tag {
    align-self: flex-start;
    margin-top: 2px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: .04em;
    text-transform: uppercase;
    line-height: 1.4;
    color: #00635d;
    border: 1px solid #a9cfca;
    border-radius: 999px;
    padding: 1px 7px;
    white-space: nowrap;
  }

  .gr-similar-scores {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  /* The adjusted score leads — the one number the verdict rests on: teal when it reaches
     the bar, red when it falls short. Under it the recent % is set against the
     reference's own, teal when it holds up and amber when it trails. */
  .gr-similar-adjusted { font-size: 15px; font-weight: 700; color: #8b7355; line-height: 1; }
  .gr-similar-adjusted.-pass { color: #00635d; }
  .gr-similar-adjusted.-fail { color: #c24a32; }
  .gr-similar-recent { font-size: 11px; color: #8b7355; font-weight: 500; }
  .gr-similar-recent.-ahead { color: #00635d; }
  .gr-similar-recent.-trails { color: #9a6700; }
  .gr-similar-scores [title] { cursor: help; }

  /* A beaten pick fades except its figures, which stay legible enough to see why it lost. */
  .gr-similar-item.-excluded .gr-similar-cover, .gr-similar-item.-excluded .gr-similar-body { opacity: .55; }
  .gr-similar-item.-excluded .gr-similar-title { color: #8b7355 !important; text-decoration: line-through; }

  .gr-winner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    background: linear-gradient(135deg, #00635d 0%, #00524d 100%);
    color: #fff;
    border-radius: 8px;
    font-family: 'Merriweather', Georgia, serif;
    font-size: 15px;
    font-weight: 700;
    box-shadow: 0 2px 12px rgba(0, 99, 93, .2);
    margin-bottom: 12px;
  }
  .gr-winner-star { font-size: 22px; line-height: 1; }
  .gr-winner-text { flex: 1; }
  .gr-winner-source {
    font-family: 'Lato', sans-serif;
    font-size: 12px;
    font-weight: 400;
    opacity: .85;
    text-decoration: none;
    color: inherit !important;
    white-space: nowrap;
  }
  .gr-winner-source:hover { opacity: 1; text-decoration: underline; }

  .gr-progress {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 18px;
    background: #fff;
    border: 1px solid #e4ddd0;
    border-radius: 6px;
    color: #8b7355;
    font-size: 13px;
  }
  .gr-progress-dots { display: flex; gap: 6px; }
  .gr-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #e4ddd0;
    transition: background .2s ease;
  }
  .gr-dot.-active { background: #00635d; animation: gr-pulse 1s ease-in-out infinite; }
  .gr-dot.-done { background: #00635d; }
  @keyframes gr-pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.35); opacity: .7; }
  }

  .gr-debug-toggle {
    font-size: 12px;
    color: #8b7355;
    cursor: pointer;
    margin-top: 14px;
    user-select: none;
    display: inline-block;
  }
  .gr-debug-toggle:hover { color: #382110; }
  .gr-debug-content {
    font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    color: #8b7355;
    background: #fff;
    padding: 12px;
    border: 1px solid #e4ddd0;
    border-radius: 4px;
    margin-top: 6px;
    line-height: 1.6;
    white-space: pre-wrap;
    max-height: 300px;
    overflow-y: auto;
  }

  .gr-summary {
    margin: 24px 0;
    padding: 20px;
    background: #f4f1ea;
    border: 1px solid #e4ddd0;
    border-radius: 8px;
    max-width: 720px;
    box-sizing: border-box;
  }
  .gr-summary-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .gr-summary-header {
    font-family: 'Merriweather', Georgia, serif;
    font-size: 20px;
    font-weight: 700;
    color: #382110;
    margin: 0;
    letter-spacing: -.01em;
  }
  .gr-summary-relink { font-size: 12px; color: #00635d; cursor: pointer; user-select: none; }
  .gr-summary-relink:hover { text-decoration: underline; }
  .gr-summary-btn {
    flex-shrink: 0;
    white-space: nowrap;
    font-size: 14px;
    font-weight: 700;
    color: #fff;
    background: #00635d;
    border: none;
    border-radius: 6px;
    padding: 9px 16px;
    cursor: pointer;
    transition: background .15s ease;
  }
  .gr-summary-btn:hover { background: #00524d; }
  .gr-summary-btn:disabled { opacity: .6; cursor: default; }
  .gr-summary-sec { margin-bottom: 12px; }
  .gr-summary-sec:last-child { margin-bottom: 0; }
  .gr-summary-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: #8b7355;
    margin-bottom: 3px;
  }
  .gr-summary-text { font-size: 14px; line-height: 1.55; color: #382110; }
  .gr-summary-text strong { font-weight: 700; }
  .gr-summary-progress { color: #8b7355; font-size: 13px; padding: 4px 0; }
  .gr-summary-error { color: #c24a32; font-size: 13px; }
  .gr-summary-ask { display: flex; gap: 8px; margin-bottom: 12px; }
  .gr-summary-input {
    flex: 1;
    min-width: 0;
    padding: 8px 12px;
    font-size: 14px;
    color: #382110;
    background: #fff;
    border: 1px solid #d6cdbf;
    border-radius: 6px;
    outline: none;
  }
  .gr-summary-input:focus { border-color: #00635d; }
  .gr-summary-input::placeholder { color: #8b7355; }
  .gr-summary-qa { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
  .gr-summary-qa-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8b7355; }
  .gr-summary-qa-chip {
    font-size: 12px;
    color: #00635d;
    background: #fff;
    border: 1px solid #d6cdbf;
    border-radius: 999px;
    padding: 4px 12px;
    cursor: pointer;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: border-color .15s ease;
  }
  .gr-summary-qa-chip:hover { border-color: #00635d; }

  /* Review search — the shared .ars-search-* section, in Goodreads' palette. */
  .ars-search-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px dashed #d6cdbf;
  }
  .ars-search-input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 12px;
    font-family: inherit;
    font-size: 14px;
    color: #382110;
    background: #fff;
    border: 1px solid #d6cdbf;
    border-radius: 6px;
    outline: none;
    transition: border-color .15s ease;
  }
  .ars-search-input::placeholder { color: #8b7355; }
  .ars-search-input:focus { border-color: #00635d; }
  .ars-search-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .ars-search-score {
    font-size: 16px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .ars-search-summary { flex: 1; min-width: 140px; font-size: 12px; color: #8b7355; }
  .ars-search-count { font-weight: 700; color: #00635d; font-variant-numeric: tabular-nums; margin-right: 2px; }
  .ars-summarize-btn {
    flex-shrink: 0;
    white-space: nowrap;
    font-family: inherit;
    font-size: 12px;
    font-weight: 700;
    color: #00635d;
    background: #fff;
    border: 1px solid #d6cdbf;
    border-radius: 6px;
    padding: 6px 12px;
    cursor: pointer;
    transition: border-color .15s ease;
  }
  .ars-summarize-btn:hover { border-color: #00635d; }
  .ars-summarize-btn:disabled { opacity: .55; cursor: default; }
  .ars-summary-panel { font-size: 14px; line-height: 1.55; color: #382110; }
  .ars-summary-panel p { margin: 0 0 8px 0; }
  .ars-summary-panel p:last-child { margin-bottom: 0; }
  .ars-search-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 380px;
    overflow-y: auto;
    padding-right: 4px;
  }
  .ars-search-review {
    padding: 10px 12px;
    background: #fff;
    border: 1px solid #e4ddd0;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.55;
    color: #382110;
  }
  .ars-search-review-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .ars-search-stars { color: #e8b86d; font-size: 12px; letter-spacing: .05em; }
  .ars-search-meta { font-size: 11px; color: #8b7355; font-variant-numeric: tabular-nums; }
  .ars-search-body { white-space: pre-wrap; word-break: break-word; }
  .ars-search-hl { background: #fbeec2; color: #382110; padding: 0 2px; border-radius: 2px; }
  .ars-search-empty,
  .ars-search-truncated { font-size: 12px; color: #8b7355; font-style: italic; padding: 2px 0; }

  /* An Ask's Searches over every review (see shared/review-ask.ts), in Goodreads' palette. */
  .ars-ask-searches { display: flex; flex-direction: column; gap: 6px; }
  .ars-ask-searches:not(:empty) { margin-bottom: 12px; }
  .ars-ask-search {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    text-align: left;
    font-family: inherit;
    color: #382110;
    background: #fff;
    border: 1px solid #e4ddd0;
    border-radius: 6px;
    cursor: pointer;
    transition: border-color .15s ease;
  }
  .ars-ask-search:hover:not(:disabled) { border-color: #00635d; }
  .ars-ask-search:disabled { cursor: default; }
  .ars-ask-search-label,
  .ars-ask-reading:empty::before { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8b7355; white-space: nowrap; }
  .ars-ask-search-terms { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ars-ask-search-pct { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ars-ask-search-count { font-size: 12px; color: #8b7355; font-variant-numeric: tabular-nums; }
  .ars-ask-reading:empty::before { content: 'Reading reviews…'; }
  .ars-ask-search.live .ars-ask-search-label,
  .ars-ask-search.live .ars-ask-search-count,
  .ars-ask-reading:empty::before { animation: gr-ask-pulse 1.5s ease-in-out infinite; }
  @keyframes gr-ask-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .4; }
  }
`;

function injectStyles() {
  if (document.getElementById('gr-extension-styles')) return;
  const style = document.createElement('style');
  style.id = 'gr-extension-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

const throttledFetch = createThrottledFetcher(
  CONFIG.MAX_CONCURRENCY,
  (url, options) => fetch(url, { credentials: 'include', ...options }),
);

const fetchDoc = async (url: string): Promise<Document> => {
  const res = await throttledFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return new DOMParser().parseFromString(await res.text(), 'text/html');
};

// =============================================================================
// Book page parsing
// =============================================================================

type BookStats = {
  avgRating: string;
  ratingsCount: number;
  score: number;
  ratio: number;
  workId: string;
  jwtToken: string | null;
};

const parseBookNextData = (nextData: any): BookStats | null => {
  const apolloState = nextData?.props?.pageProps?.apolloState;
  if (!apolloState) return null;
  const workKey = Object.keys(apolloState).find(k => k.startsWith('Work:'));
  if (!workKey) return null;
  const stats = apolloState[workKey].stats;
  if (!stats) return null;
  const fiveStar = stats.ratingsCountDist?.[4] || 0;
  const oneStar = stats.ratingsCountDist?.[0] || 0;
  const total = stats.ratingsCount || 0;
  if (!total) return null;
  const scoreAbsolute = fiveStar - oneStar;
  const ratio = scoreAbsolute / total;
  return {
    avgRating: String(stats.averageRating),
    ratingsCount: total,
    score: netScore(scoreAbsolute, total),
    ratio,
    workId: workKey.replace('Work:', ''),
    jwtToken: nextData?.props?.pageProps?.jwtToken ?? null,
  };
};

const getCurrentBookStats = (): BookStats | null => {
  const script = document.querySelector('#__NEXT_DATA__');
  if (!script?.textContent) return null;
  try { return parseBookNextData(JSON.parse(script.textContent)); } catch { return null; }
};

const getBookIdFromURL = (url: string): string | null =>
  url.match(/\/show\/(\d+)/)?.[1] ?? null;

// v2: v1 scores lost their sign (see netScore), so hated books read positive.
const bookCacheKey = (id: string) => `gr_book_v2_${id}`;

/** The token is the viewer's session, not the book's — only the live page's is ever used. */
const cacheBookStats = (id: string, stats: BookStats) => idbSet(bookCacheKey(id), { ...stats, jwtToken: null });

const deadBookKey = (id: string) => `gr_book_dead_v1_${id}`;

/** A book page that can't be scored for good — gone, or served without stats — as opposed to a fetch that merely failed. */
class DeadBookError extends Error {}

const getBookStatsFromURL = async (bookURL: string): Promise<BookStats> => {
  const id = getBookIdFromURL(bookURL);
  if (id) {
    const cached = await idbGet(bookCacheKey(id), CONFIG.BOOK_CACHE_MS);
    if (cached) return cached;
    if (await idbGet(deadBookKey(id), CONFIG.DEAD_BOOK_CACHE_MS)) throw new DeadBookError(bookURL);
  }
  const dead = (why: string) => {
    if (id) idbSet(deadBookKey(id), true);
    return new DeadBookError(`${why} on ${bookURL}`);
  };
  const res = await throttledFetch(bookURL);
  if (res.status === 404 || res.status === 410) throw dead(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${bookURL}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const script = doc.querySelector('#__NEXT_DATA__');
  if (!script?.textContent) throw dead('no __NEXT_DATA__');
  const stats = parseBookNextData(JSON.parse(script.textContent));
  if (!stats) throw dead('no book stats');
  if (id) cacheBookStats(id, stats);
  return stats;
};

// =============================================================================
// Recent ratio (GraphQL)
// =============================================================================

const GRAPHQL_ENDPOINT = 'https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql';

type ReviewNode = { rating?: number | null; createdAt?: number | null; text?: string | null };

// The endpoint's ceiling — asking for more returns a null connection, not a bigger page.
const REVIEW_PAGE_LIMIT = 100;

// The page's JWT (pageProps.jwtToken) lives five minutes, so a search typed after that
// answered "Token has expired." Goodreads' own client re-mints one from GET /authenticate
// (the bare token as text) on a 401; this mints a little early, once per expiry, and
// retries a request the endpoint still rejects with a fresh one.
const TOKEN_MARGIN_MS = 30_000;
let sessionToken: string | null = null;
let minting: Promise<string | null> | null = null;

const tokenExpiry = (token: string): number => {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; }
  catch { return 0; }
};

const mintToken = (): Promise<string | null> =>
  (minting ??= fetch('https://www.goodreads.com/authenticate', { credentials: 'include' })
    .then((res) => (res.ok ? res.text() : null), () => null)
    .then((text) => (sessionToken = text?.trim() || null))
    .finally(() => { minting = null; }));

/** The page's token while it has time left, else a freshly minted one; null when signed out. */
const getSessionToken = (): Promise<string | null> =>
  sessionToken && tokenExpiry(sessionToken) - Date.now() > TOKEN_MARGIN_MS ? Promise.resolve(sessionToken) : mintToken();

/**
 * One getReviews call (newest first). `withText` also pulls the review prose for the AI
 * summary; `searchText` runs Goodreads' own full-text search across the *whole* review
 * corpus (see phraseQuery for its OR-vs-phrase syntax), with `totalCount` the exact
 * number of hits even when they overflow the single page we ask for.
 */
const fetchReviewNodes = async (
  workId: string,
  { withText = false, searchText = '' }: { withText?: boolean; searchText?: string } = {},
): Promise<{ nodes: ReviewNode[]; totalCount: number }> => {
  const body = JSON.stringify({
    operationName: 'getReviews',
    variables: {
      filters: { resourceType: 'WORK', resourceId: workId, sort: 'NEWEST', ...(searchText && { searchText }) },
      pagination: { limit: REVIEW_PAGE_LIMIT },
    },
    query: `query getReviews($filters: BookReviewsFilterInput!, $pagination: PaginationInput) {
        getReviews(filters: $filters, pagination: $pagination) {
          totalCount
          edges { node { rating createdAt${withText ? ' text' : ''} } }
        }
      }`,
  });
  const request = async (token: string) => {
    const res = await throttledFetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', authorization: token },
      body,
    });
    return { ok: res.ok, data: await res.json() };
  };
  const token = await getSessionToken();
  if (!token) throw new Error(`no session token for ${workId}`);
  let { ok, data } = await request(token);
  if (data?.errors?.some((e: any) => e?.errorType === 'UnauthorizedException')) {
    const fresh = await mintToken();
    if (fresh) ({ ok, data } = await request(fresh));
  }
  const getReviews = data?.data?.getReviews;
  // Throw on a throttled/error response so callers can tell a real fetch failure from a
  // genuinely empty result — an error body (429, GraphQL errors) would otherwise read as [].
  if (!ok || data?.errors || !getReviews) throw new Error(`getReviews failed on ${workId}`);
  return {
    nodes: (getReviews.edges?.map((e: any) => e.node).filter(Boolean) as ReviewNode[]) || [],
    totalCount: getReviews.totalCount ?? 0,
  };
};

// The window is the Goodreads-specific part: the newest REVIEW_PAGE_LIMIT reviews, whatever
// their dates. For a popular book that is a few weeks; for a niche one, much of its history —
// and the old one-year cutoff only ever turned the niche book's small sample into no verdict.
// The polarity and the null contract come from shared/recency so every site answers
// "how recent-positive?" the same way.
const recentRatioFromNodes = (nodes: ReviewNode[]): number | null =>
  recentRatio(nodes.filter((n) => n.rating).map((n) => n.rating as number));

type RecentStats = { ratio: number | null; total: number };

/**
 * Recent-positive ratio plus the size of the book's review corpus, cached a day per work
 * so the reference and every pick it shares with other books pay for it once. Throws on
 * a failed fetch: a null ratio means "no recent ratings", never "couldn't look".
 */
const fetchRecentStats = async (workId: string): Promise<RecentStats> => {
  const cacheKey = `gr_recent_v1_${workId}`;
  const cached = (await idbGet(cacheKey, CONFIG.RECENT_CACHE_MS)) as RecentStats | null;
  if (cached) return cached;
  const { nodes, totalCount } = await fetchReviewNodes(workId);
  const stats: RecentStats = { ratio: recentRatioFromNodes(nodes), total: totalCount };
  idbSet(cacheKey, stats);
  return stats;
};

/** The reference's own recent stats; unknown (null, 0) when signed out or on a failed fetch. */
const getRecentStats = async (workId: string, signedIn: boolean): Promise<RecentStats> => {
  if (!signedIn) return { ratio: null, total: 0 };
  try { return await fetchRecentStats(workId); } catch { return { ratio: null, total: 0 }; }
};

// =============================================================================
// Shelf selection
// =============================================================================

/**
 * The shelves the book page already carries: Goodreads' genres are its most-shelved
 * content shelves, in the shelves page's order without the status ones — no fetch.
 */
const getEmbeddedShelves = (): string[] => {
  const script = document.querySelector('#__NEXT_DATA__');
  if (!script?.textContent) return [];
  try {
    const apollo = JSON.parse(script.textContent)?.props?.pageProps?.apolloState || {};
    const id = getBookIdFromURL(window.location.href);
    const books = (Object.values(apollo) as any[]).filter((e) => Array.isArray(e?.bookGenres) && e.bookGenres.length);
    const book = books.find((e) => String(e.legacyId) === id) ?? books[0];
    return (book?.bookGenres ?? [])
      .map((g: any) => String(g?.genre?.webUrl || '').split('/').pop() || '')
      .filter(Boolean);
  } catch { return []; }
};

/** The shelves page, for a book whose own page carries no genres — kept a week. */
const getBookShelves = async (bookURL: string): Promise<string[]> => {
  const id = getBookIdFromURL(bookURL);
  const cacheKey = id && `gr_shelves_v1_${id}`;
  const cached = cacheKey && (await idbGet(cacheKey, CONFIG.SHELVES_CACHE_MS));
  if (cached) return cached;
  const shelvesURL = bookURL.replace('/show/', '/shelves/').replace(/(?<=goodreads\.com)\/[a-z]{2}(?=\/book)/, '');
  const doc = await fetchDoc(shelvesURL);
  const shelves = Array.from(doc.querySelectorAll('a.mediumText'))
    .map(el => el.textContent?.trim() || '')
    .filter(Boolean);
  if (cacheKey && shelves.length) idbSet(cacheKey, shelves);
  return shelves;
};

type ShelfStatus = 'read' | 'to-read' | 'reading' | 'dnf' | 'other' | null;

type Candidate = {
  bookId: string;
  bookURL: string;
  title: string;
  author: string;
  cover: string;
  /** The viewer's own shelf for it, read off the row's Want-to-Read widget. */
  status: ShelfStatus;
  /** The viewer's own stars for it, 0 when unrated. */
  myRating: number;
  bookRating: string | null;
};

/** Read, or given up on: nothing to recommend. Stars alone count too — rating a book shelves it as read. */
const isRead = (c: Candidate) => c.status === 'read' || c.status === 'dnf' || c.myRating > 0;

/** The shelf's own average, over the rows that show one. */
const meanRating = (rows: Candidate[]): number | null => {
  const ratings = rows.map((r) => parseFloat(r.bookRating || '')).filter(Number.isFinite);
  return ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
};

const SHELF_STATUS: Array<[string, ShelfStatus]> = [
  ['wtrStatusRead', 'read'], ['wtrStatusToRead', 'to-read'], ['wtrStatusReadingNow', 'reading'],
  ['wtrStatusDidNotFinish', 'dnf'], ['wtrStatusOtherShelf', 'other'],
];

const parseShelfPage = (doc: Document): Candidate[] =>
  Array.from(doc.querySelectorAll<HTMLElement>('.leftContainer > .elementList')).map(row => {
    const titleEl = row.querySelector('.bookTitle') as HTMLAnchorElement | null;
    const href = titleEl?.getAttribute('href');
    if (!href) return null;
    const bookURL = new URL(href, 'https://www.goodreads.com').href;
    const bookId = getBookIdFromURL(bookURL);
    if (!bookId) return null;
    const title = titleEl!.textContent?.trim().replace(/\s+/g, ' ') || '';
    const author = row.querySelector('.authorName')?.textContent?.trim() || '';
    const cover = row.querySelector<HTMLImageElement>('img[src]')?.getAttribute('src') || '';
    const ratingText = Array.from(row.querySelectorAll('.greyText.smallText'))
      .map(e => e.textContent || '')
      .join(' ');
    const widget = row.querySelector('.wtrLeft');
    return {
      bookId,
      bookURL,
      title,
      author,
      cover,
      status: SHELF_STATUS.find(([cls]) => widget?.classList.contains(cls))?.[1] ?? null,
      myRating: Number(row.querySelector('.stars')?.getAttribute('data-rating')) || 0,
      bookRating: ratingText.match(/\d(\.\d+)?(?=\s+—)/)?.[0] || null,
    };
  }).filter((x): x is Candidate => x !== null);

const shelfPageURL = (shelf: string, page: number) => `https://www.goodreads.com/shelf/show/${shelf}?page=${page}`;

// One fetch per shelf page per visit, however many steps want it: scoring a shelf reads
// its first page and scanning it starts there. The pages are the viewer's (their stars
// and shelves are on the rows), so they cache under the viewer, for a week.
const shelfPages = new Map<string, Promise<Candidate[]>>();

const getShelfPage = (shelf: string, page: number, viewerScope: string): Promise<Candidate[]> => {
  const cacheKey = `gr_shelf_page_v1_${viewerScope}_${shelf}_${page}`;
  let pending = shelfPages.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const cached = (await idbGet(cacheKey, CONFIG.SHELF_PAGE_CACHE_MS)) as Candidate[] | null;
      if (cached) return cached;
      const rows = parseShelfPage(await fetchDoc(shelfPageURL(shelf, page)));
      idbSet(cacheKey, rows);
      return rows;
    })();
    shelfPages.set(cacheKey, pending);
    // A failed fetch shouldn't pin its failure for the rest of the visit.
    pending.catch(() => shelfPages.delete(cacheKey));
  }
  return pending;
};

/** How the viewer holds a shelf: their 4–5★ books on its first page, less their 1–2★ ones. */
const getShelfScore = async (shelf: string, viewerScope: string): Promise<number> => {
  const cacheKey = `gr_shelf_score_v2_${viewerScope}_${shelf}`;
  const cached = await idbGet(
    cacheKey,
    (score) => shelfScoreCacheTtl(score, CONFIG.IGNORED_SHELF_THRESHOLD),
  );
  if (cached !== null) return cached;
  const rows = await getShelfPage(shelf, 1, viewerScope);
  const score = rows.filter(r => r.myRating >= 4).length - rows.filter(r => r.myRating >= 1 && r.myRating <= 2).length;
  idbSet(cacheKey, score);
  return score;
};

/**
 * Shelves that say how a reader holds a book, not what it is: reading status, ownership,
 * format, favourites, the year it was read. They open every book's list (to-read,
 * currently-reading), so picks came from "to-read". Matched per hyphenated word —
 * "physical-tbr" and "books-i-own" go, "banned-books" stays.
 */
const NON_CONTENT_SHELF = /(^|-)(tbr|read|reread|currently-reading|dnf|did-not-finish|default|wish-?list|to-buy|own(ed)?|library|(book)?shelf|fav(ou?rite|e)?s?|kindle|e-?books?|audio(-?books?)?|audible|arcs?|netgalley|(19|20)\d\d)(-|$)/;

/**
 * The first content shelf the viewer doesn't hold against the book. A few are scored at
 * once, but each is answered in order: the first nearly always passes, so it returns the
 * moment its own score lands while the runners-up finish warming their caches behind it.
 */
const pickShelf = async (shelves: string[], viewerScope: string): Promise<string | null> => {
  const content = shelves.filter(s => !NON_CONTENT_SHELF.test(s));
  for (let i = 0; i < content.length; i += CONFIG.SHELF_PROBE_BATCH) {
    const batch = content.slice(i, i + CONFIG.SHELF_PROBE_BATCH);
    const probes = batch.map((shelf) => getShelfScore(shelf, viewerScope).catch((e: any) => {
      debug(`shelf ${shelf} failed:`, e.message);
      return null;
    }));
    for (let j = 0; j < batch.length; j++) {
      const score = await probes[j];
      if (score !== null && score >= CONFIG.IGNORED_SHELF_THRESHOLD) return batch[j];
    }
  }
  return null;
};

// =============================================================================
// Best-book search
// =============================================================================

type ScoredCandidate = Candidate & BookStats;
/** `permanent`: the page can't be scored at all (see DeadBookError) — a known gap, not a retry. */
type FailedCandidate = Candidate & { failed: true; permanent: boolean };

type SimilarResult = {
  /** The average a shelf row needed to be fetched at all. */
  avgGate: number;
  qualifying: ScoredCandidate[];
  allScored: Array<ScoredCandidate | FailedCandidate>;
  totalEligible: number;
  pagesSearched: number;
  foundOnPage: number;
};

/**
 * A candidate whose book page failed is a gap, not a loser: a result with gaps is
 * still shown, but never cached, so the next visit retries instead of trusting it.
 * A page that can't be scored for good is as complete as the scan will ever get.
 */
const isComplete = (result: SimilarResult) => !result.allScored.some(b => 'failed' in b && !b.permanent);

/**
 * What a shelf candidate must be able to reach to be worth its recency fetch: the
 * reference's recent-adjusted score, the verdict rankPicks will apply. When the
 * reference's own recency is unknown there is no verdict to bound, so fall back
 * to its all-time Score to keep the list to books that at least match it.
 */
const pickBar = (threshold: number | null, refScore: number) => threshold ?? refScore;

const findSimilarPicks = async (params: {
  originalBookURL: string;
  /** Shared by every edition — a shelf can list the book under another edition's id. */
  refWorkId: string;
  shelf: string;
  viewerScope: string;
  /** The reference's recent-adjusted score, or null when its recency is unknown — see pickBar. */
  threshold: number | null;
  refScore: number;
  refAvgRating: string;
  refRatingsCount: number;
}): Promise<SimilarResult> => {
  const { originalBookURL, refWorkId, shelf, viewerScope, threshold, refScore, refAvgRating, refRatingsCount } = params;
  const bar = pickBar(threshold, refScore);
  const originalId = getBookIdFromURL(originalBookURL);
  // v4: v3 could list the book's own other edition and keep scans cut short by failures.
  // v5: v4 offered books marked Read without stars, and its rows carried no shelf status.
  // v6: v5 gated rows on the book's raw average, so a new book's few fan ratings shut the shelf.
  // A scan bounded by the all-time Score is narrower than one bounded by the threshold,
  // so it keeps its own entry — one throttled reviews call can't stand in for a week.
  const cacheKey = `gr_picks_v6_${viewerScope}_${originalId}_${shelf}${threshold === null ? '_alltime' : ''}`;
  const cached = (await idbGet(cacheKey, CONFIG.PICKS_CACHE_MS)) as SimilarResult | null;
  if (cached) return cached;
  const refAvg = parseFloat(refAvgRating);
  /** Settled by the first shelf page, whose own average is the prior the book's is shrunk toward. */
  let avgGate = Infinity;

  const allScored: Array<ScoredCandidate | FailedCandidate> = [];
  let totalEligible = 0;
  let pagesSearched = 0;
  let foundOnPage = 0;

  for (let start = 1; start <= CONFIG.MAX_PAGES; start += CONFIG.PAGE_BATCH) {
    const end = Math.min(start + CONFIG.PAGE_BATCH - 1, CONFIG.MAX_PAGES);
    debug(`Scanning shelf "${shelf}" pages ${start}-${end}`);

    // A page that fails to load fails the search: it isn't the end of the shelf (that's
    // a 200 with no rows), and a scan that skipped it can't claim nothing beats the book.
    const pageResults = await Promise.all(
      Array.from({ length: end - start + 1 }, (_, i) => {
        const pageNum = start + i;
        return getShelfPage(shelf, pageNum, viewerScope).then(rows => ({ pageNum, rows }));
      })
    );

    pagesSearched = end;

    const rowsWithPage = pageResults.flatMap(({ pageNum, rows }) => rows.map(c => ({ ...c, pageNum })));
    if (!rowsWithPage.length) break;
    if (start === 1) {
      avgGate = shrunkAverage(refAvg, refRatingsCount, meanRating(rowsWithPage), CONFIG.AVG_PRIOR_WEIGHT) - CONFIG.AVG_RATING_TOLERANCE;
    }

    const eligible = rowsWithPage.filter((c) => {
      if (c.bookId === originalId) return false;
      if (isRead(c)) return false;
      return parseFloat(c.bookRating || '0') >= avgGate;
    });
    totalEligible += eligible.length;

    const scored = await Promise.all(eligible.map(async (c) => {
      try {
        const stats = await getBookStatsFromURL(c.bookURL);
        return { ...c, ...stats } as ScoredCandidate;
      } catch (e) {
        return { ...c, failed: true as const, permanent: e instanceof DeadBookError };
      }
    }));

    // Another edition of this very book has its own id but the same work, and so the
    // same stats: it's the reference — never its own pick, and where the book sits.
    const refIds = new Set([originalId, ...scored.filter(b => !('failed' in b) && b.workId === refWorkId).map(b => b.bookId)]);
    const refRow = rowsWithPage.find(r => refIds.has(r.bookId));
    if (refRow && !foundOnPage) foundOnPage = refRow.pageNum;
    const candidates = scored.filter(b => !refIds.has(b.bookId));
    allScored.push(...candidates);

    const qualifying = candidates
      .filter((b): b is ScoredCandidate => !('failed' in b))
      .filter(b => couldReach(bar, b.score))
      .sort((a, b) => b.score - a.score);

    if (qualifying.length) {
      const result: SimilarResult = { avgGate, qualifying, allScored, totalEligible, pagesSearched, foundOnPage };
      if (isComplete(result)) idbSet(cacheKey, result);
      return result;
    }

    // later pages sorted lower by popularity — unlikely to beat reference
    if (refRow) break;
  }

  const result: SimilarResult = { avgGate, qualifying: [], allScored, totalEligible, pagesSearched, foundOnPage };
  if (isComplete(result)) idbSet(cacheKey, result);
  return result;
};

// =============================================================================
// UI orchestration
// =============================================================================

const PROGRESS_STEPS = ['Picking shelf', 'Fetching books'];

const renderProgress = (container: HTMLElement, step: number, detail = '') => {
  container.textContent = '';
  const wrap = el('div', 'gr-progress');
  const dots = el('div', 'gr-progress-dots');
  PROGRESS_STEPS.forEach((_, i) => {
    const cls = i < step ? '-done' : i === step ? '-active' : '';
    dots.append(el('span', `gr-dot ${cls}`));
  });
  wrap.append(dots, el('span', undefined, detail || `${PROGRESS_STEPS[step]}…`));
  container.append(wrap);
};

const anchorLink = (href: string, className: string | undefined, text: string) => {
  const a = el('a', className, text) as HTMLAnchorElement;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
};

const shelfURL = (shelf: string) => `https://www.goodreads.com/shelf/show/${shelf}`;

const winnerBanner = (text: string, shelf: string | null) => {
  const wrap = el('div', 'gr-winner');
  wrap.append(el('span', 'gr-winner-star', '★'));
  wrap.append(el('span', 'gr-winner-text', text));
  if (shelf) wrap.append(anchorLink(shelfURL(shelf), 'gr-winner-source', `browse "${shelf}" →`));
  return wrap;
};

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

/**
 * Sets a pick's figure beside the reference's own: teal when it holds up, amber when it
 * trails. The tooltip carries both numbers, so the comparison never rests on color alone.
 */
const compare = (span: HTMLElement, label: string, value: number | null, ref: number | null, format: (n: number) => string) => {
  if (value === null || ref === null) return span;
  const trails = value < ref;
  span.classList.add(trails ? '-trails' : '-ahead');
  span.title = `${label} ${format(value)} vs this book's ${format(ref)}${trails ? ' \u2014 trails it' : ''}`;
  return span;
};

const buildItem = (ranked: RankedPick<ScoredCandidate>, refRecentRatio: number | null, threshold: number | null) => {
  const pick = ranked.item;
  const item = el('li', 'gr-similar-item');
  const img = document.createElement('img');
  img.className = 'gr-similar-cover';
  if (pick.cover) img.src = pick.cover;
  img.alt = '';
  img.loading = 'lazy';
  item.append(img);

  const body = el('div', 'gr-similar-body');
  body.append(anchorLink(pick.bookURL, 'gr-similar-title', pick.title || `Book ${pick.bookId}`));
  if (pick.author) body.append(el('span', 'gr-similar-author', pick.author));
  if (pick.status === 'to-read' || pick.status === 'reading') {
    body.append(el('span', 'gr-similar-shelf-tag', pick.status === 'reading' ? 'Currently reading' : 'Want to Read'));
  }
  item.append(body);

  const scores = el('div', 'gr-similar-scores');
  const rr = ranked.ratio;
  // The adjusted score leads — the Score re-aimed by the recent run (see shared/recency),
  // the one number the verdict rests on. The all-time Score is only the tooltip's working.
  const adjusted = el('span', 'gr-similar-adjusted', ranked.adjusted === null ? '—' : addCommas(ranked.adjusted));
  if (ranked.adjusted === null) {
    adjusted.title = 'No rated reviews to adjust by';
  } else {
    const working = `${addCommas(Math.round(Math.abs(pick.score)))} × ${pct(rr!)} = ${addCommas(ranked.adjusted)} adjusted`;
    if (threshold === null) {
      adjusted.title = working;
    } else {
      adjusted.classList.add(ranked.passes ? '-pass' : '-fail');
      adjusted.title = `${working} · ${ranked.passes ? 'reaches' : 'short of'} the ${addCommas(threshold)} to beat`;
    }
  }
  scores.append(adjusted);
  const recent = el('span', 'gr-similar-recent', rr === null ? 'recent N/A' : `recent ${pct(rr)}`);
  if (rr === null) recent.title = 'No rated reviews to judge it by';
  else compare(recent, 'Recent', rr, refRecentRatio, pct);
  scores.append(recent);
  item.append(scores);
  if (threshold !== null && !ranked.passes) item.classList.add('-excluded');
  return item;
};

const debugPane = (shelf: string, result: SimilarResult, threshold: number | null, refScore: number) => {
  const bar = pickBar(threshold, refScore);
  const toggle = el('div', 'gr-debug-toggle', '▶ Debug info');
  const content = el('div', 'gr-debug-content');
  content.style.display = 'none';
  const lines = [
    `Shelf: ${shelf}`,
    `Pages searched: ${result.pagesSearched}${result.foundOnPage ? ` (reference on page ${result.foundOnPage})` : ''}`,
    `Eligible candidates (avg ≥ ${result.avgGate.toFixed(2)}): ${result.totalEligible}`,
    `Scored: ${result.allScored.length}`,
    `Qualifying (score can reach ${addCommas(bar)}): ${result.qualifying.length}`,
  ];
  lines.push(threshold !== null ? `Adjusted threshold: ${addCommas(threshold)}` : 'Adjusted threshold: unknown (no recent reviews for this book)');
  if (result.allScored.length) {
    lines.push('', 'All scored:');
    for (const b of result.allScored) {
      if ('failed' in b) {
        lines.push(`  (${b.permanent ? 'unavailable' : 'failed'}) ${b.title || b.bookId}`);
      } else {
        const mark = couldReach(bar, b.score) ? '✓' : '✗';
        lines.push(`  ${mark} ${b.title} — ${addCommas(Math.round(b.score))} (${Math.round(b.ratio * 100)}%)`);
      }
    }
  }
  content.textContent = lines.join('\n');
  toggle.addEventListener('click', () => {
    const open = content.style.display !== 'none';
    content.style.display = open ? 'none' : 'block';
    toggle.textContent = (open ? '▶' : '▼') + ' Debug info';
  });
  const wrap = el('div');
  wrap.append(toggle, content);
  return wrap;
};

type PickRecent = Record<string, number | null>;
type SimilarView = { shelf: string; result: SimilarResult; recent: PickRecent; refRecentRatio: number | null };

/** Renders a fully-resolved picks view (no network) — shared by the fresh and cached paths. */
const renderPicksView = (section: HTMLElement, view: SimilarView, currentStats: BookStats) => {
  const { shelf, result, recent, refRecentRatio } = view;
  // One verdict, shared with Letterboxd (shared/better-picks.ts): score folded
  // with the recent run into one comparable number. This used to be two
  // independent gates, which passed books Letterboxd's rule rejected and
  // rejected books it passed.
  const ranking = rankPicks(
    { score: currentStats.score, ratio: refRecentRatio },
    result.qualifying.map((pick) => ({ key: pick.bookId, item: pick, score: pick.score, ratio: recent[pick.bookId] ?? null })),
  );
  const threshold = ranking.threshold;
  section.textContent = '';

  const header = el('h3', 'gr-similar-header');
  header.append(document.createTextNode('Better picks in '));
  header.append(el('span', 'gr-similar-shelf', `"${shelf}"`));
  section.append(header);

  const sub = el('p', 'gr-similar-sub');
  sub.append(anchorLink(shelfURL(shelf), undefined, 'browse shelf →'));
  const refInfo = el('span', 'gr-similar-ref');
  const strong = (text: string) => el('strong', undefined, text);
  // The bar every pick is judged by: the reference's Score re-aimed by its own recent run.
  if (threshold !== null) {
    refInfo.append('to beat ', strong(addCommas(threshold)), ' adjusted', ` · this book's ${addCommas(Math.round(Math.abs(currentStats.score)))} × recent `, strong(pct(refRecentRatio!)));
  } else {
    refInfo.append('this book ', strong(addCommas(Math.round(currentStats.score))), ' · recent unknown');
  }
  sub.append(refInfo);
  section.append(sub);

  if (!result.qualifying.length) {
    section.append(winnerBanner('Winner! Nothing in this shelf beats it.', shelf));
    section.append(debugPane(shelf, result, threshold, currentStats.score));
    return;
  }

  const list = el('ul', 'gr-similar-list');
  // Best adjusted first, the way Letterboxd already ordered its list — the raw
  // score order buried the book that actually wins.
  for (const ranked of ranking.ranked) list.append(buildItem(ranked, refRecentRatio, threshold));

  // No recent % for this book means no verdict: the picks stay unjudged, not struck
  // through as if they had lost.
  if (threshold === null) section.append(el('p', 'gr-similar-sub', "Can't judge: this book's recent % is unknown."));
  else if (!ranking.passed.length) section.append(winnerBanner('Winner! No book beats its recent-adjusted score.', shelf));
  section.append(list);
  section.append(debugPane(shelf, result, threshold, currentStats.score));
};

const renderSimilarPicks = async (
  anchor: Element,
  currentBookURL: string,
  currentStats: BookStats,
  /** Still in flight while the shelf is picked; only the scan's threshold waits for it. */
  recentRatioPromise: Promise<number | null>,
) => {
  const section = el('section', 'gr-similar');
  anchor.parentNode!.insertBefore(section, anchor.nextSibling);

  // Cached full view → restore instantly; no shelf lookup or book fetches on refresh.
  // v2: bumped to flush entries poisoned by cached "Recent: N/A" from failed fetches.
  // v3: v2 views held unsigned scores and the old two-gate qualifying list.
  // v5: v4 views could come from "to-read", list the book's own other edition, rest on
  //     failed fetches, or bake in an unknown reference recency that struck every pick.
  // v6: v5 rows carried no shelf status and counted unrated Read books as unread.
  // v7: v6 views gated the shelf on the book's raw average — one pick for a book rated seven times.
  const viewerScope = goodreadsViewerCacheScope(document);
  const viewKey = `gr_picks_view7_${viewerScope}_${getBookIdFromURL(currentBookURL)}`;
  const cachedView = (await idbGet(viewKey, CONFIG.PICKS_CACHE_MS)) as SimilarView | null;
  if (cachedView) { renderPicksView(section, cachedView, currentStats); return; }

  renderProgress(section, 0);

  let shelf: string;
  let result: SimilarResult;
  let currentRecentRatio: number | null;

  try {
    const shelves = getEmbeddedShelves();
    if (!shelves.length) shelves.push(...await getBookShelves(currentBookURL));
    if (!shelves.length) {
      section.textContent = '';
      section.append(winnerBanner('No shelves found for this book.', null));
      return;
    }
    const picked = await pickShelf(shelves, viewerScope);
    if (!picked) {
      section.textContent = '';
      section.append(winnerBanner('No usable shelf found for this book.', null));
      return;
    }
    shelf = picked;

    renderProgress(section, 1, `Fetching books in "${shelf}"…`);

    currentRecentRatio = await recentRatioPromise;
    result = await findSimilarPicks({
      originalBookURL: currentBookURL,
      refWorkId: currentStats.workId,
      shelf,
      viewerScope,
      threshold: adjust(currentStats.score, currentRecentRatio),
      refScore: currentStats.score,
      refAvgRating: currentStats.avgRating,
      refRatingsCount: currentStats.ratingsCount,
    });
  } catch (e: any) {
    debug('similar picks error:', e);
    section.textContent = '';
    section.append(winnerBanner('Similar picks search failed.', null));
    return;
  }

  // Resolve each pick's recent ratio. A thrown fetch (rate limit / transient error) or a
  // missing token yields a null we must NOT bake into the cache as a permanent "Recent: N/A" —
  // only persist the view when every ratio resolved cleanly, so it self-heals on the next load.
  const signedIn = !!currentStats.jwtToken;
  const recent: PickRecent = {};
  let recentFailed = !signedIn;
  await Promise.all(result.qualifying.map(async (pick) => {
    if (!signedIn) return;
    try { recent[pick.bookId] = (await fetchRecentStats(pick.workId)).ratio; }
    catch { recentFailed = true; }
  }));

  const view: SimilarView = { shelf, result, recent, refRecentRatio: currentRecentRatio };
  // Persist a slim copy — allScored is a large per-candidate debug list we don't need to keep.
  // Only a view that holds all week: no failed book, and the reference's own recency known —
  // the view keeps it, so an unknown one would stay unjudged long after it resolves.
  if (!recentFailed && isComplete(result) && currentRecentRatio !== null) {
    idbSet(viewKey, { ...view, result: { ...result, allScored: [] } });
  }
  renderPicksView(section, view, currentStats);
};

// =============================================================================
// Review summary (AI)
// =============================================================================

const SUMMARY_SCHEMA = {
  type: 'object' as const,
  properties: {
    summary: { type: 'string' as const, description: '1–2 sentences on the overall sentiment and what reviewers make of the book.' },
    recommendation: { type: 'string' as const, description: 'The verdict: is it worth reading, and how strongly do reviewers recommend it.' },
    dislikes: { type: 'string' as const, description: "What readers most commonly didn't enjoy. Empty string if there is no shared complaint." },
    audience: { type: 'string' as const, description: "Who it's for and who it's not for." },
  },
  required: ['summary', 'recommendation', 'dislikes', 'audience'],
  additionalProperties: false,
};

const SUMMARY_PROMPT = `Summarize these Goodreads reviews for someone deciding whether to read this book. Reviews run newest first, each prefixed with its date and star rating: if the newest ones read differently from older ones — content that has dated, a consensus that turned — say so, with the years. Be concise and specific to THIS book (writing style, characters, pacing, plot, themes, ending). Only use points raised by multiple reviewers; ignore reading-challenge notes, shelving chatter, and contentless one-liners. Do not reveal plot spoilers. You may use **bold** for emphasis. Each field is one or two short sentences, no preamble.`;

const stripReviewHtml = (html: string): string =>
  (new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, ' '), 'text/html').body.textContent || '')
    .replace(/\s+/g, ' ').trim();

interface GrReview { rating: number; body: string; date: string }

const toReview = (n: ReviewNode): GrReview => ({
  rating: n.rating || 0,
  body: stripReviewHtml(n.text || ''),
  date: n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 10) : '',
});

/** Reviews are server-rendered into __NEXT_DATA__ apolloState — a no-auth fallback when there's no GraphQL token. */
const getEmbeddedReviews = (): GrReview[] => {
  const script = document.querySelector('#__NEXT_DATA__');
  if (!script?.textContent) return [];
  try {
    const apollo = JSON.parse(script.textContent)?.props?.pageProps?.apolloState || {};
    return Object.keys(apollo).filter((k) => k.startsWith('Review:')).map((k) => toReview(apollo[k]));
  } catch { return []; }
};

/**
 * LLM-ready text, newest first, each review dated and starred so a drift in the newest
 * ones (content that has aged, a consensus that turned) is visible to the model.
 * Deduped, contentless one-liners dropped.
 */
const collectReviewTexts = (reviews: GrReview[]): string[] => {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const r of reviews) {
    if (r.body.length < 20 || seen.has(r.body)) continue;
    seen.add(r.body);
    texts.push(`[${r.date || 'undated'}${r.rating ? `, ${r.rating}★` : ''}] ${r.body}`);
  }
  return texts;
};

const GR_QUESTION_PROMPT = `Answer this question using ONLY evidence from the book reviews below. Reviews run newest first, each prefixed with its date and star rating; when the question is whether the book still holds up, weigh the newest. Quote or paraphrase the concrete details reviewers give. If reviewers disagree, surface the tension. Avoid plot spoilers. Be direct and practical.`;

// Lazy + memoized review fetch for the summary widget: the newest reviews'
// full text via GraphQL when logged in, else the reviews embedded in the page.
const makeGetReviews = (workId: string, signedIn: boolean): (() => Promise<GrReview[]>) => {
  let reviewsPromise: Promise<GrReview[]> | null = null;
  return () =>
    (reviewsPromise ??= (async () => {
      if (signedIn) {
        try {
          const { nodes } = await fetchReviewNodes(workId, { withText: true });
          if (nodes.length) return nodes.map(toReview);
        } catch {}
      }
      return getEmbeddedReviews();
    })());
};

// =============================================================================
// Review search
// =============================================================================

const GR_SEARCH_SUMMARY_PROMPT = `Summarize what these book reviews say about the searched topic. Lead with the bottom line, keep it specific to what reviewers actually wrote, and avoid plot spoilers. A short paragraph or a few bullets.`;

/**
 * Bare searchText ORs its tokens, so "chapter 8" would match every review mentioning
 * either word (113 of them). A LEADING UNBALANCED double quote switches the endpoint to
 * an exact phrase match — `"chapter 8` returns the 4 reviews that really say it, with an
 * exact totalCount and no effect on single words. A closing quote breaks it back to zero
 * results, so strip any the user typed and supply our own.
 */
const phraseQuery = (term: string) => `"${term.replace(/"/g, '')}`;

const REVIEW_FIELDS = (r: GrReview) => ({ rating: r.rating, body: r.body, meta: r.date });

/**
 * Search every review of the book through Goodreads' own endpoint — one request per
 * ` OR ` term, results cached so backspacing doesn't refire them. Without a token there
 * is no endpoint to call, so it falls back to filtering the reviews embedded in the page.
 *
 * A single term's count is exact, but only the newest REVIEW_PAGE_LIMIT hits come back,
 * so a term with more matches than that has its %-positive read off that newest sample.
 */
const makeReviewSearch = (workId: string) => {
  const cache = new Map<string, { matches: GrReview[]; total: number }>();
  return async (terms: string[]) => {
    const key = terms.join(' OR ');
    let hit = cache.get(key);
    if (!hit) {
      const pages = await Promise.all(terms.map((t) =>
        fetchReviewNodes(workId, { withText: true, searchText: phraseQuery(t) })));
      const seen = new Set<string>();
      const matches: GrReview[] = [];
      for (const { nodes } of pages) {
        for (const n of nodes) {
          const r = toReview(n);
          if (r.body && !seen.has(r.body)) { seen.add(r.body); matches.push(r); }
        }
      }
      // Concatenated pages lose the endpoint's newest-first order; one page keeps it.
      if (pages.length > 1) matches.sort((a, b) => b.date.localeCompare(a.date));
      // One term: the endpoint's own count spans every review, not just the page we
      // pulled. Several: all we can honestly claim is what the union actually holds.
      hit = { matches, total: pages.length === 1 ? pages[0].totalCount : matches.length };
      cache.set(key, hit);
    }
    return hit;
  };
};

const buildReviewSearch = (search: ReturnType<typeof makeReviewSearch>, total: number) => buildSearchSection<GrReview>({
  reviews: [],
  total,
  search,
  fields: REVIEW_FIELDS,
  toText: (r) => r.body,
  summaryPrompt: GR_SEARCH_SUMMARY_PROMPT,
  exampleQuery: 'slow start OR pacing',
});

// =============================================================================
// Score display
// =============================================================================

const appendScore = async (bookTitle: Element) => {
  injectStyles();
  const stats = getCurrentBookStats();
  if (!stats) return;

  const currentId = getBookIdFromURL(window.location.href);
  if (currentId) cacheBookStats(currentId, stats);
  sessionToken = stats.jwtToken;
  const signedIn = !!stats.jwtToken;

  const scoreElement = el('h1', undefined, `${addCommas(Math.round(stats.score))} (${Math.round(stats.ratio * 100)}%)`);
  bookTitle.parentNode!.insertBefore(scoreElement, bookTitle.nextSibling);

  const recentElement = el('div', undefined, 'Recent: loading...');
  recentElement.style.cssText = 'font-size: 16px; margin-top: 4px; color: #666;';
  scoreElement.parentNode!.insertBefore(recentElement, scoreElement.nextSibling);

  const getReviews = makeGetReviews(stats.workId, signedIn);
  const searchReviews = signedIn ? makeReviewSearch(stats.workId) : null;

  // Mount the AI panel synchronously so a cached summary / Q&A restores instantly —
  // buildMediaSummary reads localStorage and never blocks on the network. Review
  // text is fetched lazily, only when the user actually summarizes or asks.
  const summarySection = buildMediaSummary({
    anchor: recentElement,
    classPrefix: 'gr-summary',
    heading: 'Reader Reviews',
    summaryPrompt: SUMMARY_PROMPT,
    schema: SUMMARY_SCHEMA,
    sections: [['Summary', 'summary'], ['Verdict', 'recommendation'], ['Didn’t enjoy', 'dislikes'], ['Who it’s for', 'audience']],
    summaryCacheKey: currentId ? `gr_summary_${currentId}` : null,
    summaryTtl: CONFIG.SUMMARY_CACHE_MS,
    initialButtonLabel: '✦ Summarize reviews',
    fetchReviews: () => getReviews().then(collectReviewTexts),
    ask: { placeholder: 'Ask about this book…', questionPrompt: GR_QUESTION_PROMPT, qaCacheKey: currentId ? `gr_summary_${currentId}` : null },
    // With the endpoint, an Ask may Search every review; a row opens it in the search box.
    searchAsk: searchReviews ? {
      search: searchWith((terms) => searchReviews(terms).then((hit) => hit.matches), (r) => r.body, (r) => r.rating),
      open: (query) => runSearch(summarySection, query),
    } : undefined,
  });

  // Ratings-only fetch (fast) for the recent ratio + the picks' recent-% threshold. The
  // picks start now rather than after it: a cached view needs nothing from it, and a
  // shelf lookup outlasts it anyway.
  const recentStats = getRecentStats(stats.workId, signedIn);
  renderSimilarPicks(summarySection, window.location.href, stats, recentStats.then((r) => r.ratio));
  const { ratio: recentRatio, total: reviewTotal } = await recentStats;
  recentElement.textContent = recentRatio !== null
    ? `Recent: ${Math.round(recentRatio * 100)}%`
    : 'Recent: N/A';

  if (searchReviews && reviewTotal) {
    summarySection.appendChild(buildReviewSearch(searchReviews, reviewTotal));
  } else {
    const reviews = await getReviews();
    if (reviews.length) {
      summarySection.appendChild(buildSearchSection<GrReview>({
        reviews,
        fields: REVIEW_FIELDS,
        toText: (r) => r.body,
        summaryPrompt: GR_SEARCH_SUMMARY_PROMPT,
        exampleQuery: 'slow start OR pacing',
      }));
    }
  }
};

const init = () => {
  const ready = () => {
    const bookTitle = document.querySelector('[data-testid="bookTitle"]');
    const labelTotal5 = document.querySelector('[data-testid="labelTotal-5"]');
    return bookTitle && labelTotal5 ? bookTitle : null;
  };

  const bookTitle = ready();
  if (bookTitle) { appendScore(bookTitle); return; }

  const observer = new MutationObserver(() => {
    const bookTitle = ready();
    if (bookTitle) { appendScore(bookTitle); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
};

init();
