import { idbGet, idbSet } from '../shared/idb-cache';
import { buildMediaSummary } from '../shared/review-summary';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { addCommas, el } from '../shared/utils';

// =============================================================================
// Configuration
// =============================================================================
const CONFIG = {
  CACHE_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000, // 1 week
  RECENT_RATINGS_CACHE_MS: 12 * 60 * 60 * 1000, // 12 hours
  SIMILAR_PICKS_CACHE_MS: 7 * 24 * 60 * 60 * 1000, // 1 week
  SUMMARY_CACHE_MS: 7 * 24 * 60 * 60 * 1000, // 1 week
  RUNTIME_TOLERANCE: 10, // ±10 minutes
  MAX_SIMILAR_PAGES: 3,
  RECENT_RATING_PAGES: 15, // reviews/by/added pages tallied for the recent %
  RECENT_REVIEW_PAGES: 8, // reviews/by/added pages scanned for AI summary text
  MAX_CONCURRENCY: 10,
  DEBUG: false,
};

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

/** Parses 10 rating-bucket counts from .barcolumn bars (title= before tooltip init, data-original-title= after) */
function parseRatings(root: Document | Element): number[] {
  const barcolumns = root.querySelectorAll('.barcolumn[title], .barcolumn[data-original-title]');
  return Array.from(barcolumns).map((el) => {
    const attr = el.getAttribute('title') || el.getAttribute('data-original-title') || '';
    const match = attr.match(/([\d,]+)/);
    return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
  });
}

/** Recent %: net loved-minus-hated ratings over all rated recent reviews. */
const recentPct = (net: number, total: number) => (total > 0 ? Math.round((net / total) * 100) : 0);

