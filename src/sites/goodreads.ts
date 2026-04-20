import { cacheGet, cacheSet } from '../shared/cache';
import { addCommas } from '../shared/utils';

const CONFIG = {
  BOOK_CACHE_MS: 14 * 24 * 60 * 60 * 1000,
  SHELF_SCORE_CACHE_MS: 30 * 24 * 60 * 60 * 1000,
  BEST_BOOK_CACHE_MS: 7 * 24 * 60 * 60 * 1000,
  MAX_CONCURRENCY: 15,
  PAGE_BATCH: 5,
  MAX_PAGES: 25,
  AVG_RATING_TOLERANCE: 0.3,
  IGNORED_SHELF_THRESHOLD: -2,
  DEBUG: false,
};

const debug = (...args: any[]) => CONFIG.DEBUG && console.log('[GR]', ...args);

const STYLES = `
  .gr-best-book {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding: 6px 12px;
    background: #00635d;
    color: #fff !important;
    border-radius: 4px;
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.2;
  }
  .gr-best-book:hover { background: #004a45; text-decoration: none; }
  .gr-best-book.-loading, .gr-best-book.-none {
    background: #888;
    cursor: default;
    pointer-events: none;
  }
  .gr-best-book-meta { font-weight: 400; opacity: .85; font-size: 12px; }
`;

