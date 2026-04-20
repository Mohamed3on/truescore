import { cacheGet, cacheSet } from '../shared/cache';
import { addCommas, el } from '../shared/utils';

// =============================================================================
// Configuration
// =============================================================================
const CONFIG = {
  CACHE_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000, // 1 week
  RECENT_RATINGS_CACHE_MS: 12 * 60 * 60 * 1000, // 12 hours
  SIMILAR_PICKS_CACHE_MS: 7 * 24 * 60 * 60 * 1000, // 1 week
  RUNTIME_TOLERANCE: 10, // ±10 minutes
  MAX_SIMILAR_PAGES: 3,
  MAX_CONCURRENCY: 10,
  DEBUG: false,
};

// =============================================================================
// Styles (injected once)
// =============================================================================
const STYLES = `
  .lbx-score {
    float: left;
    font-size: 1.15384615rem;
    color: #9ab;
    line-height: 1;
    padding-top: .3rem;
  }
  .lbx-score.-new {
    float: none;
    display: block;
    padding: .15rem 0 .6rem 0;
    text-align: right;
    font-size: .8125rem;
    font-weight: 500;
    color: #9ab;
    line-height: 1.3;
    letter-spacing: .01em;
  }
  .lbx-score.-new .lbx-pct {
    color: #678;
    margin-left: .25em;
  }
  .lbx-trending {
    margin-top: 1rem;
    font-size: 1.1rem;
    font-weight: 600;
    color: #9ab;
    letter-spacing: .075em;
    text-transform: uppercase;
  }
  .lbx-similar {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid #456;
  }
  .lbx-similar-header {
    font-size: .85rem;
    font-weight: 600;
    color: #9ab;
    letter-spacing: .05em;
    text-transform: uppercase;
    margin: 0 0 .75rem 0;
  }
  .lbx-similar-source {
    display: block;
    color: #678;
    font-size: .8rem;
    margin-bottom: .75rem;
    text-decoration: none;
  }
  .lbx-similar-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: .5rem;
  }
  .lbx-similar-item {
    display: flex;
    align-items: center;
    gap: .5rem;
  }
  .lbx-similar-link {
    color: #40bcf4;
    font-weight: 500;
    text-decoration: none;
    flex: 1;
  }
  .lbx-similar-meta {
    color: #678;
    font-size: .85rem;
    white-space: nowrap;
  }
  .lbx-winner {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: .25rem .5rem;
    color: #00e054;
    font-weight: 600;
  }
  .lbx-winner-source {
    color: #678;
    font-weight: 400;
    font-size: .85em;
    text-decoration: none;
  }
  .lbx-similar-item.lbx-excluded {
    opacity: .45;
  }
  .lbx-similar-item.lbx-excluded .lbx-similar-link {
    color: #678;
    text-decoration: line-through;
  }
  .lbx-similar-reason {
    color: #e54;
    font-size: .75rem;
    white-space: nowrap;
  }
  .lbx-debug-toggle {
    color: #567;
    font-size: .75rem;
    cursor: pointer;
    margin-top: .75rem;
    user-select: none;
  }
  .lbx-debug-toggle:hover { color: #9ab; }
  .lbx-debug-content {
    color: #567;
    font-size: .75rem;
    line-height: 1.5;
    margin-top: .35rem;
    font-family: monospace;
  }
  .lbx-winner-source::before { content: '· '; }
  .lbx-winner-source:hover { color: #9ab; }
  .lbx-progress { color: #678; font-size: .9rem; }
  .lbx-progress-dots { display: flex; gap: .25rem; margin-bottom: .35rem; }
  .lbx-dot { width: 6px; height: 6px; border-radius: 50%; }
  .lbx-dot-done { background: #00e054; }
  .lbx-dot-active { background: #40bcf4; }
  .lbx-dot-pending { background: #456; }
`;