/** Adjusted score: the combined score damped by the recent %. */
const adjustedScore = (score: number, pct: number) => Math.round((score * pct) / 100);

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
  if (stats.parseEmptyCount > 0) lines.push(`⚠ Histogram parse empty: ${stats.parseEmptyCount}/${stats.freshlyFetched} freshly fetched (CSI markup likely changed)`);
  if (stats.currentAdjusted != null) lines.push(`Adjusted threshold: ${addCommas(stats.currentAdjusted)}`);
  if (stats.allScored?.length) {
    lines.push('');
    lines.push('All runtime-matched films (✓ = score reaches the threshold, so recent reviews were checked):');
    for (const f of stats.allScored) {
      let status: string;
      if (f.fetchFailed) status = '(fetch failed)';
      else if (f.parseEmpty) status = '⚠ parse empty';
      else status = f.score >= stats.currentAdjusted ? '✓' : '✗';
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
  const winner = el('div', 'lbx-winner');
  winner.append(el('span', 'lbx-winner-text', message));
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

// Heavy per-film accumulators (one entry per candidate film during similar-picks)
// live in IndexedDB — they'd otherwise fill the ~5MB localStorage cap. The small
// summary cache stays on localStorage (owned by buildMediaSummary).
const getCachedFilmData = (slug: string) => idbGet(`lbx_film_v2_${slug}`, CONFIG.CACHE_EXPIRY_MS);
const setCachedFilmData = (slug: string, data: any) => idbSet(`lbx_film_v2_${slug}`, data);
const getCachedRecentRatings = (slug: string) => idbGet(`lbx_recent_${slug}`, CONFIG.RECENT_RATINGS_CACHE_MS);
const setCachedRecentRatings = (slug: string, data: any) => idbSet(`lbx_recent_${slug}`, data);
// A tally abandoned early by getCandidateRecentRatings — kept apart from the full
// one so the film's own page never mistakes a ceiling for its real recent %.
const getCachedRecentPartial = (slug: string) => idbGet(`lbx_recent_part_${slug}`, CONFIG.RECENT_RATINGS_CACHE_MS);
const setCachedRecentPartial = (slug: string, data: any) => idbSet(`lbx_recent_part_${slug}`, data);
// v3: holds every scored runtime match; the comparison against the current film
// happens at display time, so the cache no longer bakes in a threshold.
const getCachedSimilarPicks = (slug: string) => idbGet(`lbx_similar_v3_${slug}`, CONFIG.SIMILAR_PICKS_CACHE_MS);
const setCachedSimilarPicks = (slug: string, data: any) => idbSet(`lbx_similar_v3_${slug}`, data);

// Films the user has muted from Similar Picks. Deliberately not a cache — it's
// user intent, so it lives in chrome.storage.local: no TTL, survives clearing
// letterboxd site data, and untouched by the background rc_score_* sweep.
const IGNORED_KEY = 'lbx_ignored';

const loadIgnored = async (): Promise<Set<string>> => {
  try {
    const stored = (await chrome.storage.local.get(IGNORED_KEY))[IGNORED_KEY];
    return new Set<string>(Array.isArray(stored) ? stored : []);
  } catch { return new Set<string>(); }
};

const saveIgnored = (ignored: Set<string>) =>
  chrome.storage.local.set({ [IGNORED_KEY]: [...ignored] }).catch(() => {});

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

const throttledFetch = createThrottledFetcher(CONFIG.MAX_CONCURRENCY, fetchWithRetry);

/** Fetches one recent-reviews page (reviews/by/added) as HTML */
const fetchReviewPage = (slug: string, page: number) =>
  throttledFetch(`https://letterboxd.com/film/${slug}/reviews/by/added/page/${page}/`, { credentials: 'include' }).then((r) => r.text());

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
  let statsHtmlLen = 0;
  if (statsResponse) {
    const statsHtml = await statsResponse.text();
    statsHtmlLen = statsHtml.length;
    const statsDoc = new DOMParser().parseFromString(statsHtml, 'text/html');
    ratings = parseRatings(statsDoc);
  }
  if (!ratings.length) ratings = parseRatings(doc);

  const parseEmpty = ratings.length === 0 && statsHtmlLen > 500;

  debug(`${slug}: runtime=${runtime}, year=${year}, ratings=${ratings.join(',') || 'none'}`);
  return { runtime, year, filmName, imdbLink, ratings, parseEmpty };
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

  const cached = await getCachedRecentRatings(effectiveSlug);
  if (cached) return cached;

  const recentRatings = { totalNumberOfRatings: 0, scoreAbsolute: 0, scorePercentage: 0 };
  const parser = new DOMParser();

  const pages = await Promise.all(
    Array.from({ length: CONFIG.RECENT_RATING_PAGES }, (_, i) => fetchReviewPage(effectiveSlug, i + 1))
  );

  pages.forEach((html) => tallyRatings(parser.parseFromString(html, 'text/html'), recentRatings));

  recentRatings.scorePercentage = recentPct(recentRatings.scoreAbsolute, recentRatings.totalNumberOfRatings);

  setCachedRecentRatings(effectiveSlug, recentRatings);
  return recentRatings;
}

/**
 * Recent ratings for a similar-pick candidate, fetched a page at a time and
 * abandoned once even a perfect run of 5★s on the unfetched pages couldn't lift
 * `score` × recent % to `threshold`. Verdicts match a full fetch exactly; a
 * hopeless film just reports a ceiling instead of its number. Only complete
 * tallies enter the shared recent cache; an abandoned one is kept apart so a
 * revisit can re-check it against the threshold without refetching.
 */
async function getCandidateRecentRatings(slug: string, score: number, threshold: number): Promise<{ pct: number; ceiling: boolean }> {
  const full = await getCachedRecentRatings(slug);
  if (full) return { pct: full.scorePercentage, ceiling: false };

  // `room` = the most ratings the unfetched pages could still add, all of them 5★.
  const hopeless = (tally: { scoreAbsolute: number; totalNumberOfRatings: number }, room: number) => {
    const ceiling = recentPct(tally.scoreAbsolute + room, tally.totalNumberOfRatings + room);
    return adjustedScore(score, ceiling) < threshold ? { pct: ceiling, ceiling: true } : null;
  };
  const partial = await getCachedRecentPartial(slug);
  const known = partial && hopeless(partial, partial.room);
  if (known) return known;

  const parser = new DOMParser();
  const tally = { totalNumberOfRatings: 0, scoreAbsolute: 0, scorePercentage: 0 };
  let perPage = 0;
  for (let page = 1; page <= CONFIG.RECENT_RATING_PAGES; page++) {
    const doc = parser.parseFromString(await fetchReviewPage(slug, page), 'text/html');
    tallyRatings(doc, tally);
    const entries = doc.querySelectorAll('.js-review-body').length;
    if (page === 1) perPage = entries;
    if (!perPage) continue; // unrecognised markup: no bound, fetch every page as before
    if (entries < perPage) break; // a short page is the last one, so the tally is already exact
    const room = perPage * (CONFIG.RECENT_RATING_PAGES - page);
    const verdict = room && hopeless(tally, room);
    if (verdict) {
      setCachedRecentPartial(slug, { ...tally, room });
      return verdict;
    }
  }
  tally.scorePercentage = recentPct(tally.scoreAbsolute, tally.totalNumberOfRatings);
  setCachedRecentRatings(slug, tally);
  return { pct: tally.scorePercentage, ceiling: false };
}

// =============================================================================
// Recent-review AI summary
// =============================================================================

const SUMMARY_SCHEMA = {
  type: 'object' as const,
  properties: {
    summary: { type: 'string' as const, description: '1 to 2 sentences on the overall sentiment and what reviewers make of the film.' },
    recommendation: { type: 'string' as const, description: 'The verdict: is it worth watching, and how strongly do reviewers recommend it.' },
    dislikes: { type: 'string' as const, description: "What people most commonly didn't enjoy. Empty string if there is no shared complaint." },
    audience: { type: 'string' as const, description: "Who it's for and who it's not for." },
  },
  required: ['summary', 'recommendation', 'audience'],
};

const SUMMARY_PROMPT = `Summarize these recent Letterboxd reviews for someone deciding whether to watch this film. Be concise and specific to THIS film (performances, direction, writing, pacing, tone). Only use points raised by multiple reviewers; ignore Letterboxd in-jokes and contentless one-liners. You may use **bold** for emphasis. Each field is one or two short sentences, no preamble.`;

/** Fetches recent-review prose (skipping rating-only entries) for summarization */
async function fetchRecentReviewTexts(slug: string): Promise<string[]> {
  const parser = new DOMParser();
  const pages = await Promise.all(
    Array.from({ length: CONFIG.RECENT_REVIEW_PAGES }, (_, i) => fetchReviewPage(slug, i + 1).catch(() => ''))
  );
  const texts: string[] = [];
  const seen = new Set<string>();
  for (const html of pages) {
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('.js-review-body').forEach((body) => {
      const text = body.textContent?.trim().replace(/\s+/g, ' ') ?? '';
      if (text.length >= 20 && !seen.has(text)) { seen.add(text); texts.push(text); }
    });
  }
  return texts;
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
 * Finds candidate films from the most popular list containing this film: same or
 * shorter runtime, each with its combined score. Comparing them against the
 * current film is the display layer's job.
 */
async function findSimilarPicks(currentSlug: string, currentRuntime: number, statusElement: HTMLElement) {
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

  const cached = await getCachedSimilarPicks(currentSlug);
  if (cached && cached.listLink) {
    // Re-fetch list with cookies to exclude newly watched films
    const listUrl = `https://letterboxd.com${cached.listLink}by/rating/`;
    debug('Re-validating cached similar picks from', listUrl);
    const res = await throttledFetch(listUrl, { credentials: 'include' });
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const posteritems = Array.from(doc.querySelectorAll('li.posteritem'));
    const visible = new Set<string>();
    for (const item of posteritems) {
      const div = item.querySelector('[data-item-slug], a[href^="/film/"]');
      const slug = div?.getAttribute('data-item-slug') || extractSlugFromUrl(div?.getAttribute('href') || '');
      if (slug) visible.add(slug);
    }
    if (posteritems.length > 0 && visible.size === 0) {
      console.warn(`[LBX] Selector mismatch on cached list re-validation: ${posteritems.length} posteritems but 0 slugs — skipping filter`);
      return { ...cached, stats: cached.stats };
    }
    debug(`List has ${visible.size} visible films, cache has ${cached.films.length}`);
    const films = cached.films.filter((f: any) => visible.has(f.slug));
    const removed = cached.films.length - films.length;
    if (removed) {
      debug(`Filtered out ${removed} watched films:`, cached.films.filter((f: any) => !visible.has(f.slug)).map((f: any) => f.name));
      setCachedSimilarPicks(currentSlug, { ...cached, films });
    }
    return { ...cached, films, stats: cached.stats };
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
        const div = item.querySelector('[data-item-slug], [data-item-link], a[href^="/film/"]');
        if (!div) continue;
        const link = div.getAttribute('data-item-link') || div.getAttribute('href') || '';
        const slug = div.getAttribute('data-item-slug') || extractSlugFromUrl(link) || '';
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

    if (!allFilmSlugs.length) return { films: [], listName, listLink, stats: { totalInList: 0, runtimeMatched: 0, scored: 0, currentRuntime, foundOnPage, pagesSearched, lastPageItemCount, allScored: [] } };

    debug(`Total films across pages: ${allFilmSlugs.length}`);
    updateProgress(statusElement, 2, `Fetching ${allFilmSlugs.length} films...`);

    const allBasicData = await Promise.all(
      allFilmSlugs.map(async ({ slug, link }) => {
        try {
          const cached = await getCachedFilmData(slug);
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
    if (!runtimeMatches.length) return { films: [], listName, listLink, stats: { totalInList: allFilmSlugs.length, runtimeMatched: 0, scored: 0, currentRuntime, foundOnPage, pagesSearched, allScored: [] } };

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

    scoredFilms.sort((a: any, b: any) => b.score - a.score);
    const candidates: any[] = [];
    const allScored: any[] = [];
    let freshlyFetched = 0;
    let parseEmptyCount = 0;
    for (const f of scoredFilms) {
      allScored.push({ name: f.filmName, score: f.score, runtime: f.runtime, fetchFailed: f.fetchFailed, parseEmpty: f.parseEmpty });
      candidates.push({ slug: f.slug, name: f.filmName, link: f.link, score: f.score, runtime: f.runtime, year: f.year, fetchFailed: f.fetchFailed });
      if (!f.fromCache && !f.fetchFailed) {
        freshlyFetched++;
        if (f.parseEmpty) parseEmptyCount++;
      }
    }
    if (freshlyFetched >= 5 && parseEmptyCount / freshlyFetched >= 0.5) {
      console.warn(`[LBX] Histogram parser returned empty for ${parseEmptyCount}/${freshlyFetched} freshly-fetched films — Letterboxd CSI markup may have changed. Inspect /csi/film/<slug>/rating-histogram/ and update parseRatings().`);
    }
    const stats = { totalInList: allFilmSlugs.length, runtimeMatched: runtimeMatches.length, scored: scoredFilms.length, currentRuntime, foundOnPage, pagesSearched, allScored, parseEmptyCount, freshlyFetched };

    debug(`Candidate films: ${candidates.length}`);
    const result = { films: candidates, stats, listName, listLink };
    const cacheable = candidates.filter((f: any) => !f.fetchFailed);
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

/** Appends `element` to `target`, fading it in only when it actually changed lists. */
function moveTo(element: HTMLElement, target: HTMLElement) {
  const moved = element.parentElement !== target;
  // Re-inserting a node blurs whatever inside it had focus — hand it back so the
  // ignore/restore button stays keyboard-reachable after it flips.
  const focused = moved && element.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  target.append(element);
  focused?.focus();
  if (!moved) return;
  element.classList.add('lbx-moved');
  element.addEventListener('animationend', () => element.classList.remove('lbx-moved'), { once: true });
}

/**
 * Displays similar picks section: a candidate beats the current film when its
 * adjusted score (score × recent %) is equal or higher. Recent ratings are
 * fetched lazily, only for candidates whose score could reach the threshold,
 * and only as far as needed to settle each one.
 * Films the user has ignored move to a collapsed drawer and stop counting
 * towards the winner check; restoring one from the drawer undoes that.
 */
async function displaySimilarPicks(currentSlug: string, currentPromise: Promise<{ score: number; adjusted: number }>, currentRuntime: number, anchor: HTMLElement) {
  const similarSection = el('section', 'lbx-similar');
  similarSection.append(el('span', 'lbx-progress', 'Finding similar picks...'));
  anchor.after(similarSection);

  const [result, ignored, current] = await Promise.all([
    findSimilarPicks(currentSlug, currentRuntime, similarSection),
    loadIgnored(),
    currentPromise,
  ]);

  similarSection.textContent = '';
  if (result.error) {
    similarSection.remove();
    return;
  }

  const threshold = current.adjusted;
  const stats = result.stats && { ...result.stats, currentScore: current.score, currentAdjusted: threshold };
  // The adjusted score never exceeds the score, so a film scoring below the threshold can't
  // qualify — skip its review fetch instead of proving it.
  const films = result.films.filter((f: any) => f.fetchFailed || f.score >= threshold);

  if (films.length === 0) {
    similarSection.append(winnerBanner('★ Winner! No similar film with an equal or higher adjusted score.', result.listName, result.listLink));
    if (stats) similarSection.append(debugDetails(stats));
    return;
  }

  const banner = winnerBanner('', result.listName, result.listLink);
  const bannerText = banner.querySelector('.lbx-winner-text') as HTMLElement;
  banner.hidden = true;
  const header = el('h3', 'lbx-similar-header', 'Similar Picks');
  const sourceLink = el('a', 'lbx-similar-source', `From: ${result.listName}`) as HTMLAnchorElement;
  sourceLink.href = result.listLink;
  const list = el('ul', 'lbx-similar-list');
  const drawerToggle = el('div', 'lbx-ignored-toggle');
  const drawer = el('ul', 'lbx-similar-list lbx-ignored-list');
  similarSection.append(banner, header, sourceLink, list, drawerToggle, drawer);

  type Entry = { element: HTMLElement; meta: HTMLElement; button: HTMLButtonElement; film: any; passes: boolean; adjusted: number };
  const items = new Map<string, Entry>();
  let drawerOpen = false;
  let drawerRevealed = false;
  let recentsSettled = false;

  /** Re-entrant render — the ignore set is the only mutable input. */
  const paint = () => {
    let passCount = 0;
    let ignoredCount = 0;
    // Appending in adjusted order re-sorts both lists; until recents settle every
    // entry still carries its score, so this keeps the initial score order.
    const ordered = [...items.values()].sort((a, b) => b.adjusted - a.adjusted);
    for (const entry of ordered) {
      const isIgnored = ignored.has(entry.film.slug);
      if (isIgnored) ignoredCount++;
      else if (entry.passes) passCount++;
      entry.button.textContent = isIgnored ? '↺' : '×';
      const label = isIgnored ? 'Restore — count this as a better pick again' : 'Ignore — don’t count this as a better pick';
      entry.button.title = label;
      entry.button.setAttribute('aria-label', `${label}: ${entry.film.name}`);
      moveTo(entry.element, isIgnored ? drawer : list);
    }

    drawerToggle.hidden = ignoredCount === 0;
    drawerToggle.textContent = `${drawerOpen ? '▼' : '▶'} ${ignoredCount} ignored`;
    drawer.hidden = !drawerOpen || ignoredCount === 0;

    const isWinner = recentsSettled && passCount === 0;
    banner.hidden = !isWinner;
    header.hidden = isWinner;
    sourceLink.hidden = isWinner;
    if (isWinner) {
      bannerText.textContent = ignoredCount === items.size
        ? '★ Winner! Every similar film is ignored.'
        : '★ Winner! No similar film with an equal or higher adjusted score.';
    }
  };

  drawerToggle.addEventListener('click', () => { drawerOpen = !drawerOpen; paint(); });

  const toggleIgnored = (slug: string) => {
    if (ignored.has(slug)) {
      ignored.delete(slug);
    } else {
      ignored.add(slug);
      // First ignore of the visit springs the drawer open once, so undo is discoverable.
      if (!drawerRevealed) { drawerRevealed = true; drawerOpen = true; }
    }
    saveIgnored(ignored);
    paint();
  };

  films.forEach((film: any) => {
    const item = el('li', 'lbx-similar-item');
    const link = el('a', 'lbx-similar-link', film.name) as HTMLAnchorElement;
    link.href = film.link;
    const meta = el('span', 'lbx-similar-meta', filmMeta(film));
    const button = el('button', 'lbx-ignore') as HTMLButtonElement;
    button.type = 'button';
    button.addEventListener('click', () => toggleIgnored(film.slug));
    item.append(link, meta, button);
    items.set(film.slug, { element: item, meta, button, film, passes: false, adjusted: film.score });
  });
  paint();

  await Promise.all(
    films.map((film: any) =>
      // A film whose fetch failed keeps the benefit of the doubt, so it always gets the full tally.
      getCandidateRecentRatings(film.slug, film.score, film.fetchFailed ? 0 : threshold).catch(() => null).then((recent) => {
        const entry = items.get(film.slug)!;
        entry.adjusted = recent ? adjustedScore(film.score, recent.pct) : 0;
        const cap = recent?.ceiling ? '≤' : '';
        const adjustedText = !recent ? '?' : film.fetchFailed ? `${recent.pct}%` : `${cap}${recent.pct}% → ${cap}${addCommas(entry.adjusted)}`;
        entry.meta.textContent = filmMeta(film, adjustedText);
        entry.passes = !!(film.fetchFailed || (recent && entry.adjusted >= threshold));
        if (!entry.passes) {
          entry.element.classList.add('lbx-excluded');
          entry.button.before(el('span', 'lbx-similar-reason', `need ≥${addCommas(threshold)}`));
        }
      })
    )
  );
  recentsSettled = true;
  paint();

  if (stats) similarSection.append(debugDetails(stats));
}

// =============================================================================
// Main
// =============================================================================

/**
 * Main entry point - orchestrates score calculation and display
 */
async function run(ratings: number[]) {
  const currentSlug = extractSlugFromUrl(window.location.href);
  const currentRuntime = extractRuntime(document);
  const currentYear = extractYear(document);
  const currentFilmName = document.querySelector('h1.headline-1')?.textContent?.trim() || currentSlug;

  const cachedFilmRaw = currentSlug ? await getCachedFilmData(currentSlug) : null;
  const cachedFilm = cachedFilmRaw?.score > 0 ? cachedFilmRaw : null;
  const recentRatingsRaw = getRecentRatingsSummary().catch(() => ({ totalNumberOfRatings: 0, scoreAbsolute: 0, scorePercentage: 0 }));

  const reviewSection = document.querySelector('.review.body-text');
  // Anchor on the histogram container, not Letterboxd's average — films below
  // the site's own-average threshold render the histogram without one.
  const scoreAnchor = document.querySelector('.ratings-histogram-chart .rating-histogram');
  if (!scoreAnchor || !reviewSection) return;

  const renderScore = (scoreEl: HTMLElement, score: number, ratio: number) => {
    scoreEl.textContent = addCommas(score);
    scoreEl.append(el('span', 'lbx-pct', `· ${Math.round(ratio * 100)}%`));
  };

  const adjustedElement = el('div', 'lbx-adjusted', 'Calculating...');
  reviewSection.after(adjustedElement);

  let scorePromise: Promise<{ score: number; ratio: number }>;
  if (cachedFilm) {
    const scoreElement = el('span', 'lbx-score');
    renderScore(scoreElement, cachedFilm.score, cachedFilm.ratio);
    scoreAnchor.before(scoreElement);
    scorePromise = Promise.resolve({ score: cachedFilm.score, ratio: cachedFilm.ratio });
  } else {
    const scoreElement = el('span', 'lbx-score', 'Calculating...');
    scoreAnchor.before(scoreElement);
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

  const currentPromise = Promise.all([scorePromise, recentRatingsRaw]).then(([{ score }, recentRatings]) => {
    const adjusted = adjustedScore(score, recentRatings.scorePercentage);
    adjustedElement.textContent = `Adjusted: ${addCommas(adjusted)} · Recent: ${recentRatings.scorePercentage}%`;
    return { score, adjusted };
  });

  // AI summary of recent reviews sits between the adjusted line and Similar Picks.
  const summaryAnchor = currentSlug
    ? buildMediaSummary({
        anchor: adjustedElement,
        classPrefix: 'lbx-summary',
        heading: 'Recent Reviews',
        summaryPrompt: SUMMARY_PROMPT,
        schema: SUMMARY_SCHEMA,
        sections: [['Summary', 'summary'], ['Verdict', 'recommendation'], ['Didn’t enjoy', 'dislikes'], ['Who it’s for', 'audience']],
        summaryCacheKey: `lbx_summary_${currentSlug}`,
        summaryTtl: CONFIG.SUMMARY_CACHE_MS,
        initialButtonLabel: '✦ Summarize recent reviews',
        fetchReviews: () => fetchRecentReviewTexts(currentSlug),
      })
    : adjustedElement;

  const similarPicksPromise = currentSlug && currentRuntime
    ? displaySimilarPicks(currentSlug, currentPromise, currentRuntime, summaryAnchor)
    : Promise.resolve();

  await Promise.all([currentPromise, similarPicksPromise]);
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