function injectStyles() {
  if (document.getElementById('gr-extension-styles')) return;
  const style = document.createElement('style');
  style.id = 'gr-extension-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

// =============================================================================
// Throttled fetch
// =============================================================================

function createThrottledFetcher(concurrency: number) {
  let active = 0;
  const queue: { fn: () => Promise<Response>; resolve: (v: Response) => void; reject: (e: any) => void }[] = [];
  const next = () => {
    while (active < concurrency && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift()!;
      fn().then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  return (url: string, options: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    queue.push({
      fn: () => fetch(url, { credentials: 'include', ...options }),
      resolve, reject,
    });
    next();
  });
}

const throttledFetch = createThrottledFetcher(CONFIG.MAX_CONCURRENCY);

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

const getBookStatsFromURL = async (bookURL: string): Promise<BookStats> => {
  const cached = cacheGet(`gr_book_${bookURL}`, CONFIG.BOOK_CACHE_MS);
  if (cached) return cached;
  const doc = await fetchDoc(bookURL);
  const script = doc.querySelector('#__NEXT_DATA__');
  if (!script?.textContent) throw new Error('no __NEXT_DATA__ on ' + bookURL);
  const stats = parseBookNextData(JSON.parse(script.textContent));
  if (!stats) throw new Error('could not parse book stats ' + bookURL);
  cacheSet(`gr_book_${bookURL}`, stats);
  return stats;
};

// =============================================================================
// Recent ratio (GraphQL)
// =============================================================================

const fetchRecentRatings = async (workId: string, jwtToken: string): Promise<number[]> => {
  const res = await fetch(
    'https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: jwtToken },
      body: JSON.stringify({
        operationName: 'getReviews',
        variables: {
          filters: { resourceType: 'WORK', resourceId: workId, sort: 'NEWEST' },
          pagination: { limit: 100 },
        },
        query: `query getReviews($filters: BookReviewsFilterInput!, $pagination: PaginationInput) {
          getReviews(filters: $filters, pagination: $pagination) {
            edges { node { rating createdAt } }
          }
        }`,
      }),
    }
  );
  const data = await res.json();
  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  return (
    data?.data?.getReviews?.edges
      ?.map((e: any) => e.node)
      .filter((n: any) => n.rating && n.createdAt >= oneYearAgo)
      .map((n: any) => n.rating) || []
  );
};

const calculateRecentRatio = (ratings: number[]): number | null => {
  if (!ratings.length) return null;
  let s = 0;
  for (const r of ratings) { if (r === 5) s++; if (r === 1) s--; }
  return s / ratings.length;
};

const getRecentRatio = async (workId: string, jwtToken: string | null): Promise<number | null> => {
  if (!jwtToken) return null;
  try { return calculateRecentRatio(await fetchRecentRatings(workId, jwtToken)); }
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
  const cached = cacheGet(cacheKey, CONFIG.SHELF_SCORE_CACHE_MS);
  if (cached !== null) return cached;
  const doc = await fetchDoc(`https://www.goodreads.com/shelf/show/${shelf}`);
  const liked = doc.querySelectorAll('[data-rating="4"], [data-rating="5"]').length;
  const disliked = doc.querySelectorAll('[data-rating="1"], [data-rating="2"]').length;
  const score = liked - disliked;
  cacheSet(cacheKey, score);
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

type Candidate = { bookURL: string; isRead: boolean; bookRating: string | null };

const parseShelfPage = (doc: Document): Candidate[] =>
  Array.from(doc.querySelectorAll<HTMLElement>('.leftContainer > .elementList')).map(el => {
    const titleEl = el.querySelector('.bookTitle') as HTMLAnchorElement | null;
    const href = titleEl?.getAttribute('href');
    if (!href) return null;
    const ratingText = el.querySelector('.greyText.smallText')?.textContent || '';
    return {
      bookURL: new URL(href, 'https://www.goodreads.com').href,
      isRead: !!el.querySelector('.hasRating'),
      bookRating: ratingText.match(/\d(\.\d+)?(?=\s+—)/)?.[0] || null,
    };
  }).filter((x): x is Candidate => x !== null);

const evaluateCandidate = async (
  c: Candidate,
  refScore: number,
  refRatio: number,
  refRecentRatio: number | null,
): Promise<string | null> => {
  let stats: BookStats;
  try { stats = await getBookStatsFromURL(c.bookURL); }
  catch { return null; }
  if (stats.score < refScore || stats.ratio < refRatio) return null;
  if (refRecentRatio !== null) {
    const rr = await getRecentRatio(stats.workId, stats.jwtToken);
    if (rr === null || rr < refRecentRatio) return null;
  }
  return c.bookURL;
};

const findBestBook = async (params: {
  originalBookURL: string;
  shelf: string;
  refScore: number;
  refRatio: number;
  refAvgRating: string;
  refRecentRatio: number | null;
}): Promise<string | null> => {
  const { originalBookURL, shelf, refScore, refRatio, refAvgRating, refRecentRatio } = params;
  const cacheKey = `gr_best_${getBookIdFromURL(originalBookURL)}`;
  const cached = cacheGet(cacheKey, CONFIG.BEST_BOOK_CACHE_MS);
  if (cached !== null) return cached;
  const originalId = getBookIdFromURL(originalBookURL);

  for (let start = 1; start <= CONFIG.MAX_PAGES; start += CONFIG.PAGE_BATCH) {
    const end = Math.min(start + CONFIG.PAGE_BATCH - 1, CONFIG.MAX_PAGES);
    debug(`Scanning shelf "${shelf}" pages ${start}-${end}`);

    const pageDocs = await Promise.all(
      Array.from({ length: end - start + 1 }, (_, i) =>
        fetchDoc(`https://www.goodreads.com/shelf/show/${shelf}?page=${start + i}`).catch(() => null)
      )
    );

    const rows = pageDocs.flatMap(d => d ? parseShelfPage(d) : []);
    if (!rows.length) break;

    const referenceInBatch = rows.some(r => getBookIdFromURL(r.bookURL) === originalId);

    const eligible = rows.filter(({ bookURL, isRead, bookRating }) => {
      if (getBookIdFromURL(bookURL) === originalId) return false;
      if (isRead) return false;
      const diff = parseFloat(refAvgRating) - parseFloat(bookRating || '0');
      return diff <= CONFIG.AVG_RATING_TOLERANCE;
    });

    // Race: resolve with the first qualifier; `Promise.any` ignores rejections.
    try {
      const winner = await Promise.any(
        eligible.map(async (c) => {
          const url = await evaluateCandidate(c, refScore, refRatio, refRecentRatio);
          if (!url) throw new Error('no match');
          return url;
        })
      );
      cacheSet(cacheKey, winner);
      return winner;
    } catch {
      // nothing in this batch
    }

    // Stop: reference book seen — later pages are unlikely to beat it.
    if (referenceInBatch) break;
  }

  cacheSet(cacheKey, '');
  return null;
};

// =============================================================================
// UI orchestration
// =============================================================================

const createButton = (text: string, cls = ''): HTMLAnchorElement => {
  const a = document.createElement('a');
  a.className = 'gr-best-book' + (cls ? ' ' + cls : '');
  a.textContent = text;
  return a;
};

const renderBestBook = async (
  anchor: Element,
  currentBookURL: string,
  currentStats: BookStats,
  currentRecentRatio: number | null,
) => {
  const btn = createButton('Finding best in this shelf…', '-loading');
  anchor.parentNode!.insertBefore(btn, anchor.nextSibling);

  try {
    const shelves = await getBookShelves(currentBookURL);
    if (!shelves.length) { btn.textContent = 'No shelves found'; btn.className = 'gr-best-book -none'; return; }

    const shelf = await pickShelf(shelves);
    if (!shelf) { btn.textContent = 'No usable shelf'; btn.className = 'gr-best-book -none'; return; }

    btn.textContent = `Searching "${shelf}"…`;

    const bestURL = await findBestBook({
      originalBookURL: currentBookURL,
      shelf,
      refScore: currentStats.score,
      refRatio: currentStats.ratio,
      refAvgRating: currentStats.avgRating,
      refRecentRatio: currentRecentRatio,
    });

    if (bestURL) {
      btn.textContent = '';
      btn.className = 'gr-best-book';
      btn.href = bestURL;
      btn.target = '_blank';
      btn.rel = 'noopener';
      btn.append(document.createTextNode(`★ Best in "${shelf}" →`));
    } else {
      btn.textContent = `★ Winner in "${shelf}" — nothing beats it`;
      btn.className = 'gr-best-book -none';
    }
  } catch (e: any) {
    debug('best-book error:', e);
    btn.textContent = 'Best-book search failed';
    btn.className = 'gr-best-book -none';
  }
};

// =============================================================================
// Score display (existing behavior preserved)
// =============================================================================

const appendScore = async (bookTitle: Element) => {
  injectStyles();
  const stats = getCurrentBookStats();
  if (!stats) return;

  const scoreElement = document.createElement('h1');
  scoreElement.textContent = `${addCommas(Math.round(stats.score))} (${Math.round(stats.ratio * 100)}%)`;
  bookTitle.parentNode!.insertBefore(scoreElement, bookTitle.nextSibling);

  const recentElement = document.createElement('div');
  recentElement.style.cssText = 'font-size: 16px; margin-top: 4px; color: #666;';
  recentElement.textContent = 'Recent: loading...';
  scoreElement.parentNode!.insertBefore(recentElement, scoreElement.nextSibling);

  let recentRatio: number | null = null;
  try {
    const ratings = await fetchRecentRatings(stats.workId, stats.jwtToken || '');
    recentRatio = calculateRecentRatio(ratings);
    recentElement.textContent = recentRatio !== null
      ? `Recent: ${Math.round(recentRatio * 100)}%`
      : 'Recent: N/A';
  } catch (err) {
    recentElement.textContent = 'Recent: failed to load';
    console.error('Failed to fetch recent ratings:', err);
  }

  renderBestBook(recentElement, window.location.href, stats, recentRatio);
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
