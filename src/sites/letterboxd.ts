import { cacheGet, cacheSet } from '../shared/cache';
import { addCommas } from '../shared/utils';

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

/** Creates a DOM element with optional class and text */
function el(tag: string, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

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

function filmMeta(film: any, recentText = '...') {
  const scoreText = film.fetchFailed ? '?' : addCommas(film.score);
  return `${film.year ? film.year + ' · ' : ''}${film.runtime}m · ${scoreText} · ${recentText}`;
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
    const ratingBars = statsDoc.querySelectorAll('.rating-histogram-bar');
    if (ratingBars.length) {
      ratings = Array.from(ratingBars).map((el) => parseInt(el.textContent!.replace(/,/g, '').split('&')[0]) || 0);
    }
  }

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
  const cached = getCachedSimilarPicks(currentSlug);
  if (cached && cached.listLink) {
    // Re-fetch list with cookies to exclude newly watched films
    const listUrl = `https://letterboxd.com${cached.listLink}by/rating/`;
    debug('Re-validating cached similar picks from', listUrl);
    const res = await throttledFetch(listUrl, { credentials: 'include' });
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const visible = new Set(
      Array.from(doc.querySelectorAll('[data-item-slug]')).map(el => el.getAttribute('data-item-slug'))
    );
    debug(`List has ${visible.size} visible films, cache has ${cached.films.length}`);
    const films = cached.films.filter((f: any) => visible.has(f.slug));
    const removed = cached.films.length - films.length;
    if (removed) {
      debug(`Filtered out ${removed} watched films:`, cached.films.filter((f: any) => !visible.has(f.slug)).map((f: any) => f.name));
      setCachedSimilarPicks(currentSlug, { ...cached, films });
    }
    return { ...cached, films };
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

    // Paginate until we find the page containing the current film (sorted by rating,
    // so all films before it are rated higher) or hit the max page limit.
    const listBaseUrl = `https://letterboxd.com${listLink}by/rating/`;
    const allFilmSlugs: { slug: string; link: string }[] = [];
    let foundCurrentFilm = false;

    for (let page = 1; page <= CONFIG.MAX_SIMILAR_PAGES; page++) {
      const pageUrl = page === 1 ? listBaseUrl : `${listBaseUrl}page/${page}/`;
      updateProgress(statusElement, 1, `Loading "${listName}"${page > 1 ? ` (page ${page})` : ''}...`);
      const listResponse = await throttledFetch(pageUrl, { credentials: 'include' });
      const listDoc = new DOMParser().parseFromString(await listResponse.text(), 'text/html');

      const pageItems = Array.from(listDoc.querySelectorAll('li.posteritem'));
      if (!pageItems.length) break;

      // Check if current film is on this page
      const slugsOnPage = pageItems.map(item => item.querySelector('[data-film-id]')?.getAttribute('data-item-slug'));
      if (slugsOnPage.includes(currentSlug)) foundCurrentFilm = true;

      const pageSlugs = pageItems
        .map((item) => {
          const div = item.querySelector('[data-film-id]');
          return div ? { slug: div.getAttribute('data-item-slug')!, link: div.getAttribute('data-item-link')! } : null;
        })
        .filter((f): f is { slug: string; link: string } => f?.slug != null && f.slug !== currentSlug);

      allFilmSlugs.push(...pageSlugs);
      debug(`Page ${page}: ${pageSlugs.length} films${foundCurrentFilm ? ' (current film found)' : ''}`);

      if (foundCurrentFilm) break;
    }

    if (!allFilmSlugs.length) return { films: [], listName, listLink };

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

    const runtimeMatches = allBasicData.filter(
      (f: any) => f.runtime && Math.abs(f.runtime - currentRuntime) <= CONFIG.RUNTIME_TOLERANCE
    );

    debug(`Runtime matches (±${CONFIG.RUNTIME_TOLERANCE}min): ${runtimeMatches.length}`);
    if (!runtimeMatches.length) return { films: [], listName, listLink };

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
    const qualifying = scoredFilms
      .filter((f: any) => f.fetchFailed || f.score >= currentScore)
      .sort((a: any, b: any) => b.score - a.score)
      .map((f: any) => ({ slug: f.slug, name: f.filmName, link: f.link, score: f.score, runtime: f.runtime, year: f.year, fetchFailed: f.fetchFailed }));

    debug(`Qualifying films: ${qualifying.length}`);
    const result = { films: qualifying, listName, listLink };
    const cacheable = qualifying.filter((f: any) => !f.fetchFailed);
    if (cacheable.length) {
      setCachedSimilarPicks(currentSlug, { films: cacheable, listName, listLink });
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

  await Promise.all(
    recentPromises.map((p: any) =>
      p.then(({ slug, recent }: { slug: string; recent: any }) => {
        const entry = items.get(slug);
        if (!entry) return;
        const { film } = entry;
        if (film.fetchFailed || (recent && recent.scorePercentage >= threshold)) {
          entry.meta.textContent = filmMeta(film, recent ? `${recent.scorePercentage}%` : '?');
        } else {
          entry.element.remove();
          items.delete(slug);
        }
      })
    )
  );

  if (items.size === 0) {
    similarSection.textContent = '';
    similarSection.append(winnerBanner('★ Winner! No similar film matches score and recent reviews.', result.listName, result.listLink));
  }
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

  const cachedFilm = currentSlug ? getCachedFilmData(currentSlug) : null;
  const recentRatingsRaw = getRecentRatingsSummary().catch(() => ({ totalNumberOfRatings: 0, scoreAbsolute: 0, scorePercentage: 0 }));

  const avgRating = document.querySelector('.ratings-histogram-chart .average-rating');
  const reviewSection = document.querySelector('.review.body-text');
  if (!avgRating?.parentElement || !reviewSection) return;

  const trendingElement = el('div', 'lbx-trending', 'Calculating...');
  reviewSection.after(trendingElement);

  let scorePromise: Promise<{ score: number; ratio: number }>;
  if (cachedFilm) {
    const scoreElement = el('span', 'lbx-score', `${addCommas(cachedFilm.score)} (${Math.round(cachedFilm.ratio * 100)}%)`);
    avgRating.parentElement.insertBefore(scoreElement, avgRating);
    scorePromise = Promise.resolve({ score: cachedFilm.score, ratio: cachedFilm.ratio });
  } else {
    const scoreElement = el('span', 'lbx-score', 'Calculating...');
    avgRating.parentElement.insertBefore(scoreElement, avgRating);
    scorePromise = fetchImdbRatings(document.querySelector('a[href*="imdb.com/title"]')?.getAttribute('href') || null)
      .then(({ imdbScore, imdbTotal }) => {
        const { score, ratio } = calculateCombinedScore(ratings, imdbScore, imdbTotal);
        scoreElement.textContent = `${addCommas(score)} (${Math.round(ratio * 100)}%)`;
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

  observer = new MutationObserver(async (mutations) => {
    for (const mutation of mutations) {
      if (!mutation.addedNodes) continue;

      const ratingNodes = document.getElementsByClassName('rating-histogram-bar');
      if (ratingNodes.length) {
        observer!.disconnect();
        const ratings = Array.from(ratingNodes).map(
          (el) => parseInt(el.textContent!.replace(/,/g, '').split('&')[0]) || 0
        );
        try {
          await run(ratings);
        } catch (error) {
          console.error('LBX Extension error:', error);
        }
        break;
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

initObserver();
