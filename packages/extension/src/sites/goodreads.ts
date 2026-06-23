import { cacheGet, cacheSet } from '../shared/cache';
import { idbGet, idbSet } from '../shared/idb-cache';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { addCommas, el, renderMarkdown, renderMarkdownInline } from '../shared/utils';
import { llmSummarize } from '../shared/review-summary';

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

/** One getReviews call (newest first). `withText` also pulls the review prose for the AI summary. */
const fetchReviewNodes = async (workId: string, jwtToken: string, withText = false): Promise<ReviewNode[]> => {
  const res = await throttledFetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json', authorization: jwtToken },
    body: JSON.stringify({
      operationName: 'getReviews',
      variables: {
        filters: { resourceType: 'WORK', resourceId: workId, sort: 'NEWEST' },
        pagination: { limit: 100 },
      },
      query: `query getReviews($filters: BookReviewsFilterInput!, $pagination: PaginationInput) {
        getReviews(filters: $filters, pagination: $pagination) {
          edges { node { rating createdAt${withText ? ' text' : ''} } }
        }
      }`,
    }),
  });
  const data = await res.json();
  return (data?.data?.getReviews?.edges?.map((e: any) => e.node).filter(Boolean) as ReviewNode[]) || [];
};

const recentRatioFromNodes = (nodes: ReviewNode[]): number | null => {
  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const ratings = nodes
    .filter((n) => n.rating && n.createdAt != null && n.createdAt >= oneYearAgo)
    .map((n) => n.rating as number);
  if (!ratings.length) return null;
  let s = 0;
  for (const r of ratings) { if (r === 5) s++; if (r === 1) s--; }
  return s / ratings.length;
};

