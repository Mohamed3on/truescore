import { cacheGet, cacheSet } from '../shared/cache';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { addCommas, el } from '../shared/utils';

const CONFIG = {
  BOOK_CACHE_MS: 14 * 24 * 60 * 60 * 1000,
  SHELF_SCORE_CACHE_MS: 30 * 24 * 60 * 60 * 1000,
  PICKS_CACHE_MS: 7 * 24 * 60 * 60 * 1000,
  MAX_CONCURRENCY: 15,
  PAGE_BATCH: 5,
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
    const cached = cacheGet(bookCacheKey(id), CONFIG.BOOK_CACHE_MS);
    if (cached) return cached;
  }
  const doc = await fetchDoc(bookURL);
  const script = doc.querySelector('#__NEXT_DATA__');
  if (!script?.textContent) throw new Error('no __NEXT_DATA__ on ' + bookURL);
  const stats = parseBookNextData(JSON.parse(script.textContent));
  if (!stats) throw new Error('could not parse book stats ' + bookURL);
  if (id) cacheSet(bookCacheKey(id), stats);
  return stats;
};

// =============================================================================
// Recent ratio (GraphQL)
// =============================================================================

const fetchRecentRatings = async (workId: string, jwtToken: string): Promise<number[]> => {
  const res = await throttledFetch(
    'https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql',
    {
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
  const cached = cacheGet(cacheKey, CONFIG.PICKS_CACHE_MS) as SimilarResult | null;
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
      cacheSet(cacheKey, result);
      return result;
    }

    // later pages sorted lower by popularity — unlikely to beat reference
    if (refRow) break;
  }

  const result: SimilarResult = { qualifying: [], allScored, totalEligible, pagesSearched, foundOnPage };
  cacheSet(cacheKey, result);
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

const renderSimilarPicks = async (
  anchor: Element,
  currentBookURL: string,
  currentStats: BookStats,
  currentRecentRatio: number | null,
) => {
  const section = el('section', 'gr-similar');
  anchor.parentNode!.insertBefore(section, anchor.nextSibling);
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

  const threshold = currentRecentRatio !== null ? Math.round(currentRecentRatio * 100) : null;

  if (!result.qualifying.length) {
    section.append(winnerBanner('Winner! Nothing in this shelf beats it.', shelf));
    section.append(debugPane(shelf, result, threshold, currentStats.score));
    return;
  }

  const list = el('ul', 'gr-similar-list');
  const nodes = new Map<string, { item: HTMLElement; recent: HTMLElement }>();
  for (const pick of result.qualifying) {
    const n = buildItem(pick);
    list.append(n.item);
    nodes.set(pick.bookId, n);
  }
  section.append(list);
  section.append(debugPane(shelf, result, threshold, currentStats.score));

  let passCount = 0;
  await Promise.all(result.qualifying.map(async (pick) => {
    const node = nodes.get(pick.bookId);
    if (!node) return;
    const rr = await getRecentRatio(pick.workId, currentStats.jwtToken);
    const rrPct = rr !== null ? Math.round(rr * 100) : null;
    const passes = currentRecentRatio === null || (rr !== null && rr >= currentRecentRatio);

    if (passes) {
      passCount++;
      node.recent.textContent = rrPct !== null ? `Recent: ${rrPct}%` : 'Recent: N/A';
      if (rrPct !== null) node.recent.classList.add('-pass');
    } else {
      node.item.classList.add('-excluded');
      node.recent.textContent = rrPct !== null ? `Recent: ${rrPct}%` : 'Recent: N/A';
      node.recent.classList.add('-fail');
      node.item.append(el('span', 'gr-similar-reason', `need ≥${threshold}%`));
    }
  }));

  if (passCount === 0 && threshold !== null) {
    section.insertBefore(winnerBanner('Winner! No book matches score AND recent reviews.', shelf), list);
  }
};

// =============================================================================
// Score display
// =============================================================================

const appendScore = async (bookTitle: Element) => {
  injectStyles();
  const stats = getCurrentBookStats();
  if (!stats) return;

  const currentId = getBookIdFromURL(window.location.href);
  if (currentId) cacheSet(bookCacheKey(currentId), stats);

  const scoreElement = el('h1', undefined, `${addCommas(Math.round(stats.score))} (${Math.round(stats.ratio * 100)}%)`);
  bookTitle.parentNode!.insertBefore(scoreElement, bookTitle.nextSibling);

  const recentElement = el('div', undefined, 'Recent: loading...');
  recentElement.style.cssText = 'font-size: 16px; margin-top: 4px; color: #666;';
  scoreElement.parentNode!.insertBefore(recentElement, scoreElement.nextSibling);

  const recentRatio = await getRecentRatio(stats.workId, stats.jwtToken);
  recentElement.textContent = recentRatio !== null
    ? `Recent: ${Math.round(recentRatio * 100)}%`
    : 'Recent: N/A';

  renderSimilarPicks(recentElement, window.location.href, stats, recentRatio);
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
