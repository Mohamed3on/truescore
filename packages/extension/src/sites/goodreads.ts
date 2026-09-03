import { idbGet, idbSet } from '../shared/idb-cache';
import { rankPicks } from '../shared/better-picks';
import { recentRatio } from '../shared/recency';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { addCommas, el } from '../shared/utils';
import { buildMediaSummary } from '../shared/review-summary';
import { buildSearchSection } from '../shared/review-search';

const CONFIG = {
  BOOK_CACHE_MS: 14 * 24 * 60 * 60 * 1000,
  SHELF_SCORE_CACHE_MS: 30 * 24 * 60 * 60 * 1000,
  PICKS_CACHE_MS: 7 * 24 * 60 * 60 * 1000,
  SUMMARY_CACHE_MS: 14 * 24 * 60 * 60 * 1000,
  MAX_CONCURRENCY: 15,
  PAGE_BATCH: 2,
  MAX_PAGES: 25,
  AVG_RATING_TOLERANCE: 0.3,
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

  .gr-similar-scores {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .gr-similar-score { font-size: 15px; font-weight: 700; color: #00635d; line-height: 1; }
  .gr-similar-score-pct { font-size: 11px; color: #8b7355; font-weight: 500; margin-left: 4px; }
  .gr-similar-recent { font-size: 11px; color: #8b7355; font-weight: 500; }
  .gr-similar-recent.-pass { color: #00635d; }
  .gr-similar-recent.-fail { color: #c24a32; }

  .gr-similar-item.-excluded { opacity: .55; }
  .gr-similar-item.-excluded .gr-similar-title { color: #8b7355 !important; text-decoration: line-through; }
  .gr-similar-reason { font-size: 11px; color: #c24a32; white-space: nowrap; font-weight: 500; margin-left: 4px; }

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
    score: scoreAbsolute * ratio,
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

const bookCacheKey = (id: string) => `gr_book_${id}`;

const getBookStatsFromURL = async (bookURL: string): Promise<BookStats> => {
  const id = getBookIdFromURL(bookURL);
  if (id) {
    const cached = await idbGet(bookCacheKey(id), CONFIG.BOOK_CACHE_MS);
    if (cached) return cached;
  }
  const doc = await fetchDoc(bookURL);
  const script = doc.querySelector('#__NEXT_DATA__');
  if (!script?.textContent) throw new Error('no __NEXT_DATA__ on ' + bookURL);
  const stats = parseBookNextData(JSON.parse(script.textContent));
  if (!stats) throw new Error('could not parse book stats ' + bookURL);
  if (id) idbSet(bookCacheKey(id), stats);
  return stats;
};

// =============================================================================
// Recent ratio (GraphQL)
// =============================================================================

const GRAPHQL_ENDPOINT = 'https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql';

type ReviewNode = { rating?: number | null; createdAt?: number | null; text?: string | null };

// The endpoint's ceiling — asking for more returns a null connection, not a bigger page.
const REVIEW_PAGE_LIMIT = 100;

/**
 * One getReviews call (newest first). `withText` also pulls the review prose for the AI
 * summary; `searchText` runs Goodreads' own full-text search across the *whole* review
 * corpus (see phraseQuery for its OR-vs-phrase syntax), with `totalCount` the exact
 * number of hits even when they overflow the single page we ask for.
 */
const fetchReviewNodes = async (
  workId: string,
  jwtToken: string,
  { withText = false, searchText = '' }: { withText?: boolean; searchText?: string } = {},
): Promise<{ nodes: ReviewNode[]; totalCount: number }> => {
  const res = await throttledFetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json', authorization: jwtToken },
    body: JSON.stringify({
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
    }),
  });
  const data = await res.json();
  const getReviews = data?.data?.getReviews;
  // Throw on a throttled/error response so callers can tell a real fetch failure from a
  // genuinely empty result — an error body (429, GraphQL errors) would otherwise read as [].
  if (!res.ok || data?.errors || !getReviews) throw new Error(`getReviews failed on ${workId}`);
  return {
    nodes: (getReviews.edges?.map((e: any) => e.node).filter(Boolean) as ReviewNode[]) || [],
    totalCount: getReviews.totalCount ?? 0,
  };
};

// The window is the Goodreads-specific part; the polarity and the null contract
// come from shared/recency so every site answers "how recent-positive?" the same way.
const recentRatioFromNodes = (nodes: ReviewNode[]): number | null => {
  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  return recentRatio(
    nodes
      .filter((n) => n.rating && n.createdAt != null && n.createdAt >= oneYearAgo)
      .map((n) => n.rating as number),
  );
};

/** Recent-positive ratio plus the size of the book's text-review corpus (0 when unknown). */
const getRecentStats = async (workId: string, jwtToken: string | null): Promise<{ ratio: number | null; total: number }> => {
  if (!jwtToken) return { ratio: null, total: 0 };
  try {
    const { nodes, totalCount } = await fetchReviewNodes(workId, jwtToken);
    return { ratio: recentRatioFromNodes(nodes), total: totalCount };
  } catch { return { ratio: null, total: 0 }; }
};

// =============================================================================
// Shelf selection
// =============================================================================

const getBookShelves = async (bookURL: string): Promise<string[]> => {
  const shelvesURL = bookURL.replace('/show/', '/shelves/').replace(/(?<=goodreads\.com)\/[a-z]{2}(?=\/book)/, '');
  const doc = await fetchDoc(shelvesURL);
  return Array.from(doc.querySelectorAll('a.mediumText'))
    .map(el => el.textContent?.trim() || '')
    .filter(Boolean);
};

const getShelfScore = async (shelf: string): Promise<number> => {
  const cacheKey = `gr_shelf_score_${shelf}`;
  const cached = await idbGet(cacheKey, CONFIG.SHELF_SCORE_CACHE_MS);
  if (cached !== null) return cached;
  const doc = await fetchDoc(`https://www.goodreads.com/shelf/show/${shelf}`);
  const liked = doc.querySelectorAll('[data-rating="4"], [data-rating="5"]').length;
  const disliked = doc.querySelectorAll('[data-rating="1"], [data-rating="2"]').length;
  const score = liked - disliked;
  idbSet(cacheKey, score);
  return score;
};

const pickShelf = async (shelves: string[]): Promise<string | null> => {
  for (const shelf of shelves) {
    try {
      const score = await getShelfScore(shelf);
      if (score >= CONFIG.IGNORED_SHELF_THRESHOLD) return shelf;
    } catch (e: any) { debug(`shelf ${shelf} failed:`, e.message); }
  }
  return null;
};

// =============================================================================
// Best-book search
// =============================================================================

type Candidate = {
  bookId: string;
  bookURL: string;
  title: string;
  author: string;
  cover: string;
  isRead: boolean;
  bookRating: string | null;
};

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
    return {
      bookId,
      bookURL,
      title,
      author,
      cover,
      isRead: !!row.querySelector('.hasRating'),
      bookRating: ratingText.match(/\d(\.\d+)?(?=\s+—)/)?.[0] || null,
    };
  }).filter((x): x is Candidate => x !== null);

type ScoredCandidate = Candidate & BookStats;
type FailedCandidate = Candidate & { failed: true };

type SimilarResult = {
  qualifying: ScoredCandidate[];
  allScored: Array<ScoredCandidate | FailedCandidate>;
  totalEligible: number;
  pagesSearched: number;
  foundOnPage: number;
};

const findSimilarPicks = async (params: {
  originalBookURL: string;
  shelf: string;
  refScore: number;
  refRatio: number;
  refAvgRating: string;
}): Promise<SimilarResult> => {
  const { originalBookURL, shelf, refScore, refRatio, refAvgRating } = params;
  const originalId = getBookIdFromURL(originalBookURL);
  const cacheKey = `gr_picks_${originalId}_${shelf}`;
  const cached = (await idbGet(cacheKey, CONFIG.PICKS_CACHE_MS)) as SimilarResult | null;
  if (cached) return cached;
  const refAvg = parseFloat(refAvgRating);

  const allScored: Array<ScoredCandidate | FailedCandidate> = [];
  let totalEligible = 0;
  let pagesSearched = 0;
  let foundOnPage = 0;

  for (let start = 1; start <= CONFIG.MAX_PAGES; start += CONFIG.PAGE_BATCH) {
    const end = Math.min(start + CONFIG.PAGE_BATCH - 1, CONFIG.MAX_PAGES);
    debug(`Scanning shelf "${shelf}" pages ${start}-${end}`);

    const pageResults = await Promise.all(
      Array.from({ length: end - start + 1 }, (_, i) => {
        const pageNum = start + i;
        return fetchDoc(`https://www.goodreads.com/shelf/show/${shelf}?page=${pageNum}`)
          .then(doc => ({ pageNum, doc }))
          .catch(() => ({ pageNum, doc: null as Document | null }));
      })
    );

    pagesSearched = end;

    const rowsWithPage = pageResults.flatMap(({ pageNum, doc }) =>
      doc ? parseShelfPage(doc).map(c => ({ ...c, pageNum })) : []
    );
    if (!rowsWithPage.length) break;

    const refRow = rowsWithPage.find(r => r.bookId === originalId);
    if (refRow && !foundOnPage) foundOnPage = refRow.pageNum;

    const eligible = rowsWithPage.filter(({ bookId, isRead, bookRating }) => {
      if (bookId === originalId) return false;
      if (isRead) return false;
      return refAvg - parseFloat(bookRating || '0') <= CONFIG.AVG_RATING_TOLERANCE;
    });
    totalEligible += eligible.length;

    const scored = await Promise.all(eligible.map(async (c) => {
      try {
        const stats = await getBookStatsFromURL(c.bookURL);
        return { ...c, ...stats } as ScoredCandidate;
      } catch {
        return { ...c, failed: true as const };
      }
    }));
    allScored.push(...scored);

    const qualifying = scored
      .filter((b): b is ScoredCandidate => !('failed' in b))
      .filter(b => b.score >= refScore && b.ratio >= refRatio)
      .sort((a, b) => b.score - a.score);

    if (qualifying.length) {
      const result: SimilarResult = { qualifying, allScored, totalEligible, pagesSearched, foundOnPage };
      idbSet(cacheKey, result);
      return result;
    }

    // later pages sorted lower by popularity — unlikely to beat reference
    if (refRow) break;
  }

  const result: SimilarResult = { qualifying: [], allScored, totalEligible, pagesSearched, foundOnPage };
  idbSet(cacheKey, result);
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

const buildItem = (pick: ScoredCandidate) => {
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
  item.append(body);

  const scores = el('div', 'gr-similar-scores');
  const scoreLine = el('span', 'gr-similar-score', addCommas(Math.round(pick.score)));
  scoreLine.append(el('span', 'gr-similar-score-pct', `${Math.round(pick.ratio * 100)}%`));
  scores.append(scoreLine);
  const recent = el('span', 'gr-similar-recent', 'Recent: …');
  scores.append(recent);
  item.append(scores);

  return { item, recent };
};

const debugPane = (shelf: string, result: SimilarResult, threshold: number | null, refScore: number) => {
  const toggle = el('div', 'gr-debug-toggle', '▶ Debug info');
  const content = el('div', 'gr-debug-content');
  content.style.display = 'none';
  const lines = [
    `Shelf: ${shelf}`,
    `Pages searched: ${result.pagesSearched}${result.foundOnPage ? ` (reference on page ${result.foundOnPage})` : ''}`,
    `Eligible candidates: ${result.totalEligible}`,
    `Scored: ${result.allScored.length}`,
    `Qualifying (score ≥ ${addCommas(Math.round(refScore))}): ${result.qualifying.length}`,
  ];
  lines.push(threshold !== null ? `Adjusted threshold: ${addCommas(threshold)}` : 'Adjusted threshold: unknown (no recent reviews for this book)');
  if (result.allScored.length) {
    lines.push('', 'All scored:');
    for (const b of result.allScored) {
      if ('failed' in b) {
        lines.push(`  (failed) ${b.title || b.bookId}`);
      } else {
        const mark = b.score >= refScore ? '✓' : '✗';
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
  refInfo.append(document.createTextNode('beat reference '));
  refInfo.append(el('strong', undefined, addCommas(Math.round(currentStats.score))));
  refInfo.append(document.createTextNode(` (${Math.round(currentStats.ratio * 100)}%)`));
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
  for (const ranked of ranking.ranked) {
    const { item, recent: recentEl } = buildItem(ranked.item);
    const rr = ranked.ratio;
    recentEl.textContent = rr !== null ? `Recent: ${Math.round(rr * 100)}%` : 'Recent: N/A';
    if (ranked.passes) {
      if (rr !== null) recentEl.classList.add('-pass');
    } else {
      item.classList.add('-excluded');
      recentEl.classList.add('-fail');
      if (threshold !== null) item.append(el('span', 'gr-similar-reason', `need \u2265${addCommas(threshold)} adjusted`));
    }
    list.append(item);
  }

  if (!ranking.passed.length && threshold !== null) {
    section.append(winnerBanner('Winner! No book beats its recent-adjusted score.', shelf));
  }
  section.append(list);
  section.append(debugPane(shelf, result, threshold, currentStats.score));
};

const renderSimilarPicks = async (
  anchor: Element,
  currentBookURL: string,
  currentStats: BookStats,
  currentRecentRatio: number | null,
) => {
  const section = el('section', 'gr-similar');
  anchor.parentNode!.insertBefore(section, anchor.nextSibling);

  // Cached full view → restore instantly; no shelf lookup or book fetches on refresh.
  // v2: bumped to flush entries poisoned by cached "Recent: N/A" from failed fetches.
  const viewKey = `gr_picks_view2_${getBookIdFromURL(currentBookURL)}`;
  const cachedView = (await idbGet(viewKey, CONFIG.PICKS_CACHE_MS)) as SimilarView | null;
  if (cachedView) { renderPicksView(section, cachedView, currentStats); return; }

  renderProgress(section, 0);

  let shelf: string;
  let result: SimilarResult;

  try {
    const shelves = await getBookShelves(currentBookURL);
    if (!shelves.length) {
      section.textContent = '';
      section.append(winnerBanner('No shelves found for this book.', null));
      return;
    }
    const picked = await pickShelf(shelves);
    if (!picked) {
      section.textContent = '';
      section.append(winnerBanner('No usable shelf found for this book.', null));
      return;
    }
    shelf = picked;

    renderProgress(section, 1, `Fetching books in "${shelf}"…`);

    result = await findSimilarPicks({
      originalBookURL: currentBookURL,
      shelf,
      refScore: currentStats.score,
      refRatio: currentStats.ratio,
      refAvgRating: currentStats.avgRating,
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
  const { jwtToken } = currentStats;
  const recent: PickRecent = {};
  let recentFailed = !jwtToken;
  await Promise.all(result.qualifying.map(async (pick) => {
    if (!jwtToken) return;
    try { recent[pick.bookId] = recentRatioFromNodes((await fetchReviewNodes(pick.workId, jwtToken)).nodes); }
    catch { recentFailed = true; }
  }));

  const view: SimilarView = { shelf, result, recent, refRecentRatio: currentRecentRatio };
  // Persist a slim copy — allScored is a large per-candidate debug list we don't need to keep.
  if (!recentFailed) idbSet(viewKey, { ...view, result: { ...result, allScored: [] } });
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
  required: ['summary', 'recommendation', 'audience'],
};

const SUMMARY_PROMPT = `Summarize these Goodreads reviews for someone deciding whether to read this book. Be concise and specific to THIS book (writing style, characters, pacing, plot, themes, ending). Only use points raised by multiple reviewers; ignore reading-challenge notes, shelving chatter, and contentless one-liners. Do not reveal plot spoilers. You may use **bold** for emphasis. Each field is one or two short sentences, no preamble.`;

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

/** Dedupe into LLM-ready text, dropping contentless one-liners. */
const collectReviewTexts = (reviews: GrReview[]): string[] =>
  [...new Set(reviews.map((r) => r.body).filter((t) => t.length >= 20))];

const GR_QUESTION_PROMPT = `Answer this question using ONLY evidence from the book reviews below. Quote or paraphrase the concrete details reviewers give. If reviewers disagree, surface the tension. Avoid plot spoilers. Be direct and practical.`;

// Lazy + memoized review fetch for the summary widget: the newest reviews'
// full text via GraphQL when logged in, else the reviews embedded in the page.
const makeGetReviews = (workId: string, jwtToken: string | null): (() => Promise<GrReview[]>) => {
  let reviewsPromise: Promise<GrReview[]> | null = null;
  return () =>
    (reviewsPromise ??= (async () => {
      if (jwtToken) {
        try {
          const { nodes } = await fetchReviewNodes(workId, jwtToken, { withText: true });
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
const buildReviewSearch = (workId: string, jwtToken: string, total: number) => {
  const cache = new Map<string, { matches: GrReview[]; total: number }>();
  return buildSearchSection<GrReview>({
    reviews: [],
    total,
    search: async (terms) => {
      const key = terms.join(' OR ');
      let hit = cache.get(key);
      if (!hit) {
        const pages = await Promise.all(terms.map((t) =>
          fetchReviewNodes(workId, jwtToken, { withText: true, searchText: phraseQuery(t) })));
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
    },
    fields: REVIEW_FIELDS,
    toText: (r) => r.body,
    summaryPrompt: GR_SEARCH_SUMMARY_PROMPT,
    exampleQuery: 'slow start OR pacing',
  });
};

// =============================================================================
// Score display
// =============================================================================

const appendScore = async (bookTitle: Element) => {
  injectStyles();
  const stats = getCurrentBookStats();
  if (!stats) return;

  const currentId = getBookIdFromURL(window.location.href);
  if (currentId) idbSet(bookCacheKey(currentId), stats);

  const scoreElement = el('h1', undefined, `${addCommas(Math.round(stats.score))} (${Math.round(stats.ratio * 100)}%)`);
  bookTitle.parentNode!.insertBefore(scoreElement, bookTitle.nextSibling);

  const recentElement = el('div', undefined, 'Recent: loading...');
  recentElement.style.cssText = 'font-size: 16px; margin-top: 4px; color: #666;';
  scoreElement.parentNode!.insertBefore(recentElement, scoreElement.nextSibling);

  const getReviews = makeGetReviews(stats.workId, stats.jwtToken);

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
  });

  // Ratings-only fetch (fast) for the recent ratio + the picks' recent-% threshold.
  const { ratio: recentRatio, total: reviewTotal } = await getRecentStats(stats.workId, stats.jwtToken);
  recentElement.textContent = recentRatio !== null
    ? `Recent: ${Math.round(recentRatio * 100)}%`
    : 'Recent: N/A';

  if (stats.jwtToken && reviewTotal) {
    summarySection.appendChild(buildReviewSearch(stats.workId, stats.jwtToken, reviewTotal));
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

  renderSimilarPicks(summarySection, window.location.href, stats, recentRatio);
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
