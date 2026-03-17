import { addCommas } from '../shared/utils';

// =============================================================================
// Configuration
// =============================================================================
const CONFIG = {
  CACHE_EXPIRY_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  RECENT_RATINGS_CACHE_MS: 24 * 60 * 60 * 1000, // 1 day
  SIMILAR_PICKS_CACHE_MS: 7 * 24 * 60 * 60 * 1000, // 1 week
  RUNTIME_TOLERANCE: 10, // ±10 minutes
  MAX_CONCURRENCY: 10,
  DEBUG: false,
};

// =============================================================================
// Styles (injected once)
// =============================================================================
const STYLES = `
  .lbx-score { margin-top: 0.5rem; }
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
    align-items: center;
    gap: .5rem;
    color: #00e054;
    font-weight: 600;
  }
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

// =============================================================================
// Cache
// =============================================================================

function getCache(prefix: string, ttl: number, slug: string) {
  try {
    const raw = localStorage.getItem(`lbx_${prefix}_${slug}`);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > ttl) {
      localStorage.removeItem(`lbx_${prefix}_${slug}`);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function setCache(prefix: string, slug: string, data: any) {
  try {
    localStorage.setItem(`lbx_${prefix}_${slug}`, JSON.stringify({ data, timestamp: Date.now() }));
  } catch {}
}

const getCachedFilmData = (slug: string) => getCache('film', CONFIG.CACHE_EXPIRY_MS, slug);
const setCachedFilmData = (slug: string, data: any) => setCache('film', slug, data);
const getCachedRecentRatings = (slug: string) => getCache('recent', CONFIG.RECENT_RATINGS_CACHE_MS, slug);
const setCachedRecentRatings = (slug: string, data: any) => setCache('recent', slug, data);
const getCachedSimilarPicks = (slug: string) => getCache('similar', CONFIG.SIMILAR_PICKS_CACHE_MS, slug);
const setCachedSimilarPicks = (slug: string, data: any) => setCache('similar', slug, data);

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
    throttledFetch(statsUrl, { credentials: 'include' }),
  ]);

  const [html, statsHtml] = await Promise.all([pageResponse.text(), statsResponse.text()]);

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const runtime = extractRuntime(doc);
  const year = extractYear(doc);
  const filmName = doc.querySelector('h1.headline-1')?.textContent?.trim() || slug;
  const imdbLink = doc.querySelector('a[href*="imdb.com/title"]')?.getAttribute('href') || null;

  const statsDoc = new DOMParser().parseFromString(statsHtml, 'text/html');
  const ratingBars = statsDoc.querySelectorAll('.rating-histogram-bar');
  const ratings = ratingBars.length
    ? Array.from(ratingBars).map((el) => parseInt(el.textContent!.replace(/,/g, '').split('&')[0]) || 0)
    : [];

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

  if (recentRatings.totalNumberOfRatings > 0) setCachedRecentRatings(effectiveSlug, recentRatings);
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
  if (cached) return cached;

  try {
    // Step 1: Fetch popular lists
    updateProgress(statusElement, 0);
    const listsUrl = `https://letterboxd.com/film/${currentSlug}/lists/by/popular/`;
    const listsResponse = await throttledFetch(listsUrl, { credentials: 'include' });
    const listsDoc = new DOMParser().parseFromString(await listsResponse.text(), 'text/html');

    const firstList = listsDoc.querySelector('article.list-summary');
    if (!firstList) return { films: [], listName: null, listLink: null };

    const listLink = firstList.querySelector('h2.name a')?.getAttribute('href');
    if (!listLink) return { films: [], listName: null, listLink: null };

    const listName = firstList.querySelector('h2.name a')?.textContent?.trim() || 'Unknown List';

    // Step 2: Fetch list sorted by rating
    updateProgress(statusElement, 1, `Loading "${listName}"...`);
    const listByRatingUrl = `https://letterboxd.com${listLink}by/rating/`;
    const listResponse = await throttledFetch(listByRatingUrl, { credentials: 'include' });
    const listDoc = new DOMParser().parseFromString(await listResponse.text(), 'text/html');

    const filmSlugs = Array.from(listDoc.querySelectorAll('li.posteritem'))
      .map((item) => {
        const div = item.querySelector('[data-film-id]');
        return div ? { slug: div.getAttribute('data-item-slug')!, link: div.getAttribute('data-item-link')! } : null;
      })
      .filter((f): f is { slug: string; link: string } => f?.slug != null && f.slug !== currentSlug);

    if (!filmSlugs.length) return { films: [], listName, listLink };

    debug(`Found ${filmSlugs.length} films in "${listName}"`);

    // Step 3: Fetch all film data in parallel
    updateProgress(statusElement, 2, `Fetching ${filmSlugs.length} films...`);

    const allBasicData = await Promise.all(
      filmSlugs.map(async ({ slug, link }) => {
        const cached = getCachedFilmData(slug);
        if (cached) return { slug, link, ...cached, fromCache: true };
        const basic = await getFilmBasicData(slug);
        return { slug, link, ...basic, fromCache: false };
      })
    );

    // Filter by runtime
    const runtimeMatches = allBasicData.filter(
      (f: any) => f.runtime && Math.abs(f.runtime - currentRuntime) <= CONFIG.RUNTIME_TOLERANCE
    );

    debug(`Runtime matches (±${CONFIG.RUNTIME_TOLERANCE}min): ${runtimeMatches.length}`);
    if (!runtimeMatches.length) return { films: [], listName, listLink };

    // Step 4: Score all runtime matches
    const uncached = runtimeMatches.filter((f: any) => !f.fromCache).length;
    updateProgress(statusElement, 3, `Scoring ${runtimeMatches.length} matches${uncached ? ` (${uncached} new)` : ''}...`);

    const scoredFilms = await Promise.all(
      runtimeMatches.map(async (film: any) => {
        if (film.fromCache) return film;

        const { imdbScore, imdbTotal } = await fetchImdbRatings(film.imdbLink);
        const { score, ratio } = calculateCombinedScore(film.ratings, imdbScore, imdbTotal);

        if (score > 0) {
          setCachedFilmData(film.slug, { score, ratio, runtime: film.runtime, year: film.year, filmName: film.filmName });
        }
        return { ...film, score, ratio };
      })
    );

    // Filter by score, sorted descending
    const currentScore = (await scorePromise).score;
    const qualifying = scoredFilms
      .filter((f: any) => f.score >= currentScore)
      .sort((a: any, b: any) => b.score - a.score)
      .map((f: any) => ({ slug: f.slug, name: f.filmName, link: f.link, score: f.score, runtime: f.runtime, year: f.year }));

    debug(`Qualifying films: ${qualifying.length}`);
    const result = { films: qualifying, listName, listLink };
    if (qualifying.length) setCachedSimilarPicks(currentSlug, result);
    return result;
  } catch (error) {
    console.error('findSimilarPicks error:', error);
    return { films: [], listName: null, listLink: null };
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
    similarSection.append(el('div', 'lbx-winner', '★ Winner! No similar film with equal or higher score found.'));
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
    const meta = el('span', 'lbx-similar-meta',
      `${film.year ? film.year + ' · ' : ''}${film.runtime}m · ${addCommas(film.score)} · ...`);
    item.append(link, meta);
    list.append(item);
    items.set(film.slug, { element: item, meta, film });
  });
  similarSection.append(list);

  // Start all recent % fetches in parallel immediately
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
        if (recent && recent.scorePercentage >= threshold) {
          const { film } = entry;
          entry.meta.textContent =
            `${film.year ? film.year + ' · ' : ''}${film.runtime}m · ${addCommas(film.score)} · ${recent.scorePercentage}%`;
        } else {
          entry.element.remove();
          items.delete(slug);
        }
      })
    )
  );

  if (items.size === 0) {
    similarSection.textContent = '';
    similarSection.append(el('div', 'lbx-winner', '★ Winner! No similar film matches score and recent reviews.'));
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
  const recentRatingsRaw = getRecentRatingsSummary();

  const headline = document.querySelector('.ratings-histogram-chart h2 a');
  const trendingElement = el('div', 'lbx-trending', 'Calculating...');
  document.querySelector('.review.body-text')!.after(trendingElement);

  let scorePromise: Promise<{ score: number; ratio: number }>;
  if (cachedFilm) {
    const scoreElement = el('div', 'lbx-score', `${addCommas(cachedFilm.score)} (${Math.round(cachedFilm.ratio * 100)}%)`);
    headline!.after(scoreElement);
    scorePromise = Promise.resolve({ score: cachedFilm.score, ratio: cachedFilm.ratio });
  } else {
    const scoreElement = el('div', 'lbx-score', 'Calculating...');
    headline!.after(scoreElement);
    scorePromise = fetchImdbRatings(document.querySelector('a[href*="imdb.com/title"]')?.getAttribute('href') || null)
      .then(({ imdbScore, imdbTotal }) => {
        const { score, ratio } = calculateCombinedScore(ratings, imdbScore, imdbTotal);
        scoreElement.textContent = `${addCommas(score)} (${Math.round(ratio * 100)}%)`;
        if (currentSlug && currentRuntime) {
          setCachedFilmData(currentSlug, { score, ratio, runtime: currentRuntime, year: currentYear, filmName: currentFilmName });
        }
        return { score, ratio };
      });
  }

  // Trending resolves when both score + recent ratings complete
  const recentRatingsPromise = Promise.all([scorePromise, recentRatingsRaw]).then(([{ score }, recentRatings]) => {
    const trendingScore = Math.round((score * recentRatings.scorePercentage) / 100);
    trendingElement.textContent = `Trending: ${addCommas(trendingScore)} · Recent: ${recentRatings.scorePercentage}%`;
    return recentRatings;
  });

  // Similar picks starts immediately — only awaits score at the final filter step
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