function injectStyles() {
  if (document.getElementById('lbx-extension-styles')) return;
  const style = document.createElement('style');
  style.id = 'lbx-extension-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

// =============================================================================
// Utilities
// =============================================================================

/** Debug logger - only logs when CONFIG.DEBUG is true */
const debug = (...args: any[]) => CONFIG.DEBUG && console.log('[LBX]', ...args);

/** Extracts runtime in minutes from a document */
function extractRuntime(doc: Document) {
  const footer = doc.querySelector('p.text-footer');
  if (!footer) return null;
  const match = footer.textContent!.match(/(\d+)\s*mins?/);
  return match ? parseInt(match[1], 10) : null;
}

/** Extracts release year from a document */
function extractYear(doc: Document) {
  const yearLink = doc.querySelector('.releasedate a');
  return yearLink ? yearLink.textContent!.trim() : null;
}

/** Extracts film slug from URL */
function extractSlugFromUrl(url: string) {
  const match = url.match(/\/film\/([^/]+)/);
  return match ? match[1] : null;
}

/** Parses 10 rating-bucket counts from either the new .barcolumn layout or the old .rating-histogram-bar CSI layout */
function parseRatings(root: Document | Element): number[] {
  const barcolumns = root.querySelectorAll('.barcolumn[data-original-title]');
  if (barcolumns.length) {
    return Array.from(barcolumns).map((el) => {
      const match = el.getAttribute('data-original-title')!.match(/([\d,]+)/);
      return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
    });
  }
  const bars = root.querySelectorAll('.rating-histogram-bar');
  return Array.from(bars).map((el) => parseInt(el.textContent!.replace(/,/g, '').split('&')[0]) || 0);
}

function filmMeta(film: any, recentText = '...') {
  const scoreText = film.fetchFailed ? '?' : addCommas(film.score);
  const base = `${film.year ? film.year + ' · ' : ''}${film.runtime}m · ${scoreText}`;
  return recentText ? `${base} · ${recentText}` : base;
}

function debugDetails(stats: any) {
  const toggle = el('div', 'lbx-debug-toggle', '▶ Debug info');
  const content = el('div', 'lbx-debug-content');
  content.style.display = 'none';
  const selectorMismatch = stats.totalInList === 0 && stats.lastPageItemCount > 0;
  const lines = [
    `Found on page: ${stats.foundOnPage || 'not found'} (searched ${stats.pagesSearched || '?'} of max ${CONFIG.MAX_SIMILAR_PAGES})`,
    `Candidates from list: ${stats.totalInList}${stats.totalInList === 0 && stats.lastPageItemCount != null ? ` (last page had ${stats.lastPageItemCount} posteritems)` : ''}`,
    `Runtime matched (≤${stats.currentRuntime ? stats.currentRuntime + CONFIG.RUNTIME_TOLERANCE : '?'}m): ${stats.runtimeMatched}`,
    `Scored: ${stats.scored}`,
    `Current film score: ${addCommas(stats.currentScore)}`,
  ];
  if (selectorMismatch) lines.push('⚠ Selector mismatch — Letterboxd markup may have changed');
  if (stats.recentThreshold != null) lines.push(`Recent % threshold: ${stats.recentThreshold}%`);
  if (stats.allScored?.length) {
    lines.push('');
    lines.push('All runtime-matched films:');
    for (const f of stats.allScored) {
      const status = f.fetchFailed ? '(fetch failed)' : (f.score >= stats.currentScore ? '✓' : '✗');
      lines.push(`  ${status} ${f.name} — ${f.runtime}m — ${f.fetchFailed ? '?' : addCommas(f.score)}`);
    }
  }
  lines.forEach(line => {
    content.append(document.createTextNode(line), document.createElement('br'));
  });
  toggle.addEventListener('click', () => {
    const open = content.style.display !== 'none';
    content.style.display = open ? 'none' : 'block';
    toggle.textContent = (open ? '▶' : '▼') + ' Debug info';
  });
  const wrap = el('div');
  wrap.append(toggle, content);
  return wrap;
}

function winnerBanner(message: string, listName?: string | null, listLink?: string | null) {
  const winner = el('div', 'lbx-winner', message);
  if (listName && listLink) {
    const src = el('a', 'lbx-winner-source', listName) as HTMLAnchorElement;
    src.href = listLink;
    winner.append(' ', src);
  }
  return winner;
}

// =============================================================================
// Cache
// =============================================================================

const getCachedFilmData = (slug: string) => cacheGet(`lbx_film_${slug}`, CONFIG.CACHE_EXPIRY_MS);
const setCachedFilmData = (slug: string, data: any) => cacheSet(`lbx_film_${slug}`, data);
const getCachedRecentRatings = (slug: string) => cacheGet(`lbx_recent_${slug}`, CONFIG.RECENT_RATINGS_CACHE_MS);
const setCachedRecentRatings = (slug: string, data: any) => cacheSet(`lbx_recent_${slug}`, data);
const getCachedSimilarPicks = (slug: string) => cacheGet(`lbx_similar_${slug}`, CONFIG.SIMILAR_PICKS_CACHE_MS);
const setCachedSimilarPicks = (slug: string, data: any) => cacheSet(`lbx_similar_${slug}`, data);

// =============================================================================
// Fetching
// =============================================================================

/**
 * Fetch with exponential backoff retry
 */
async function fetchWithRetry(url: string, options: RequestInit = {}, maxRetries = 5, retryDelay = 500): Promise<Response> {
  const retryable = new Set([429, 502, 503, 504]);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (retryable.has(response.status) && attempt < maxRetries) {
        const retryAfter = response.headers.get('Retry-After');
        const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : retryDelay * 2 ** (attempt - 1);
        debug(`${response.status} on ${url}, retry #${attempt} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (error: any) {
      if (attempt < maxRetries && (error.message?.startsWith('HTTP') === false)) {
        debug(`Network error on ${url}, retry #${attempt}`);
        await new Promise((r) => setTimeout(r, retryDelay * 2 ** (attempt - 1)));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed after ${maxRetries} retries`);
}

function createThrottledFetcher(concurrency = CONFIG.MAX_CONCURRENCY) {
  let active = 0;
  const queue: { fn: () => Promise<Response>; resolve: (v: Response) => void; reject: (e: any) => void }[] = [];
  function next() {
    while (active < concurrency && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift()!;
      fn().then(resolve, reject).finally(() => { active--; next(); });
    }
  }
  return (url: string, options?: RequestInit) => new Promise<Response>((resolve, reject) => {
    queue.push({ fn: () => fetchWithRetry(url, options), resolve, reject });
    next();
  });
}

const throttledFetch = createThrottledFetcher();

/**
 * Fetches IMDB rating data via CORS proxy
 */
async function fetchImdbRatings(imdbLink: string | null) {
  if (!imdbLink) return { imdbScore: 0, imdbTotal: 0 };

  try {
    const ratingsUrl = imdbLink.replace('maindetails', 'ratings');
    const corsProxy = 'https://vercel-cors-proxy-nine.vercel.app/api?url=';
    const response = await fetchWithRetry(corsProxy + encodeURIComponent(ratingsUrl), {});
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const nextData = doc.querySelector('script#__NEXT_DATA__');

    if (nextData?.textContent) {
      const data = JSON.parse(nextData.textContent);
      const histogram = data?.props?.pageProps?.contentData?.histogramData;
      if (histogram?.histogramValues) {
        const sorted = histogram.histogramValues.sort((a: any, b: any) => a.rating - b.rating);
        const counts = sorted.map((r: any) => r?.voteCount || 0);
        return {
          imdbScore: counts[8] + counts[9] - counts[0] - counts[1],
          imdbTotal: histogram.totalVoteCount || 0,
        };
      }
    }
  } catch (e: any) {
    debug('IMDB fetch failed:', e.message);
  }
  return { imdbScore: 0, imdbTotal: 0 };
}

/**
 * Fetches letterboxd page + stats histogram in parallel
 */
async function getFilmBasicData(slug: string) {
  const filmUrl = `https://letterboxd.com/film/${slug}/`;
  const statsUrl = `https://letterboxd.com/csi/film/${slug}/rating-histogram/`;

  const [pageResponse, statsResponse] = await Promise.all([
    throttledFetch(filmUrl),
    throttledFetch(statsUrl, { credentials: 'include', headers: { 'Referer': filmUrl } }).catch(() => null),
  ]);

  const html = await pageResponse.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const runtime = extractRuntime(doc);
  const year = extractYear(doc);
  const filmName = doc.querySelector('h1.headline-1')?.textContent?.trim() || slug;
  const imdbLink = doc.querySelector('a[href*="imdb.com/title"]')?.getAttribute('href') || null;

  let ratings: number[] = [];
  if (statsResponse) {
    const statsDoc = new DOMParser().parseFromString(await statsResponse.text(), 'text/html');
    ratings = parseRatings(statsDoc);
  }
  if (!ratings.length) ratings = parseRatings(doc);

  debug(`${slug}: runtime=${runtime}, year=${year}, ratings=${ratings.join(',') || 'none'}`);
  return { runtime, year, filmName, imdbLink, ratings };
}

// =============================================================================
// Score Calculation
// =============================================================================

/**
 * Calculates combined score from Letterboxd and IMDB ratings
 */
function calculateCombinedScore(lbRatings: number[], imdbScore = 0, imdbTotal = 0) {
  if (!lbRatings?.length) return { score: 0, ratio: 0 };

  const lbAbsolute = lbRatings[9] + lbRatings[8] - lbRatings[0] - lbRatings[1];
  const lbTotal = lbRatings.reduce((a, b) => a + b, 0);

  const totalScore = lbAbsolute + imdbScore;
  const totalRatings = lbTotal + imdbTotal;
  const ratio = totalRatings > 0 ? totalScore / totalRatings : 0;
  const score = Math.round(totalScore * ratio);

  return { score, ratio };
}

/**
 * Tallies ratings from review page for recent reviews calculation
 */
function tallyRatings(doc: Document, recentRatings: { totalNumberOfRatings: number; scoreAbsolute: number; scorePercentage: number }) {
  doc.querySelectorAll('svg.-rating[aria-label]').forEach((svg) => {
    const label = svg.getAttribute('aria-label')!;
    const value = (label.match(/★/g) || []).length * 2 + (label.includes('½') ? 1 : 0);
    if (value > 0) {
      recentRatings.totalNumberOfRatings += 1;
      if (value > 8) recentRatings.scoreAbsolute += 1;
      if (value <= 2) recentRatings.scoreAbsolute -= 1;
    }
  });
  return recentRatings;
}

/**
 * Fetches and calculates recent ratings summary
 */
async function getRecentRatingsSummary(slug: string | null = null) {
  const effectiveSlug = slug || extractSlugFromUrl(window.location.href);
  if (!effectiveSlug) return { totalNumberOfRatings: 0, scoreAbsolute: 0, scorePercentage: 0 };

  const cached = getCachedRecentRatings(effectiveSlug);
  if (cached) return cached;

  const baseUrl = `https://letterboxd.com/film/${effectiveSlug}/`;
  const recentRatings = { totalNumberOfRatings: 0, scoreAbsolute: 0, scorePercentage: 0 };
  const parser = new DOMParser();

  const pages = await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      throttledFetch(`${baseUrl}reviews/by/added/page/${i + 1}/`, { credentials: 'include' }).then((r) => r.text())
    )
  );

  pages.forEach((html) => tallyRatings(parser.parseFromString(html, 'text/html'), recentRatings));

  recentRatings.scorePercentage = recentRatings.totalNumberOfRatings > 0
    ? Math.round((recentRatings.scoreAbsolute / recentRatings.totalNumberOfRatings) * 100)
    : 0;

  setCachedRecentRatings(effectiveSlug, recentRatings);
  return recentRatings;
}

// =============================================================================
// Similar Picks
// =============================================================================

/** Updates progress indicator UI */
function updateProgress(element: HTMLElement, step: number, detail = '') {
  const steps = ['Finding lists', 'Loading list', 'Fetching films', 'Scoring matches'];
  const progress = el('div', 'lbx-progress');
  const dots = el('div', 'lbx-progress-dots');

  steps.forEach((_, i) => {
    const dot = el('span', `lbx-dot lbx-dot-${i < step ? 'done' : i === step ? 'active' : 'pending'}`);
    dots.append(dot);
  });

  progress.append(dots, document.createTextNode(detail || steps[step] + '...'));
  element.textContent = '';
  element.append(progress);
}

/**
 * Finds similar films from popular lists with matching runtime and score
 */
async function findSimilarPicks(currentSlug: string, scorePromise: Promise<{ score: number; ratio: number }>, currentRuntime: number, statusElement: HTMLElement) {
  // Set filmFilter cookie based on whether current film is watched
  const productionUid = document.querySelector('#backdrop[data-production-uid]')?.getAttribute('data-production-uid');
  const isWatched = await (async () => {
    if (!productionUid) return false;
    try {
      const res = await fetch('/ajax/letterboxd-metadata/', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `productions=${encodeURIComponent(productionUid)}`,
      });
      const meta = await res.json();
      debug('Metadata response:', meta);
      return meta.watched?.includes(productionUid) ?? false;
    } catch (e: any) {
      debug('Failed to fetch metadata:', e.message);
      return false;
    }
  })();
  if (isWatched) {
    // Delete any lingering hide-watched cookie so list fetches use default behavior
    document.cookie = `filmFilter=; path=/; domain=.letterboxd.com; max-age=0`;
  } else {
    document.cookie = `filmFilter=hide-watched; path=/; domain=.letterboxd.com`;
  }
  debug(`Film ${isWatched ? 'is' : 'is not'} watched (uid=${productionUid}), filmFilter=${isWatched ? 'cleared' : 'hide-watched'}`);

  const cached = getCachedSimilarPicks(currentSlug);
  if (cached && cached.listLink) {
    // Re-fetch list with cookies to exclude newly watched films
    const listUrl = `https://letterboxd.com${cached.listLink}by/rating/`;
    debug('Re-validating cached similar picks from', listUrl);
    const res = await throttledFetch(listUrl, { credentials: 'include' });
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const visibleSlugs: string[] = [];
    for (const el of Array.from(doc.querySelectorAll('[data-item-slug], a[href^="/film/"]'))) {
      const slug = el.getAttribute('data-item-slug') || el.getAttribute('href')?.match(/\/film\/([^/]+)\//)?.[1];
      if (slug) visibleSlugs.push(slug);
    }
    const visible = new Set(visibleSlugs);
    const posteritems = doc.querySelectorAll('li.posteritem').length;
    if (posteritems > 0 && visible.size === 0) {
      console.warn(`[LBX] Selector mismatch on cached list re-validation: ${posteritems} posteritems but 0 slugs — skipping filter`);
      return { ...cached, stats: cached.stats ? { ...cached.stats, fromCache: true } : undefined };
    }
    debug(`List has ${visible.size} visible films, cache has ${cached.films.length}`);
    const films = cached.films.filter((f: any) => visible.has(f.slug));
    const removed = cached.films.length - films.length;
    if (removed) {
      debug(`Filtered out ${removed} watched films:`, cached.films.filter((f: any) => !visible.has(f.slug)).map((f: any) => f.name));
      setCachedSimilarPicks(currentSlug, { ...cached, films });
    }
    return { ...cached, films, stats: cached.stats ? { ...cached.stats, fromCache: true, cachedFilmsRemaining: films.length, cachedFilmsRemoved: removed } : undefined };
  }

  try {
    updateProgress(statusElement, 0);
    const listsUrl = `https://letterboxd.com/film/${currentSlug}/lists/by/popular/`;
    const listsResponse = await throttledFetch(listsUrl, { credentials: 'include' });
    const listsDoc = new DOMParser().parseFromString(await listsResponse.text(), 'text/html');

    const firstList = listsDoc.querySelector('article.list-summary');
    if (!firstList) return { films: [], listName: null, listLink: null };

    const listLink = firstList.querySelector('h2.name a')?.getAttribute('href');
    if (!listLink) return { films: [], listName: null, listLink: null };

    const listName = firstList.querySelector('h2.name a')?.textContent?.trim() || 'Unknown List';

    // Paginate until we find the page containing the current film (sorted by rating).
    // Collects all films on the same page or higher — films after it on the same page are included.
    const listBaseUrl = `https://letterboxd.com${listLink}by/rating/`;
    const allFilmSlugs: { slug: string; link: string }[] = [];
    let foundCurrentFilm = false;
    let foundOnPage = 0;
    let pagesSearched = 0;
    let lastPageItemCount = 0;

    for (let page = 1; page <= CONFIG.MAX_SIMILAR_PAGES; page++) {
      const pageUrl = page === 1 ? listBaseUrl : `${listBaseUrl}page/${page}/`;
      updateProgress(statusElement, 1, `Loading "${listName}"${page > 1 ? ` (page ${page})` : ''}...`);
      const listResponse = await throttledFetch(pageUrl, { credentials: 'include' });
      const listDoc = new DOMParser().parseFromString(await listResponse.text(), 'text/html');

      pagesSearched = page;
      const pageItems = Array.from(listDoc.querySelectorAll('li.posteritem'));
      lastPageItemCount = pageItems.length;
      if (!pageItems.length) break;

      const pageSlugs: { slug: string; link: string }[] = [];
      for (const item of pageItems) {
        const div = item.querySelector('[data-item-slug], [data-item-link], a[href^="/film/"]') as HTMLElement | null;
        if (!div) continue;
        const link = div.getAttribute('data-item-link') || div.getAttribute('href') || '';
        const slug = div.getAttribute('data-item-slug') || link.match(/\/film\/([^/]+)\//)?.[1] || '';
        if (!slug) continue;
        if (slug === currentSlug) { foundCurrentFilm = true; foundOnPage = page; continue; }
        pageSlugs.push({ slug, link });
      }

      allFilmSlugs.push(...pageSlugs);
      debug(`Page ${page}: ${pageSlugs.length} films (${pageItems.length} posteritems)${foundCurrentFilm ? ' (current film found)' : ''}`);
      if (pageItems.length > 0 && pageSlugs.length === 0 && !foundCurrentFilm) {
        console.warn(`[LBX] Selector mismatch: ${pageItems.length} posteritems on page ${page} but 0 slugs extracted — Letterboxd markup may have changed`);
      }

      if (foundCurrentFilm) break;
    }

    if (!allFilmSlugs.length) return { films: [], listName, listLink, stats: { totalInList: 0, runtimeMatched: 0, scored: 0, currentScore: (await scorePromise).score, currentRuntime, foundOnPage, pagesSearched, lastPageItemCount, allScored: [] } };

    debug(`Total films across pages: ${allFilmSlugs.length}`);
    updateProgress(statusElement, 2, `Fetching ${allFilmSlugs.length} films...`);

    const allBasicData = await Promise.all(
      allFilmSlugs.map(async ({ slug, link }) => {
        try {
          const cached = getCachedFilmData(slug);
          if (cached) return { slug, link, ...cached, fromCache: true };
          const basic = await getFilmBasicData(slug);
          return { slug, link, ...basic, fromCache: false };
        } catch (e: any) {
          debug(`Failed to fetch ${slug}: ${e.message}, keeping as fetchFailed`);
          return { slug, link, runtime: currentRuntime, year: null, filmName: slug, imdbLink: null, ratings: [], fromCache: false, fetchFailed: true };
        }
      })
    );

    allBasicData.forEach((f: any) => {
      if (!f.fromCache && !f.fetchFailed && f.runtime) {
        setCachedFilmData(f.slug, { score: 0, ratio: 0, scored: false, runtime: f.runtime, year: f.year, filmName: f.filmName });
      }
    });

    // Allow any shorter film + up to TOLERANCE mins longer (no lower bound — a 90m film can beat a 200m one)
    const runtimeMatches = allBasicData.filter(
      (f: any) => f.runtime && f.runtime <= currentRuntime + CONFIG.RUNTIME_TOLERANCE
    );

    debug(`Runtime matches (≤${currentRuntime + CONFIG.RUNTIME_TOLERANCE}m): ${runtimeMatches.length}`);
    if (!runtimeMatches.length) return { films: [], listName, listLink, stats: { totalInList: allFilmSlugs.length, runtimeMatched: 0, scored: 0, currentScore: (await scorePromise).score, currentRuntime, foundOnPage, pagesSearched, allScored: [] } };

    const uncached = runtimeMatches.filter((f: any) => !f.fromCache).length;
    updateProgress(statusElement, 3, `Scoring ${runtimeMatches.length} matches${uncached ? ` (${uncached} new)` : ''}...`);

    const scoredFilms = await Promise.all(
      runtimeMatches.map(async (film: any) => {
        if (film.fromCache && film.scored !== false) return film;
        if (film.fetchFailed) return { ...film, score: 0, ratio: 0 };

        const { imdbScore, imdbTotal } = await fetchImdbRatings(film.imdbLink);
        const { score, ratio } = calculateCombinedScore(film.ratings, imdbScore, imdbTotal);

        setCachedFilmData(film.slug, { score, ratio, scored: true, runtime: film.runtime, year: film.year, filmName: film.filmName });
        return { ...film, score, ratio };
      })
    );

    const currentScore = (await scorePromise).score;
    scoredFilms.sort((a: any, b: any) => b.score - a.score);
    const qualifying = scoredFilms
      .filter((f: any) => f.fetchFailed || f.score >= currentScore)
      .map((f: any) => ({ slug: f.slug, name: f.filmName, link: f.link, score: f.score, runtime: f.runtime, year: f.year, fetchFailed: f.fetchFailed }));
    const allScored = scoredFilms
      .map((f: any) => ({ name: f.filmName, score: f.score, runtime: f.runtime, fetchFailed: f.fetchFailed }));
    const stats = { totalInList: allFilmSlugs.length, runtimeMatched: runtimeMatches.length, scored: scoredFilms.length, currentScore, currentRuntime, foundOnPage, pagesSearched, allScored };

    debug(`Qualifying films: ${qualifying.length}`);
    const result = { films: qualifying, stats, listName, listLink };
    const cacheable = qualifying.filter((f: any) => !f.fetchFailed);
    if (cacheable.length) {
      setCachedSimilarPicks(currentSlug, { films: cacheable, listName, listLink, stats });
    }
    return result;
  } catch (error) {
    console.error('findSimilarPicks error:', error);
    return { films: [], listName: null, listLink: null, error: true };
  }
}

// =============================================================================
// UI Display
// =============================================================================

/**
 * Displays similar picks section, lazily fetching and filtering by recent %
 */
async function displaySimilarPicks(currentSlug: string, scorePromise: Promise<{ score: number; ratio: number }>, currentRuntime: number, trendingElement: HTMLElement, currentRecentPromise: Promise<any>) {
  const similarSection = el('section', 'lbx-similar');
  similarSection.append(el('span', 'lbx-progress', 'Finding similar picks...'));
  trendingElement.after(similarSection);

  const result = await findSimilarPicks(currentSlug, scorePromise, currentRuntime, similarSection);

  similarSection.textContent = '';

  if (result.films.length === 0) {
    if (result.error) {
      similarSection.remove();
      return;
    }
    await currentRecentPromise;
    similarSection.append(winnerBanner('★ Winner! No similar film with equal or higher score found.', result.listName, result.listLink));
    if (result.stats) similarSection.append(debugDetails(result.stats));
    return;
  }

  similarSection.append(el('h3', 'lbx-similar-header', 'Similar Picks'));

  const sourceLink = el('a', 'lbx-similar-source', `From: ${result.listName}`) as HTMLAnchorElement;
  sourceLink.href = result.listLink;
  similarSection.append(sourceLink);

  const list = el('ul', 'lbx-similar-list');
  const items = new Map<string, { element: HTMLElement; meta: HTMLElement; film: any }>();

  result.films.forEach((film: any) => {
    const item = el('li', 'lbx-similar-item');
    const link = el('a', 'lbx-similar-link', film.name) as HTMLAnchorElement;
    link.href = film.link;
    const meta = el('span', 'lbx-similar-meta', filmMeta(film));
    item.append(link, meta);
    list.append(item);
    items.set(film.slug, { element: item, meta, film });
  });
  similarSection.append(list);

  const recentPromises = result.films.map((film: any) =>
    getRecentRatingsSummary(film.slug)
      .then((recent: any) => ({ slug: film.slug, recent }))
      .catch(() => ({ slug: film.slug, recent: null }))
  );

  const currentRecent = await currentRecentPromise;
  const threshold = currentRecent.scorePercentage;

  let passCount = 0;
  await Promise.all(
    recentPromises.map((p: any) =>
      p.then(({ slug, recent }: { slug: string; recent: any }) => {
        const entry = items.get(slug);
        if (!entry) return;
        const { film } = entry;
        if (film.fetchFailed || (recent && recent.scorePercentage >= threshold)) {
          entry.meta.textContent = filmMeta(film, recent ? `${recent.scorePercentage}%` : '?');
          passCount++;
        } else {
          entry.element.classList.add('lbx-excluded');
          entry.meta.textContent = filmMeta(film, recent ? `${recent.scorePercentage}%` : '?');
          const reason = el('span', 'lbx-similar-reason', `need ≥${threshold}%`);
          entry.element.append(reason);
        }
      })
    )
  );

  if (passCount === 0) {
    similarSection.textContent = '';
    similarSection.append(winnerBanner('★ Winner! No similar film matches score and recent reviews.', result.listName, result.listLink));
    const excludedList = el('ul', 'lbx-similar-list');
    for (const [, entry] of items) {
      entry.element.classList.add('lbx-excluded');
      excludedList.append(entry.element);
    }
    similarSection.append(excludedList);
  }
  if (result.stats) similarSection.append(debugDetails({ ...result.stats, recentThreshold: threshold }));
}

// =============================================================================
// Main
// =============================================================================

/**
 * Main entry point - orchestrates score calculation and display
 */
async function run(ratings: number[]) {
  injectStyles();

  const currentSlug = extractSlugFromUrl(window.location.href);
  const currentRuntime = extractRuntime(document);
  const currentYear = extractYear(document);
  const currentFilmName = document.querySelector('h1.headline-1')?.textContent?.trim() || currentSlug;

  const cachedFilmRaw = currentSlug ? getCachedFilmData(currentSlug) : null;
  const cachedFilm = cachedFilmRaw?.score > 0 ? cachedFilmRaw : null;
  const recentRatingsRaw = getRecentRatingsSummary().catch(() => ({ totalNumberOfRatings: 0, scoreAbsolute: 0, scorePercentage: 0 }));

  const avgRating = document.querySelector('.ratings-histogram-chart .average-rating, .ratings-histogram-chart .averagerating');
  const reviewSection = document.querySelector('.review.body-text');
  if (!avgRating?.parentElement || !reviewSection) return;

  const histogramContainer = avgRating.closest('.rating-histogram');
  const scoreClass = histogramContainer ? 'lbx-score -new' : 'lbx-score';
  const mountScore = (scoreEl: HTMLElement) => {
    if (histogramContainer) histogramContainer.before(scoreEl);
    else avgRating.parentElement!.insertBefore(scoreEl, avgRating);
  };
  const renderScore = (scoreEl: HTMLElement, score: number, ratio: number) => {
    const val = addCommas(score);
    const pct = `${Math.round(ratio * 100)}%`;
    if (histogramContainer) {
      scoreEl.textContent = val;
      scoreEl.append(el('span', 'lbx-pct', `· ${pct}`));
    } else {
      scoreEl.textContent = `${val} (${pct})`;
    }
  };

  const trendingElement = el('div', 'lbx-trending', 'Calculating...');
  reviewSection.after(trendingElement);

  let scorePromise: Promise<{ score: number; ratio: number }>;
  if (cachedFilm) {
    const scoreElement = el('span', scoreClass);
    renderScore(scoreElement, cachedFilm.score, cachedFilm.ratio);
    mountScore(scoreElement);
    scorePromise = Promise.resolve({ score: cachedFilm.score, ratio: cachedFilm.ratio });
  } else {
    const scoreElement = el('span', scoreClass, 'Calculating...');
    mountScore(scoreElement);
    scorePromise = fetchImdbRatings(document.querySelector('a[href*="imdb.com/title"]')?.getAttribute('href') || null)
      .then(({ imdbScore, imdbTotal }) => {
        const { score, ratio } = calculateCombinedScore(ratings, imdbScore, imdbTotal);
        renderScore(scoreElement, score, ratio);
        if (currentSlug && currentRuntime) {
          setCachedFilmData(currentSlug, { score, ratio, scored: true, runtime: currentRuntime, year: currentYear, filmName: currentFilmName });
        }
        return { score, ratio };
      });
  }

  const recentRatingsPromise = Promise.all([scorePromise, recentRatingsRaw]).then(([{ score }, recentRatings]) => {
    const trendingScore = Math.round((score * recentRatings.scorePercentage) / 100);
    trendingElement.textContent = `Trending: ${addCommas(trendingScore)} · Recent: ${recentRatings.scorePercentage}%`;
    return recentRatings;
  });

  const similarPicksPromise = currentSlug && currentRuntime
    ? displaySimilarPicks(currentSlug, scorePromise, currentRuntime, trendingElement, recentRatingsPromise)
    : Promise.resolve();

  await Promise.all([recentRatingsPromise, similarPicksPromise]);
}

// =============================================================================
// Observer
// =============================================================================

let observer: MutationObserver | null = null;

function initObserver() {
  if (observer) observer.disconnect();

  const tryRun = async () => {
    const ratings = parseRatings(document);
    if (!ratings.length) return false;
    observer?.disconnect();
    try {
      await run(ratings);
    } catch (error) {
      console.error('LBX Extension error:', error);
    }
    return true;
  };

  observer = new MutationObserver(() => { tryRun(); });
  observer.observe(document.body, { childList: true, subtree: true });
  tryRun();
}

initObserver();