const getRecentRatio = async (workId: string, jwtToken: string | null): Promise<number | null> => {
  if (!jwtToken) return null;
  try { return recentRatioFromNodes(await fetchReviewNodes(workId, jwtToken)); }
  catch { return null; }
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
  if (threshold !== null) lines.push(`Recent % threshold: ${threshold}%`);
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
  const threshold = refRecentRatio !== null ? Math.round(refRecentRatio * 100) : null;
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
  let passCount = 0;
  for (const pick of result.qualifying) {
    const { item, recent: recentEl } = buildItem(pick);
    const rr = recent[pick.bookId] ?? null;
    const rrPct = rr !== null ? Math.round(rr * 100) : null;
    const passes = refRecentRatio === null || (rr !== null && rr >= refRecentRatio);
    recentEl.textContent = rrPct !== null ? `Recent: ${rrPct}%` : 'Recent: N/A';
    if (passes) {
      passCount++;
      if (rrPct !== null) recentEl.classList.add('-pass');
    } else {
      item.classList.add('-excluded');
      recentEl.classList.add('-fail');
      item.append(el('span', 'gr-similar-reason', `need ≥${threshold}%`));
    }
    list.append(item);
  }

  if (passCount === 0 && threshold !== null) {
    section.append(winnerBanner('Winner! No book matches score AND recent reviews.', shelf));
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
  const viewKey = `gr_picks_view_${getBookIdFromURL(currentBookURL)}`;
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

  // Resolve each pick's recent ratio, then cache + render the complete view.
  const recent: PickRecent = {};
  await Promise.all(result.qualifying.map(async (pick) => {
    recent[pick.bookId] = await getRecentRatio(pick.workId, currentStats.jwtToken);
  }));

  const view: SimilarView = { shelf, result, recent, refRecentRatio: currentRecentRatio };
  // Persist a slim copy — allScored is a large per-candidate debug list we don't need to keep.
  idbSet(viewKey, { ...view, result: { ...result, allScored: [] } });
  renderPicksView(section, view, currentStats);
};

// =============================================================================
// Review summary (AI)
// =============================================================================

type BookSummary = { summary: string; recommendation: string; dislikes?: string; audience: string };

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

/** Reviews are server-rendered into __NEXT_DATA__ apolloState — a no-auth fallback when there's no GraphQL token. */
const getEmbeddedReviewTexts = (): (string | null | undefined)[] => {
  const script = document.querySelector('#__NEXT_DATA__');
  if (!script?.textContent) return [];
  try {
    const apollo = JSON.parse(script.textContent)?.props?.pageProps?.apolloState || {};
    return Object.keys(apollo).filter((k) => k.startsWith('Review:')).map((k) => apollo[k]?.text);
  } catch { return []; }
};

/** Strip and dedupe raw review HTML into LLM-ready text. */
const collectReviewTexts = (htmls: (string | null | undefined)[]): string[] => {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const html of htmls) {
    if (typeof html !== 'string') continue;
    const text = stripReviewHtml(html);
    if (text.length < 20 || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return texts;
};

const renderSummary = (body: HTMLElement, data: BookSummary) => {
  body.textContent = '';
  const sections: [string, string | undefined][] = [
    ['Summary', data.summary],
    ['Verdict', data.recommendation],
    ['Didn’t enjoy', data.dislikes],
    ['Who it’s for', data.audience],
  ];
  for (const [label, value] of sections) {
    if (!value?.trim()) continue;
    const sec = el('div', 'gr-summary-sec');
    sec.append(el('div', 'gr-summary-label', label));
    const text = el('div', 'gr-summary-text');
    renderMarkdownInline(text, value);
    sec.append(text);
    body.append(sec);
  }
};

const QUESTION_PROMPT = `Answer this question using ONLY evidence from the book reviews below. Quote or paraphrase the concrete details reviewers give. If reviewers disagree, surface the tension. Avoid plot spoilers. Be direct and practical.`;

type QAEntry = { q: string; a: string };
const QA_LIMIT = 10;

const loadQAs = (key: string | null): QAEntry[] => {
  if (!key) return [];
  try { const p = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(p) ? p : []; }
  catch { return []; }
};
const saveQA = (key: string | null, entry: QAEntry) => {
  if (!key) return;
  const next = [entry, ...loadQAs(key).filter((e) => e.q !== entry.q)].slice(0, QA_LIMIT);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
};

const renderAnswer = (body: HTMLElement, text: string) => {
  body.textContent = '';
  const div = el('div', 'gr-summary-text');
  renderMarkdown(div, text);
  body.append(div);
};

/**
 * Mounts the AI section after `anchor`. The shared input drives both modes:
 * empty → "Summarize reviews" (structured book summary), text → "Ask" (free-form
 * answer). Both run over the same pre-fetched review prose; answers are cached.
 */
const displaySummary = (workId: string, jwtToken: string | null, bookId: string | null, anchor: Element): HTMLElement => {
  const section = el('section', 'gr-summary');
  const head = el('div', 'gr-summary-head');
  head.append(el('h3', 'gr-summary-header', 'Reader Reviews'));
  const relink = el('span', 'gr-summary-relink', '↻ Re-summarize');
  relink.style.display = 'none';
  relink.addEventListener('click', () => runSummary());
  head.append(relink);

  const askRow = el('div', 'gr-summary-ask');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'gr-summary-input';
  input.placeholder = 'Ask about this book…';
  const btn = el('button', 'gr-summary-btn') as HTMLButtonElement;
  askRow.append(input, btn);

  const body = el('div', 'gr-summary-body');
  body.style.display = 'none';
  const qaRow = el('div', 'gr-summary-qa');
  qaRow.style.display = 'none';

  section.append(head, askRow, body, qaRow);
  anchor.parentNode!.insertBefore(section, anchor.nextSibling);

  const summaryKey = bookId ? `gr_summary_${bookId}` : null;
  const qaKey = bookId ? `gr_qa_${bookId}` : null;
  let mode: 'none' | 'summary' | 'answer' = 'none';

  // Lazy + memoized: fetch the newest reviews' full text only when the user first
  // summarizes or asks. Falls back to the reviews embedded in the page when logged out.
  let textsPromise: Promise<string[]> | null = null;
  const getTexts = (): Promise<string[]> =>
    (textsPromise ??= (async () => {
      let nodes: ReviewNode[] = [];
      if (jwtToken) { try { nodes = await fetchReviewNodes(workId, jwtToken, true); } catch {} }
      return collectReviewTexts(nodes.length ? nodes.map((n) => n.text) : getEmbeddedReviewTexts());
    })());

  const syncBtn = () => {
    const asking = !!input.value.trim();
    btn.textContent = asking ? 'Ask' : '✦ Summarize reviews';
    btn.style.display = !asking && mode === 'summary' ? 'none' : '';
    relink.style.display = !asking && mode === 'summary' ? '' : 'none';
  };

  const progress = (label: string) => {
    body.textContent = '';
    body.append(el('div', 'gr-summary-progress', label));
    body.style.display = 'block';
  };

  const fail = (msg: string) => {
    body.textContent = '';
    body.append(el('div', 'gr-summary-error', msg));
    body.style.display = 'block';
  };

  const runSummary = async () => {
    btn.disabled = true;
    progress('⏳ Reading reviews…');
    try {
      const texts = await getTexts();
      if (!texts.length) throw new Error('No written reviews found yet.');
      progress('✦ Summarizing…');
      const data = (await llmSummarize(texts, SUMMARY_PROMPT, SUMMARY_SCHEMA)) as BookSummary;
      if (summaryKey) cacheSet(summaryKey, data);
      renderSummary(body, data);
      body.style.display = 'block';
      mode = 'summary';
    } catch (e: any) {
      fail(e.message);
    } finally {
      btn.disabled = false;
      syncBtn();
    }
  };

  const showAnswer = (text: string) => {
    renderAnswer(body, text);
    body.style.display = 'block';
    mode = 'answer';
  };

  const runAsk = async (question: string) => {
    const hit = loadQAs(qaKey).find((e) => e.q.toLowerCase() === question.toLowerCase());
    if (hit) { showAnswer(hit.a); syncBtn(); return; }
    btn.disabled = true;
    progress('⏳ Reading reviews…');
    try {
      const texts = await getTexts();
      if (!texts.length) throw new Error('No written reviews found yet.');
      progress('⏳ Asking…');
      const answer = (await llmSummarize(texts, `${QUESTION_PROMPT}\n\nQuestion: ${question}`, null)) as string;
      saveQA(qaKey, { q: question, a: answer });
      showAnswer(answer);
      renderQA();
    } catch (e: any) {
      fail(e.message);
    } finally {
      btn.disabled = false;
      syncBtn();
    }
  };

  const renderQA = () => {
    const items = loadQAs(qaKey);
    qaRow.textContent = '';
    if (!items.length) { qaRow.style.display = 'none'; return; }
    qaRow.style.display = 'flex';
    qaRow.append(el('span', 'gr-summary-qa-label', 'Recent questions'));
    for (const item of items) {
      const chip = el('button', 'gr-summary-qa-chip', item.q) as HTMLButtonElement;
      chip.title = item.q;
      chip.addEventListener('click', () => { input.value = item.q; showAnswer(item.a); syncBtn(); });
      qaRow.append(chip);
    }
  };

  btn.addEventListener('click', () => {
    const q = input.value.trim();
    if (q) runAsk(q); else runSummary();
  });
  input.addEventListener('input', syncBtn);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });

  const cached = summaryKey ? (cacheGet(summaryKey, CONFIG.SUMMARY_CACHE_MS) as BookSummary | null) : null;
  if (cached?.summary) {
    renderSummary(body, cached);
    body.style.display = 'block';
    mode = 'summary';
  }
  renderQA();
  syncBtn();

  return section;
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

  // Mount the AI panel synchronously so a cached summary / Q&A restores instantly —
  // it reads localStorage and never blocks on the network. Review text is fetched
  // lazily, only when the user actually summarizes or asks (see displaySummary).
  const summarySection = displaySummary(stats.workId, stats.jwtToken, currentId, recentElement);

  // Ratings-only fetch (fast) for the recent ratio + the picks' recent-% threshold.
  const recentRatio = await getRecentRatio(stats.workId, stats.jwtToken);
  recentElement.textContent = recentRatio !== null
    ? `Recent: ${Math.round(recentRatio * 100)}%`
    : 'Recent: N/A';

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
