import { addCommas, el, renderMarkdown, renderMarkdownInline } from '../shared/utils';
import { STORAGE_GET, STORAGE_SET, STORAGE_RESULT, PREVIEW_CAPTURED } from '../shared/gmaps-bridge-protocol';
import { SCORE_CACHE_PREFIX, SUMMARY_CACHE_PREFIX, HIGHLIGHTS_CACHE_PREFIX } from '../shared/cache-keys';
import {
  chipsFromPreview,
  collectSearchTerms,
  collectSort,
  collectToken,
  extractReviewText,
  isTrusted,
  overallPctFromHistogram,
  overallScoreFromHistogram,
  PAGE_SIZE,
  parseOrQuery,
  reviewAge,
  sortedDisplayReviews,
  starScore,
  statsForReviews,
  textReviewsFor,
  timeAgo,
  type Locale,
  type Review,
  type SortKey,
  type SortStats,
  type Transport,
} from '@truescore/gmaps-shared';

const TIME_PERIODS = ['total', 'inPastYear', 'inPastMonth'] as const;
const SORT_KEYS = ['relevant', 'newest'] as const;
const MIN_PAGES_BEFORE_STABILIZE = 2;
const HIGHLIGHT_FETCH_CONCURRENCY = 3;

type Period = (typeof TIME_PERIODS)[number];
type ReviewData = {
  reviewsScores: Record<Period, number>;
  trustedReviews: Record<Period, number>;
  totalReviews: Record<Period, number>;
};
type SortState = { reviewMap: Record<string, Review>; reviewData: ReviewData; isFetching: boolean; done: boolean; cursor: string; pageCount: number };
type SummaryResult = { highlights?: { text: string; sentiment: string }[]; verdict?: string; valueForMoney?: number };
type MergedEls = { card: HTMLElement; pctEl: HTMLElement; barFill: HTMLElement; countEl: HTMLElement; diffEl: HTMLElement; detailEl: HTMLElement; tooltip: HTMLElement };
type CardEls = {
  merged?: MergedEls;
  sumBtn?: HTMLButtonElement;
  resumBtn?: HTMLButtonElement;
  questionInput?: HTMLInputElement;
  sumPanel?: HTMLElement;
  searchInput?: HTMLInputElement;
  searchResults?: HTMLElement;
  filteredSumPanel?: HTMLElement;
  highlightsSection?: HTMLElement;
  highlightsList?: HTMLElement;
  highlightsBtn?: HTMLButtonElement;
  highlightsStale?: HTMLElement;
  chipPanel?: HTMLElement;
  chipPanelTitle?: HTMLElement;
  chipPanelBody?: HTMLElement;
  chipSummarizeBtn?: HTMLButtonElement;
  chipCloseBtn?: HTMLButtonElement;
  chipQuestionInput?: HTMLInputElement;
  searchQuestionInput?: HTMLInputElement;
};

type HighlightStats = SortStats;
type Highlight = {
  label: string;
  count: number;
  token: string;
  fetched?: number;
  score?: HighlightStats;
  reviews?: Review[];
  summary?: SummaryResult;
};
type HighlightCandidate = { label: string; count: number; token: string };
type HighlightsCache = { items: Highlight[]; ts: number; newestHeadId?: string };
let activeHighlight: Highlight | null = null;
let activeLabelSearch: { query: string; reviews: Review[]; summary?: SummaryResult } | null = null;
let labelSearchSeq = 0;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const createLimiter = (limit: number) => {
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = () => {
    if (active >= limit) return;
    const next = queue.shift();
    if (next) next();
  };
  return <T>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    const run = () => {
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    };
    if (active < limit) run();
    else queue.push(run);
  });
};

let currentOption: Period = 'total';
let lastFeatureId = '';
let lastUrl = '';
let chipViewMode: 'reviews' | 'summary' = 'reviews';
let fullPctObserver: MutationObserver | null = null;
let staleHistogramKey: string | null = null;
let lastHistogramKey: string | null = null;

const abortControllers: Record<SortKey, AbortController | null> = { relevant: null, newest: null };
// Summaries persist indefinitely — they're invalidated only by an explicit
// re-summarize, never by review count drift like score/highlights.
let summaryCache: { all: SummaryResult | null } = { all: null };

const getSummaryCacheKey = () => `${SUMMARY_CACHE_PREFIX}${lastFeatureId || 'default'}`;
const loadSummaryCache = () => {
  try { summaryCache = JSON.parse(localStorage.getItem(getSummaryCacheKey()) as string) || { all: null }; }
  catch { summaryCache = { all: null }; }
};
const saveSummaryCache = () => {
  try { localStorage.setItem(getSummaryCacheKey(), JSON.stringify(summaryCache)); } catch {}
};

// chrome.storage.local proxy via gmaps-bridge.ts (we run in MAIN world).
const BRIDGE_TIMEOUT_MS = 5000;
const bridgeStorage = (() => {
  let nextId = 0;
  // Timeout protects against the bridge dropping the response (e.g., extension
  // reload mid-flight) — without it, the listener + Promise leak forever.
  const call = <T>(eventName: string, payload: any): Promise<T | null> => new Promise((resolve) => {
    const id = String(++nextId);
    const cleanup = () => {
      document.removeEventListener(STORAGE_RESULT, handler);
      clearTimeout(timer);
    };
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id !== id) return;
      cleanup();
      resolve(detail.value);
    };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, BRIDGE_TIMEOUT_MS);
    document.addEventListener(STORAGE_RESULT, handler);
    document.dispatchEvent(new CustomEvent(eventName, { detail: { id, ...payload } }));
  });
  return {
    get: <T>(key: string) => call<T>(STORAGE_GET, { key }),
    set: (key: string, value: any) => call<true>(STORAGE_SET, { key, value }),
  };
})();

type ScoreCacheEntry = {
  ts: number;
  // Top of the "newest" sort at cache time. If Google's current page-1 newest
  // first review ID still matches, no new reviews surfaced — cache is fresh.
  // Catches the case histogram totals miss (3 added + 3 deleted = same total).
  newestHeadId?: string;
  relevant: ReviewData;
  newest: ReviewData;
  merged: ReviewData;
  reviews?: Record<string, Review>;
  relevantIds?: string[];
  newestIds?: string[];
};
type FullScoreCacheEntry = ScoreCacheEntry & {
  reviews: Record<string, Review>;
  relevantIds: string[];
  newestIds: string[];
  newestHeadId: string;
};
const isFullyHydrated = (e: ScoreCacheEntry | null): e is FullScoreCacheEntry =>
  !!e?.reviews && !!e?.relevantIds && !!e?.newestIds && !!e?.newestHeadId;
let cachedScoreState: ScoreCacheEntry | null = null;
// Set when reconcileWithLiveHead confirms the cache is fresh and aborts the
// speculative refetches. Tells persistScoreCacheIfReady to skip — otherwise a
// partial reviewMap from the aborted-mid-pagination fetch would clobber the
// known-good cache. Reset on featureId change.
let scoreCacheServedFresh = false;
const loadScoreCache = (featureId: string) => bridgeStorage.get<ScoreCacheEntry>(`${SCORE_CACHE_PREFIX}${featureId}`);
const saveScoreCache = (featureId: string, entry: ScoreCacheEntry) =>
  bridgeStorage.set(`${SCORE_CACHE_PREFIX}${featureId}`, entry);

let highlightsState: HighlightsCache | null = null;
// featureId whose highlights are currently being computed — a per-place mutex,
// so an SPA nav can start the new place's compute while the old run winds down.
let highlightsComputingFor: string | null = null;
const getHighlightsCacheKey = () => `${HIGHLIGHTS_CACHE_PREFIX}${lastFeatureId || 'default'}`;
const loadHighlightsCache = () => {
  try { highlightsState = JSON.parse(localStorage.getItem(getHighlightsCacheKey()) as string) || null; }
  catch { highlightsState = null; }
};
const TRUESCORE_API_BASE = 'https://truescore.mohamed3on.com';
// Bounds the cloud-cache GET so a slow/hung server can't delay auto-highlights
// (which now waits on the cloud hydrate) indefinitely.
const CLOUD_FETCH_TIMEOUT_MS = 5000;

type CloudCache = {
  summary?: SummaryResult;
  highlights?: Highlight[];
  highlightSummaries?: Record<string, SummaryResult>;
};

const fetchCloudCache = async (featureId: string): Promise<CloudCache | null> => {
  try {
    const resp = await fetch(`${TRUESCORE_API_BASE}/api/cached?featureId=${encodeURIComponent(featureId)}`, {
      signal: AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.found ? data as CloudCache : null;
  } catch { return null; }
};

const pushContribution = (patch: {
  summary?: SummaryResult;
  highlights?: Highlight[];
  highlightSummaries?: Record<string, SummaryResult>;
}): void => {
  const featureId = getFeatureId();
  const { name } = getPlaceInfo();
  if (!featureId || !name) return;
  fetch(`${TRUESCORE_API_BASE}/api/contribute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featureId, name, ...patch }),
  }).catch((e) => console.warn('[gmaps] contribute failed', e));
};

// Resolves when the in-flight cloud hydrate settles. The auto-highlights
// trigger waits on it so a cloud hit isn't clobbered by a local recompute.
let cloudHydratePromise: Promise<void> = Promise.resolve();

const hydrateFromCloud = (featureId: string) => {
  const needSummary = !summaryCache.all;
  const needHighlights = !highlightsState?.items?.length;
  if (!needSummary && !needHighlights) return;
  cloudHydratePromise = fetchCloudCache(featureId).then((cloud) => {
    if (!cloud) return;
    if (getFeatureId() !== featureId || lastFeatureId !== featureId) return;
    let touchedSummary = false;
    let touchedHighlights = false;
    if (needSummary && cloud.summary) {
      summaryCache.all = cloud.summary;
      saveSummaryCache();
      touchedSummary = true;
    }
    if (needHighlights && cloud.highlights?.length) {
      const items: Highlight[] = cloud.highlights.map((h) => ({
        ...h,
        summary: cloud.highlightSummaries?.[h.token],
      }));
      highlightsState = { items, ts: Date.now() };
      saveHighlightsCache();
      touchedHighlights = true;
    }
    if (touchedSummary && cardEls.sumPanel) {
      cardEls.sumPanel.style.display = 'block';
      renderSummary(cardEls.sumPanel, summaryCache.all!);
      refreshSumBtnState();
    }
    if (touchedHighlights) renderHighlights();
  }).catch((e) => console.warn('[gmaps] cloud hydrate failed', e));
};

// Strip review bodies before persisting — they balloon to MBs per place and
// exhaust the 5MB localStorage quota, silently dropping summaries. Reviews
// refetch on demand when a chip opens.
const slimHighlightItems = <T extends { items: any[] }>(state: T): T => ({
  ...state,
  items: state.items.map(({ reviews: _r, ...rest }: any) => rest),
});

const saveHighlightsCache = () => {
  try {
    if (highlightsState) {
      const head = liveNewestHeadId();
      if (head) highlightsState.newestHeadId = head;
      localStorage.setItem(getHighlightsCacheKey(), JSON.stringify(slimHighlightItems(highlightsState)));
    } else {
      localStorage.removeItem(getHighlightsCacheKey());
    }
  } catch {}
};

const liveNewestHeadId = (): string | null =>
  Object.keys(scores.newest.reviewMap)[0] || null;

const liveNewestHeadReview = (): Review | null => {
  const id = liveNewestHeadId() ?? cachedScoreState?.newestHeadId;
  if (!id) return null;
  return scores.newest.reviewMap[id] ?? cachedScoreState?.reviews?.[id] ?? null;
};

// Legacy rc_highlights_* entries persisted full review bodies; one place can
// hit 3MB and crowd out everything else. The substring gate skips the parse
// for already-slim entries so this loop is cheap on every page load.
(() => {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(HIGHLIGHTS_CACHE_PREFIX)) continue;
      const raw = localStorage.getItem(k);
      if (!raw || !raw.includes('"reviews":[')) continue;
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(parsed?.items)) continue;
      localStorage.setItem(k, JSON.stringify(slimHighlightItems(parsed)));
    }
  } catch {}
})();

const makeReviewData = (): ReviewData => ({
  reviewsScores: { total: 0, inPastYear: 0, inPastMonth: 0 },
  trustedReviews: { total: 0, inPastYear: 0, inPastMonth: 0 },
  totalReviews: { total: 0, inPastYear: 0, inPastMonth: 0 },
});

const makeState = (): SortState => ({ reviewMap: {}, reviewData: makeReviewData(), isFetching: false, done: false, cursor: '', pageCount: 0 });
const scores: Record<SortKey, SortState> = { relevant: makeState(), newest: makeState() };

const toPct = (ratio: number) => Math.round(ratio * 100);
const getScorePercentage = (sortKey: SortKey) => {
  const live = scores[sortKey].reviewData;
  if (live.totalReviews.total === 0 && cachedScoreState) {
    const c = cachedScoreState[sortKey];
    return c.reviewsScores[currentOption] / c.trustedReviews[currentOption] || 0;
  }
  return live.reviewsScores[currentOption] / live.trustedReviews[currentOption] || 0;
};
const getRoundedPct = (sortKey: SortKey) => toPct(getScorePercentage(sortKey));

const getMergedStats = () => {
  const merged = mergeReviewMaps();
  const liveCount = Object.keys(merged).length;

  if (liveCount === 0 && cachedScoreState) {
    const m = cachedScoreState.merged;
    const trusted = m.trustedReviews[currentOption];
    return {
      totalCount: m.totalReviews.total,
      totalAll: m.totalReviews[currentOption],
      totalTrusted: trusted,
      mergedPct: trusted ? m.reviewsScores[currentOption] / trusted : 0,
    };
  }

  let totalAll = 0, totalTrusted = 0, totalScore = 0;
  for (const id in merged) {
    const r = merged[id];
    if (!classifyTimePeriod(r.timestamp)[currentOption]) continue;
    totalAll++;
    if (isTrusted(r.reviewerReviewCount)) {
      totalTrusted++;
      totalScore += starScore(r.stars);
    }
  }
  return {
    totalCount: liveCount,
    totalAll,
    totalTrusted,
    mergedPct: totalTrusted ? totalScore / totalTrusted : 0,
  };
};

const persistScoreCacheIfReady = () => {
  const featureId = getFeatureId();
  if (!featureId) return;
  if (scoreCacheServedFresh && isFullyHydrated(cachedScoreState)) return;
  if (!scores.relevant.done || !scores.newest.done) return;
  const liveMerged = mergeReviewMaps();
  if (!Object.keys(liveMerged).length) return;
  const mergedRD = makeReviewData();
  for (const id in liveMerged) processReview(liveMerged[id], mergedRD);
  const newestIds = Object.keys(scores.newest.reviewMap);
  const entry: ScoreCacheEntry = {
    ts: Date.now(),
    newestHeadId: newestIds[0],
    relevant: scores.relevant.reviewData,
    newest: scores.newest.reviewData,
    merged: mergedRD,
    reviews: liveMerged,
    relevantIds: Object.keys(scores.relevant.reviewMap),
    newestIds,
  };
  if (isFullyHydrated(cachedScoreState) &&
      cachedScoreState.newestHeadId === entry.newestHeadId &&
      cachedScoreState.merged.totalReviews.total === entry.merged.totalReviews.total) {
    return;
  }
  cachedScoreState = entry;
  saveScoreCache(featureId, entry).catch((e) => console.warn('[gmaps] persist score cache failed', e));
};

const resetScores = () => {
  staleHistogramKey = lastHistogramKey;
  lastHistogramKey = null;
  for (const key of SORT_KEYS) {
    scores[key] = makeState();
    if (abortControllers[key]) { abortControllers[key]!.abort(); abortControllers[key] = null; }
  }
  if (fullPctObserver) { fullPctObserver.disconnect(); fullPctObserver = null; }
  cachedScoreState = null;
  scoreCacheServedFresh = false;
  stopAutoScroll();
};

let autoScroll: { active: boolean; abort: AbortController | null } = { active: false, abort: null };

const findReviewsScrollContainer = (): HTMLElement | null => {
  const first = document.querySelector<HTMLElement>('.jftiEf[data-review-id]');
  if (!first) return null;
  let el: HTMLElement | null = first.parentElement;
  while (el) {
    const style = getComputedStyle(el);
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
};

const stopAutoScroll = () => {
  if (!autoScroll.active) return;
  autoScroll.active = false;
  autoScroll.abort?.abort();
  autoScroll.abort = null;
};

const startAutoScroll = async () => {
  const container = findReviewsScrollContainer();
  if (!container) return;
  const ctrl = new AbortController();
  autoScroll = { active: true, abort: ctrl };
  container.addEventListener('wheel', (e) => { if ((e as WheelEvent).deltaY < 0) stopAutoScroll(); }, { signal: ctrl.signal });

  let stagnant = 0;
  while (autoScroll.active) {
    const beforeCount = container.querySelectorAll('.jftiEf[data-review-id]').length;
    const beforeHeight = container.scrollHeight;
    container.scrollTo({ top: container.scrollHeight });
    await new Promise((r) => setTimeout(r, 350));
    if (!autoScroll.active) return;
    const afterCount = container.querySelectorAll('.jftiEf[data-review-id]').length;
    if (afterCount === beforeCount && container.scrollHeight === beforeHeight) {
      if (++stagnant >= 2) break;
    } else stagnant = 0;
  }
  stopAutoScroll();
};

const isTypingTarget = (el: EventTarget | null) => {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
};

if (!(window as any).__rcGmapsKeybound) {
  (window as any).__rcGmapsKeybound = true;
  document.addEventListener('keydown', (e) => {
    if (e.repeat || isTypingTarget(e.target)) return;
    if (e.key === 'Escape' && autoScroll.active) { stopAutoScroll(); return; }
    if (e.key !== 'Alt' || e.ctrlKey || e.metaKey) return;
    const container = findReviewsScrollContainer();
    if (!container) return;
    e.preventDefault();
    if (e.shiftKey) {
      stopAutoScroll();
      container.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (autoScroll.active) stopAutoScroll();
    else startAutoScroll();
  });
}

type ColorStop = { at: number; r: number; g: number; b: number };
const RED = { r: 248, g: 113, b: 113 };
const AMBER = { r: 251, g: 191, b: 36 };
const GREEN = { r: 74, g: 222, b: 128 };
const DEEP_GREEN = { r: 34, g: 197, b: 94 };
// Comparison gradient: 0 → red, 0.5 → amber (parity), 1 → green.
const COMPARE_STOPS: ColorStop[] = [{ at: 0, ...RED }, { at: 0.5, ...AMBER }, { at: 1, ...GREEN }];
// Absolute net-polarity gradient (raw ∈ −1..1): scores cluster high, so the
// meaningful band is ~0.6–1.0 — ≤60 red, 70 amber, 80 green, 90+ deepens.
const ABSOLUTE_STOPS: ColorStop[] = [{ at: 0.6, ...RED }, { at: 0.7, ...AMBER }, { at: 0.8, ...GREEN }, { at: 1, ...DEEP_GREEN }];

const lerpStops = (stops: ColorStop[], at: number) => {
  const p = Math.max(0, Math.min(1, at));
  const i = stops.findIndex((s) => p <= s.at);
  const lo = stops[Math.max(0, i - 1)];
  const hi = stops[Math.min(stops.length - 1, i)];
  const t = hi.at === lo.at ? 0 : (p - lo.at) / (hi.at - lo.at);
  return `rgb(${Math.round(lo.r + (hi.r - lo.r) * t)},${Math.round(lo.g + (hi.g - lo.g) * t)},${Math.round(lo.b + (hi.b - lo.b) * t)})`;
};

// Color a score by its signed diff vs a reference, over a ±10pt window
// (≤−10 red, 0 amber/parity, ≥+10 green). lerpStops clamps, so no extra guard.
const getDiffColor = (diff: number) => lerpStops(COMPARE_STOPS, (diff + 10) / 20);
const getAbsoluteScoreColor = (raw: number) => lerpStops(ABSOLUTE_STOPS, raw);

const readHistogramCounts = () => {
  const reviewRows = document.querySelectorAll('tr[role="img"]');
  if (reviewRows.length < 5) return null;
  const extractNumber = (str: string) => {
    const match = str.match(/(\d+(?:[.,]\d+)*)\s*(?:reviews?|$)/);
    return match ? parseInt(match[1].replace(/[.,]/g, ''), 10) : 0;
  };
  return Array.from(reviewRows).map((r) => extractNumber(r.getAttribute('aria-label') || ''));
};

const updateHighlightsStaleBadge = () => {
  const badge = cardEls.highlightsStale;
  if (!badge) return;
  const cached = highlightsState?.newestHeadId;
  const live = liveNewestHeadId();
  const stale = cached != null && live != null && cached !== live && !!highlightsState?.items.length;
  badge.style.display = stale ? '' : 'none';
};

// Histogram totals lie when Google trims old reviews while new ones arrive
// (same total, different feed); the top reviewId of the newest sort doesn't.
const reconcileWithLiveHead = (liveHeadId: string) => {
  const cachedHead = cachedScoreState?.newestHeadId;
  if (cachedHead && cachedHead !== liveHeadId) cachedScoreState = null;
  else if (cachedHead === liveHeadId && isFullyHydrated(cachedScoreState)) {
    scoreCacheServedFresh = true;
    for (const k of SORT_KEYS) {
      if (scores[k].isFetching) abortControllers[k]?.abort();
      scores[k].isFetching = false;
      scores[k].done = true;
      abortControllers[k] = null;
    }
  }
  updateHighlightsStaleBadge();
};

const calculateFullPercentage = () => {
  const counts = readHistogramCounts();
  if (!counts) return null;
  const key = counts.join(',');
  if (key === staleHistogramKey) return null;
  const allReviews = counts.reduce((a, b) => a + b, 0);
  if (!allReviews) return null;
  lastHistogramKey = key;
  return toPct((counts[0] - counts[4]) / allReviews);
};

const getPlaceInfo = () => {
  const name = document.querySelector('h1.DUwDvf')?.textContent?.trim() || '';
  const category = (document.querySelector('button.DkEaL') as HTMLElement)?.textContent?.trim() || '';
  return { name, category };
};

const injectSimpleScore = (placeDetailsElement: HTMLElement) => {
  const counts = readHistogramCounts();
  if (!counts || !counts.reduce((a, b) => a + b, 0)) return;
  const score = overallScoreFromHistogram(counts);
  const pct = overallPctFromHistogram(counts);
  const newElement = el('div', 'truescore-simple-score', `score: ${addCommas(score)} — ${pct}%`);
  placeDetailsElement.appendChild(newElement);
};

const getFeatureId = () => {
  const matches = [...location.href.matchAll(/!3m\d+!1s(0x[a-f0-9]+(?:%3A|:)0x[a-f0-9]+)/gi)];
  return matches.length ? decodeURIComponent(matches[matches.length - 1][1]) : null;
};

const localeFromDom = (): Locale => ({
  hl: document.documentElement.lang || 'en',
  gl: location.href.match(/gl=([a-zA-Z]{2})/)?.[1] || '',
});

// Extension transport: fetch from the maps tab on the user's own session.
const tabTransport: Transport = (url, init) => fetch(url, init).then((r) => r.text());

const buildUrlForSearch = (featureId: string, query: string, cursor = '') => {
  const { hl = 'en', gl = '' } = localeFromDom();
  const c = encodeURIComponent(cursor);
  const pb = [
    `!1m7!1s${featureId}!3s${encodeURIComponent(query)}!6m4!4m1!1e1!4m1!1e3`,
    `!2m2!1i${PAGE_SIZE}!2s${c}`,
    `!5m2!1s${c}!7e81`,
    `!8m9!2b1!3b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1`,
    `!11m4!1e3!2e1!6m1!1i2`,
    `!13m1!1e1`,
  ].join('');
  return `https://www.google.com/maps/rpc/listugcposts?authuser=0&hl=${hl}&gl=${gl}&pb=${pb}`;
};

const PREVIEW_WAIT_MS = 3000;

// Wake on PREVIEW_CAPTURED for this featureId, or fall through after a short
// timeout. Last-resort active fetch is done by the caller if we return null.
const waitForCapturedPreview = (featureId: string): Promise<any | null> => new Promise((resolve) => {
  const existing = window.__truescorePreviews?.[featureId]?.json;
  if (existing) { resolve(existing); return; }
  const cleanup = () => {
    document.removeEventListener(PREVIEW_CAPTURED, handler);
    clearTimeout(timer);
  };
  const handler = (e: Event) => {
    if ((e as CustomEvent).detail?.featureId !== featureId) return;
    cleanup();
    resolve(window.__truescorePreviews?.[featureId]?.json ?? null);
  };
  const timer = setTimeout(() => { cleanup(); resolve(null); }, PREVIEW_WAIT_MS);
  document.addEventListener(PREVIEW_CAPTURED, handler);
});

const harvestHighlightsFromPreview = async (): Promise<HighlightCandidate[]> => {
  const featureId = getFeatureId();
  if (!featureId) return [];
  const data = (await waitForCapturedPreview(featureId)) ?? (await fetchPlacePreviewActive(location.href));
  return data ? chipsFromPreview(data) : [];
};

const fetchPlacePreviewActive = async (placeUrl: string): Promise<any | null> => {
  try {
    const html = await (await fetch(placeUrl, { cache: 'reload' })).text();
    const m = html.match(/\/maps\/preview\/place\?[^"\s<>]+/);
    if (!m) return null;
    const u = new URL(`https://www.google.com${m[0].replace(/&amp;/g, '&')}`);
    u.searchParams.set('hl', document.documentElement.lang || 'en');
    const body = await (await fetch(u.toString())).text();
    return JSON.parse(body.replace(/^\)\]\}'\s*/, ''));
  } catch (e) {
    console.warn('[highlights] fetchPlacePreviewActive failed', e);
    return null;
  }
};

const fetchAllForToken = (featureId: string, token: string): Promise<Review[]> =>
  collectToken(featureId, token, tabTransport, { locale: localeFromDom() });

// Gmail-style ` OR ` splits the query; collectSearchTerms runs one Google
// search per term in parallel and merges by reviewId (plain query → N=1).
const fetchAllForSearch = (featureId: string, query: string): Promise<Review[]> =>
  collectSearchTerms(parseOrQuery(query), (term, c) => buildUrlForSearch(featureId, term, c), tabTransport);

(window as any).__truescoreGmaps = {
  ...((window as any).__truescoreGmaps || {}),
  fetchLabelSearch: async (query: string) => {
    const featureId = getFeatureId();
    const trimmed = query.trim();
    if (!featureId || !trimmed) return [];
    return fetchAllForSearch(featureId, trimmed);
  },
};

const computeHighlights = async (force = false) => {
  const featureId = getFeatureId();
  if (!featureId || highlightsComputingFor === featureId) return;
  if (!force && highlightsState && highlightsState.items.length) {
    renderHighlights();
    return;
  }
  highlightsComputingFor = featureId;
  // True only while the user is still on the place this run started for — an
  // SPA navigation mid-fetch must not write this place's highlights into the
  // next place's cache, cloud entry, or panel.
  const stillCurrent = () => getFeatureId() === featureId;
  if (cardEls.highlightsBtn) {
    cardEls.highlightsBtn.disabled = true;
    cardEls.highlightsBtn.textContent = 'Computing…';
  }
  // Pause parent's main-score fetches so highlight RPCs are not competing with
  // the regular score requests on the same google.com connection.
  const pausedSorts: SortKey[] = [];
  for (const k of SORT_KEYS) {
    if (scores[k].isFetching) {
      abortControllers[k]?.abort();
      scores[k].isFetching = false;
      pausedSorts.push(k);
    }
  }
  try {
    const chips = await harvestHighlightsFromPreview();
    if (!stillCurrent()) return;
    if (!chips.length) {
      if (cardEls.highlightsBtn) cardEls.highlightsBtn.textContent = 'No highlights';
      return;
    }

    const items: Highlight[] = [];
    highlightsState = { items, ts: Date.now() };
    const limit = createLimiter(HIGHLIGHT_FETCH_CONCURRENCY);
    let completed = 0;

    await Promise.all(chips.map((chip) => limit(async () => {
      try {
        const reviews = await fetchAllForToken(featureId, chip.token);
        if (!stillCurrent()) return;
        const item = { ...chip, fetched: reviews.length, score: statsForReviews(reviews), reviews };
        items.push(item);
        highlightsState = { items: [...items], ts: Date.now() };
        saveHighlightsCache();
        renderHighlights();
      } catch (e) {
        console.error('[highlights] fetch failed for', chip.label, e);
      } finally {
        completed++;
        if (stillCurrent() && cardEls.highlightsBtn) cardEls.highlightsBtn.textContent = `Computing ${completed}/${chips.length}`;
      }
    })));

    if (!stillCurrent()) return;
    if (!items.length) {
      if (cardEls.highlightsBtn) cardEls.highlightsBtn.textContent = 'No highlights';
      return;
    }
    renderHighlights();
    pushContribution({ highlights: items });
  } catch (e) {
    console.error('[highlights] error:', e);
    if (stillCurrent() && cardEls.highlightsBtn) cardEls.highlightsBtn.textContent = 'Failed — retry';
  } finally {
    if (highlightsComputingFor === featureId) highlightsComputingFor = null;
    // Resume parent's main-score fetches that we paused.
    for (const k of pausedSorts) {
      if (!scores[k].done) fetchAllReviews(k);
    }
  }
};

const classifyTimePeriod = (timestamp: number | null): Record<Period, boolean> => {
  if (!timestamp) return { total: true, inPastYear: false, inPastMonth: false };
  const t = timestamp / 1000;
  const now = Date.now();
  return { total: true, inPastYear: t >= now - 365 * 86400000, inPastMonth: t >= now - 30 * 86400000 };
};

const processReview = (review: Review, rd: ReviewData) => {
  const trusted = isTrusted(review.reviewerReviewCount);
  const periods = classifyTimePeriod(review.timestamp);
  const contribution = starScore(review.stars);
  for (const period of TIME_PERIODS) {
    if (!periods[period]) continue;
    rd.totalReviews[period]++;
    if (trusted) {
      rd.trustedReviews[period]++;
      rd.reviewsScores[period] += contribution;
    }
  }
};

const mergeReviewMaps = (): Record<string, Review> => {
  const merged: Record<string, Review> = {};
  for (const key of SORT_KEYS) {
    for (const id in scores[key].reviewMap) {
      if (!merged[id]) merged[id] = scores[key].reviewMap[id];
    }
  }
  return merged;
};

// All Gemini work happens server-side (truescore-web) so the model, prompts,
// and schema live in one place. The extension just ships the date-prefixed
// review texts (already produced by textReviewsFor) plus place identity, and
// the server runs the same summarize()/ask() the web SPA does.
const summarizeReviews = async (reviewTexts: string[], filterQuery: string | null, customQuestion: string | null): Promise<SummaryResult | string> => {
  const featureId = getFeatureId();
  const { name } = getPlaceInfo();

  const post = async <T>(path: string, body: object): Promise<T> => {
    const resp = await fetch(`${TRUESCORE_API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => null) as (T & { error?: string }) | null;
    if (!resp.ok || !data || data.error) {
      throw new Error(data?.error || `${path} failed (${resp.status})`);
    }
    return data;
  };

  if (customQuestion) {
    const data = await post<{ answer: string }>('/api/ask', {
      featureId, name, reviewTexts, question: customQuestion,
      filter: filterQuery ?? undefined,
    });
    return data.answer;
  }
  const data = await post<{ summary: SummaryResult }>('/api/summarize', {
    featureId, name, reviewTexts,
    filter: filterQuery ?? undefined,
    // Extension manages its own client-side cache (summaryCache.all,
    // h.summary, search.summary). When it calls summarizeReviews, intent is
    // always "compute fresh" — Resummarize/refresh-search/highlight-summarize
    // all flow here. Server-side cache is for the web SPA.
    force: true,
  });
  return data.summary;
};

const fetchAllReviews = async (sortKey: SortKey) => {
  const featureId = getFeatureId();
  if (!featureId || scores[sortKey].isFetching) return;

  const state = scores[sortKey];
  state.isFetching = true;
  state.done = false;
  const controller = new AbortController();
  abortControllers[sortKey] = controller;

  let lastPct: number | null = null;
  try {
    // Shared cursor loop; the extension keeps its own stop policy (period-aware
    // stabilization on getRoundedPct, page-1 live-head reconcile) and per-review
    // time-period bucketing in onPage, and pauses via the AbortSignal.
    await collectSort(featureId, sortKey, tabTransport, {
      startCursor: state.cursor,
      signal: controller.signal,
      locale: localeFromDom(),
      stabilize: false,
      onPage: (_running, { index, nextCursor, pageReviews }) => {
        for (const r of pageReviews) {
          if (!state.reviewMap[r.reviewId]) { state.reviewMap[r.reviewId] = r; processReview(r, state.reviewData); }
        }
        state.pageCount = index + 1;
        if (nextCursor) state.cursor = nextCursor;
        updateUI();

        if (sortKey === 'newest' && index === 0 && pageReviews[0]?.reviewId) {
          reconcileWithLiveHead(pageReviews[0].reviewId);
          if (scoreCacheServedFresh) return 'stop';
        }

        if (state.pageCount >= MIN_PAGES_BEFORE_STABILIZE) {
          const pct = getRoundedPct(sortKey);
          if (lastPct !== null && Math.abs(pct - lastPct) <= 1) return 'stop';
          lastPct = pct;
        }
      },
    });
  } catch (e: any) {
    if (e.name !== 'AbortError') console.error(`[Reviews] ${sortKey} error:`, e);
  }
  state.isFetching = false;
  state.done = true;
  abortControllers[sortKey] = null;
  updateUI();
  persistScoreCacheIfReady();
  // Highlights compute automatically once both score sorts finish — after, not
  // during, so chip RPCs don't pause the hero metric. Wait for the in-flight
  // cloud hydrate first so a cloud hit (with summaries) isn't clobbered by a
  // redundant recompute; computeHighlights no-ops if highlights already exist.
  if (scores.relevant.done && scores.newest.done) {
    cloudHydratePromise.then(() => computeHighlights());
  }
};

const startFetching = () => {
  if (!getFeatureId()) return;
  for (const key of SORT_KEYS) fetchAllReviews(key);
};

const cardEls: CardEls = {};
const clearCardEls = () => { for (const k of Object.keys(cardEls) as (keyof CardEls)[]) delete cardEls[k]; };

const renderHighlights = () => {
  const list = cardEls.highlightsList;
  const btn = cardEls.highlightsBtn;
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!highlightsState || !highlightsState.items.length) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Compute Highlights';
    }
    return;
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
  const overall = toPct(getMergedStats().mergedPct);
  const weight = (h: Highlight) => {
    const r = (h.score?.scorePct ?? 0) / 100;
    return r * Math.abs(r) * h.count;
  };
  const isAbove = (h: Highlight) => (h.score?.scorePct ?? 0) >= overall;
  const sorted = [...highlightsState.items].sort((a, b) => {
    const above = Number(isAbove(b)) - Number(isAbove(a));
    if (above !== 0) return above;
    return weight(b) - weight(a);
  });
  for (const h of sorted) {
    const chip = el('button', 'rc-chip') as HTMLButtonElement;
    chip.type = 'button';
    const label = el('span', 'rc-chip-label', h.label);
    chip.appendChild(label);
    if (h.score) {
      const pctEl = el('span', `rc-chip-pct ${isAbove(h) ? 'pos' : 'neg'}`, `${h.score.scorePct}%`);
      chip.appendChild(pctEl);
    }
    const countEl = el('span', 'rc-chip-count', `·${h.count}`);
    chip.appendChild(countEl);
    if (activeHighlight?.token === h.token) chip.classList.add('rc-chip-active');
    chip.onclick = () => onChipClick(h);
    list.appendChild(chip);
  }
  updateHighlightsStaleBadge();
};

const onChipClick = (h: Highlight) => {
  if (activeHighlight?.token === h.token) {
    closeChipPanel();
    return;
  }
  showChipPanel(h);
};

const reviewCardEl = (r: Review): HTMLElement => {
  const card = el('div', 'rc-review');
  const meta = el('div', 'rc-review-meta');
  const stars = el('span', 'rc-review-stars', '★'.repeat(r.stars) + '☆'.repeat(Math.max(0, 5 - r.stars)));
  const age = el('span', 'rc-review-age', reviewAge(r.timestamp));
  meta.appendChild(stars);
  meta.appendChild(age);
  card.appendChild(meta);
  const text = el('div', 'rc-review-text');
  renderMarkdown(text, r.text);
  card.appendChild(text);
  return card;
};

const renderReviewsInto = (container: HTMLElement, reviews: Review[]) => {
  for (const r of sortedDisplayReviews(reviews)) {
    container.appendChild(reviewCardEl(r));
  }
};

const renderChipReviews = (h: Highlight) => {
  const body = cardEls.chipPanelBody;
  if (!body) return;
  body.textContent = '';
  renderReviewsInto(body, h.reviews ?? []);
};

const renderChipTitle = (title: HTMLElement, h: Highlight) => {
  const score = h.score?.scorePct ?? 0;
  title.textContent = `${h.label.toUpperCase()} · ${score}% · ${h.score?.trustedReviews ?? 0}/${h.reviews?.length ?? h.count}`;
};

// Reviews are not persisted (see saveHighlightsCache); fetch on demand after a
// refresh so the chip panel and Summarize have data to work with.
const ensureChipReviews = async (h: Highlight): Promise<void> => {
  if (h.reviews) return;
  const featureId = getFeatureId();
  if (!featureId) return;
  try { h.reviews = await fetchAllForToken(featureId, h.token); }
  catch (e) { console.error('[highlights] refetch reviews failed for', h.label, e); }
};

const showChipPanel = (h: Highlight) => {
  activeHighlight = h;
  const panel = cardEls.chipPanel;
  const title = cardEls.chipPanelTitle;
  const sumBtn = cardEls.chipSummarizeBtn;
  const body = cardEls.chipPanelBody;
  if (!panel || !title || !sumBtn || !body) return;
  renderChipTitle(title, h);
  panel.style.display = 'block';
  chipViewMode = h.summary ? 'summary' : 'reviews';
  sumBtn.textContent = h.summary ? 'Show Reviews' : 'Summarize';
  if (cardEls.chipQuestionInput) cardEls.chipQuestionInput.value = '';
  if (h.summary) renderSummary(body, h.summary);
  else renderChipReviews(h);

  if (!h.reviews) {
    if (!h.summary) {
      body.textContent = 'Loading reviews…';
      body.className = 'rc-chip-body loading';
    }
    sumBtn.disabled = true;
    ensureChipReviews(h).then(() => {
      if (activeHighlight !== h) return;
      sumBtn.disabled = false;
      renderChipTitle(title, h);
      if (chipViewMode === 'reviews') renderChipReviews(h);
    });
  } else {
    sumBtn.disabled = false;
  }

  renderHighlights();
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const closeChipPanel = () => {
  activeHighlight = null;
  if (cardEls.chipPanel) cardEls.chipPanel.style.display = 'none';
  renderHighlights();
};

const summarizeActiveChip = async () => {
  const h = activeHighlight;
  if (!h) return;
  const body = cardEls.chipPanelBody;
  const sumBtn = cardEls.chipSummarizeBtn;
  if (!body || !sumBtn) return;
  if (h.summary && chipViewMode === 'summary') {
    renderChipReviews(h);
    sumBtn.textContent = 'Summarize';
    chipViewMode = 'reviews';
    return;
  }
  if (h.summary) {
    renderSummary(body, h.summary);
    sumBtn.textContent = 'Show Reviews';
    chipViewMode = 'summary';
    return;
  }
  sumBtn.disabled = true;
  sumBtn.textContent = 'Summarizing…';
  body.textContent = 'Summarizing…';
  body.className = 'rc-chip-body loading';
  const texts = textReviewsFor(h.reviews ?? []);
  if (!texts.length) {
    body.textContent = 'No review text available';
    body.className = 'rc-chip-body';
    sumBtn.disabled = false;
    sumBtn.textContent = 'Summarize';
    return;
  }
  try {
    const result = await summarizeReviews(texts, h.label, null);
    if (typeof result === 'object') {
      h.summary = result;
      saveHighlightsCache();
      body.className = 'rc-chip-body';
      renderSummary(body, result);
      sumBtn.textContent = 'Show Reviews';
      chipViewMode = 'summary';
      pushContribution({ highlightSummaries: { [h.token]: result } });
    }
  } catch (e) {
    console.error('[highlights] summary failed', e);
    body.textContent = 'Summarization failed';
    body.className = 'rc-chip-body';
    sumBtn.textContent = 'Summarize';
  } finally {
    sumBtn.disabled = false;
  }
};

const askActiveChip = async () => {
  const h = activeHighlight;
  const body = cardEls.chipPanelBody;
  const input = cardEls.chipQuestionInput;
  const q = input?.value?.trim();
  if (!h || !body || !q) return;
  const texts = textReviewsFor(h.reviews ?? []);
  if (!texts.length) { body.textContent = 'No review text available'; return; }
  body.textContent = 'Asking…';
  body.className = 'rc-chip-body loading';
  try {
    const result = await summarizeReviews(texts, h.label, q);
    body.className = 'rc-chip-body';
    renderSummary(body, result);
    input.value = '';
  } catch (e) {
    console.error('[chip] ask failed', e);
    body.textContent = 'Ask failed';
    body.className = 'rc-chip-body';
  }
};

const renderLabelSearchResult = () => {
  const res = cardEls.searchResults;
  const panel = cardEls.filteredSumPanel;
  if (!res || !activeLabelSearch) return;
  if (panel) panel.style.display = 'none';

  const { query, reviews } = activeLabelSearch;
  const score = statsForReviews(reviews);
  // Color by how this query scores vs the place overall (like the chips / main
  // number); the % label itself stays absolute.
  const overall = toPct(getMergedStats().mergedPct);
  const color = getDiffColor(score.scorePct - overall);

  res.style.display = 'block';
  res.textContent = '';
  const header = el('div', 'rc-search-header');
  const scoreEl = el('span', 'rc-search-score', score.trustedReviews ? `${score.scorePct}%` : '—');
  scoreEl.style.color = score.trustedReviews ? color : '#888';
  header.appendChild(scoreEl);
  header.appendChild(el('span', 'rc-search-count', `${reviews.length} label-search reviews for "${query}"`));
  res.appendChild(header);

  const sumBtn = el('button', 'rc-summarize-btn', `Summarize "${query}"`) as HTMLButtonElement;
  sumBtn.onclick = () => summarizeLabelSearch(sumBtn);
  res.appendChild(sumBtn);

  const questionInput = document.createElement('input');
  questionInput.type = 'text';
  questionInput.placeholder = `Ask about "${query}" reviews… (Enter)`;
  questionInput.className = 'rc-question-input';
  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') askLabelSearch();
  });
  res.appendChild(questionInput);
  cardEls.searchQuestionInput = questionInput;

  const list = el('div', 'rc-search-reviews');
  renderReviewsInto(list, reviews);
  res.appendChild(list);
};

const runLabelSearch = async () => {
  const input = cardEls.searchInput;
  const res = cardEls.searchResults;
  if (!input || !res) return;
  const query = input.value.trim();
  if (!query) {
    res.style.display = 'none';
    if (cardEls.filteredSumPanel) cardEls.filteredSumPanel.style.display = 'none';
    activeLabelSearch = null;
    return;
  }

  const featureId = getFeatureId();
  if (!featureId) return;
  const seq = ++labelSearchSeq;
  res.style.display = 'block';
  res.textContent = `Searching "${query}"…`;
  if (cardEls.filteredSumPanel) cardEls.filteredSumPanel.style.display = 'none';

  try {
    const reviews = await fetchAllForSearch(featureId, query);
    if (seq !== labelSearchSeq) return;
    activeLabelSearch = { query, reviews };
    if (!reviews.length) {
      res.textContent = `No label-search reviews for "${query}"`;
      return;
    }
    renderLabelSearchResult();
  } catch (e) {
    if (seq !== labelSearchSeq) return;
    console.error('[label search] failed', e);
    res.textContent = 'Label search failed';
  }
};

const summarizeLabelSearch = async (btn?: HTMLButtonElement) => {
  const search = activeLabelSearch;
  const panel = cardEls.filteredSumPanel;
  if (!search || !panel) return;
  const texts = textReviewsFor(search.reviews);
  panel.style.display = 'block';
  panel.textContent = 'Summarizing…';
  panel.className = 'rc-summary-panel loading';
  if (!texts.length) {
    panel.textContent = 'No review text available';
    panel.className = 'rc-summary-panel';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Summarizing…'; }
  try {
    const result = await summarizeReviews(texts, search.query, null);
    if (typeof result === 'object') {
      search.summary = result;
      panel.className = 'rc-summary-panel';
      renderSummary(panel, result);
    }
  } catch (e) {
    console.error('[label search] summary failed', e);
    panel.textContent = 'Summarization failed';
    panel.className = 'rc-summary-panel';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = `Summarize "${search.query}"`; }
  }
};

const askLabelSearch = async () => {
  const search = activeLabelSearch;
  const panel = cardEls.filteredSumPanel;
  const q = cardEls.searchQuestionInput?.value?.trim();
  if (!search || !panel || !q) return;
  const texts = textReviewsFor(search.reviews);
  panel.style.display = 'block';
  panel.textContent = 'Asking…';
  panel.className = 'rc-summary-panel loading';
  if (!texts.length) { panel.textContent = 'No review text available'; panel.className = 'rc-summary-panel'; return; }
  try {
    const result = await summarizeReviews(texts, search.query, q);
    panel.className = 'rc-summary-panel';
    renderSummary(panel, result);
    if (cardEls.searchQuestionInput) cardEls.searchQuestionInput.value = '';
  } catch (e) {
    console.error('[label search] ask failed', e);
    panel.textContent = 'Ask failed';
    panel.className = 'rc-summary-panel';
  }
};

const createUIElements = () => {
  const c = el('div'); c.id = 'reviews-container';

  const header = el('div', 'rc-header');
  const title = el('span', 'rc-title');
  title.appendChild(el('span', 'rc-dot'));
  title.appendChild(document.createTextNode('Review Analysis'));
  header.appendChild(title);
  const headerRight = el('div', 'rc-header-right');
  const select = document.createElement('select'); select.id = 'rc-period';
  ([['total', 'Total'], ['inPastYear', 'Past Year'], ['inPastMonth', 'Past Month']] as const).forEach(([v, t]) => {
    const opt = document.createElement('option'); opt.value = v; opt.textContent = t; select.appendChild(opt);
  });
  select.onchange = (e) => { currentOption = (e.target as HTMLSelectElement).value as Period; updateUI(); };
  headerRight.appendChild(select);
  const collapseBtn = el('button', 'rc-collapse');
  collapseBtn.textContent = '▾';
  collapseBtn.onclick = () => {
    const collapsed = c.classList.toggle('collapsed');
    collapseBtn.textContent = collapsed ? '▸' : '▾';
  };
  headerRight.appendChild(collapseBtn);
  header.appendChild(headerRight);
  c.appendChild(header);

  const card = el('div', 'rc-card');
  const head = el('div', 'rc-card-head');
  head.appendChild(el('span', 'rc-card-label', 'Review Score'));
  const countEl = el('span', 'rc-card-count');
  head.appendChild(countEl);
  card.appendChild(head);
  const pctEl = el('div', 'rc-card-pct', '—');
  card.appendChild(pctEl);
  const tooltip = el('div', 'rc-tooltip');
  pctEl.appendChild(tooltip);
  const bar = el('div', 'rc-card-bar');
  const barFill = el('div', 'rc-card-bar-fill');
  bar.appendChild(barFill);
  card.appendChild(bar);
  const diffEl = el('div', 'rc-card-diff');
  card.appendChild(diffEl);
  const detailEl = el('div', 'rc-card-detail');
  card.appendChild(detailEl);
  c.appendChild(card);
  cardEls.merged = { card, pctEl, barFill, countEl, diffEl, detailEl, tooltip };

  const hlSec = el('div', 'rc-highlights-section');
  const hlHeader = el('div', 'rc-highlights-header');
  const hlTitleWrap = el('div', 'rc-highlights-title-wrap');
  hlTitleWrap.appendChild(el('span', 'rc-highlights-title', 'Highlights'));
  const hlStale = el('span', 'rc-highlights-stale', 'stale');
  hlStale.title = 'New reviews since these were computed';
  hlStale.style.display = 'none';
  hlTitleWrap.appendChild(hlStale);
  hlHeader.appendChild(hlTitleWrap);
  const hlBtn = el('button', 'rc-highlights-btn', 'Compute Highlights') as HTMLButtonElement;
  hlBtn.type = 'button';
  hlBtn.onclick = () => computeHighlights(!!highlightsState);
  hlHeader.appendChild(hlBtn);
  hlSec.appendChild(hlHeader);
  const hlList = el('div', 'rc-highlights-list');
  hlSec.appendChild(hlList);
  c.appendChild(hlSec);
  cardEls.highlightsSection = hlSec;
  cardEls.highlightsList = hlList;
  cardEls.highlightsBtn = hlBtn;
  cardEls.highlightsStale = hlStale;
  if (highlightsState && highlightsState.items.length) renderHighlights();

  const searchSec = el('div', 'rc-search-section');
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Label search… wifi OR parking (Enter)';
  searchInput.className = 'rc-search-input';
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runLabelSearch();
  });
  searchInput.addEventListener('input', () => {
    if (!searchInput.value.trim()) {
      activeLabelSearch = null;
      if (cardEls.searchResults) cardEls.searchResults.style.display = 'none';
      if (cardEls.filteredSumPanel) cardEls.filteredSumPanel.style.display = 'none';
    }
  });
  searchSec.appendChild(searchInput);
  cardEls.searchInput = searchInput;
  const searchResults = el('div', 'rc-search-results');
  searchResults.style.display = 'none';
  searchSec.appendChild(searchResults);
  const filteredSumPanel = el('div', 'rc-summary-panel');
  filteredSumPanel.style.display = 'none';
  searchSec.appendChild(filteredSumPanel);
  c.appendChild(searchSec);
  cardEls.searchResults = searchResults;
  cardEls.filteredSumPanel = filteredSumPanel;

  const sumPanel = el('div', 'rc-summary-panel');
  sumPanel.style.display = summaryCache.all ? 'block' : 'none';
  c.appendChild(sumPanel);
  cardEls.sumPanel = sumPanel;
  if (summaryCache.all) renderSummary(sumPanel, summaryCache.all);

  const sumRow = el('div', 'rc-sum-row');
  const sumBtn = el('button', 'rc-summarize-btn', 'Summarize') as HTMLButtonElement;
  sumBtn.onclick = () => triggerSummarize();
  sumRow.appendChild(sumBtn);
  const resumBtn = el('button', 'rc-resummarize-btn', '↻') as HTMLButtonElement;
  resumBtn.type = 'button';
  resumBtn.title = 'Re-summarize';
  resumBtn.onclick = () => triggerSummarize();
  sumRow.appendChild(resumBtn);
  c.appendChild(sumRow);
  cardEls.sumBtn = sumBtn;
  cardEls.resumBtn = resumBtn;

  const questionInput = document.createElement('input');
  questionInput.type = 'text';
  questionInput.placeholder = 'Ask about this place… (Enter to ask)';
  questionInput.className = 'rc-question-input';
  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sumBtn.click();
  });
  questionInput.addEventListener('input', refreshSumBtnState);
  c.appendChild(questionInput);
  cardEls.questionInput = questionInput;
  refreshSumBtnState();

  const chipPanel = el('div', 'rc-chip-panel');
  chipPanel.style.display = 'none';
  const chipHeader = el('div', 'rc-chip-panel-header');
  const chipTitle = el('span', 'rc-chip-panel-title');
  const chipSumBtn = el('button', 'rc-summarize-btn rc-chip-panel-btn', 'Summarize') as HTMLButtonElement;
  chipSumBtn.type = 'button';
  chipSumBtn.onclick = () => summarizeActiveChip();
  const chipCloseBtn = el('button', 'rc-chip-panel-close', '✕') as HTMLButtonElement;
  chipCloseBtn.type = 'button';
  chipCloseBtn.onclick = closeChipPanel;
  chipHeader.appendChild(chipTitle);
  chipHeader.appendChild(chipSumBtn);
  chipHeader.appendChild(chipCloseBtn);
  chipPanel.appendChild(chipHeader);
  const chipQuestionInput = document.createElement('input');
  chipQuestionInput.type = 'text';
  chipQuestionInput.placeholder = 'Ask about these reviews… (Enter)';
  chipQuestionInput.className = 'rc-question-input';
  chipQuestionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') askActiveChip();
  });
  chipPanel.appendChild(chipQuestionInput);
  const chipBody = el('div', 'rc-chip-body');
  chipPanel.appendChild(chipBody);
  c.appendChild(chipPanel);
  cardEls.chipPanel = chipPanel;
  cardEls.chipPanelTitle = chipTitle;
  cardEls.chipPanelBody = chipBody;
  cardEls.chipSummarizeBtn = chipSumBtn;
  cardEls.chipCloseBtn = chipCloseBtn;
  cardEls.chipQuestionInput = chipQuestionInput;

  document.body.appendChild(c);
};

const updateUI = () => {
  const { totalCount, totalAll, totalTrusted, mergedPct } = getMergedStats();
  let anyFetching = false, allDone = true;
  for (const k of SORT_KEYS) {
    if (scores[k].isFetching) anyFetching = true;
    if (!scores[k].done) allDone = false;
  }
  if (!totalCount || !document.querySelector('.jANrlb')) return;
  if (!document.querySelector('#reviews-container')) createUIElements();

  const els = cardEls.merged;
  if (!els) return;

  const fullPct = calculateFullPercentage();
  const noData = totalAll === 0 && currentOption !== 'total';

  if (noData) {
    els.pctEl.childNodes[0].textContent = '—';
    els.pctEl.style.color = '#888';
    els.pctEl.style.textShadow = 'none';
    els.tooltip.textContent = 'No reviews in this period';
    els.barFill.style.width = '0%';
    els.diffEl.style.display = 'none';
  } else {
    const mergedRound = toPct(mergedPct);
    els.pctEl.childNodes[0].textContent = `${mergedRound}%`;
    const sortTotal = (k: SortKey) =>
      scores[k].reviewData.totalReviews[currentOption] || cachedScoreState?.[k].totalReviews[currentOption] || 0;
    const relLabel = sortTotal('relevant') ? `${getRoundedPct('relevant')}%` : '—';
    const newLabel = sortTotal('newest') ? `${getRoundedPct('newest')}%` : '—';
    els.tooltip.textContent = `Relevant: ${relLabel} · Newest: ${newLabel}`;

    if (fullPct !== null) {
      const diff = mergedRound - fullPct;
      const color = getDiffColor(diff);
      els.pctEl.style.color = color;
      els.pctEl.style.textShadow = `0 0 24px ${color}40`;
      const sign = diff > 0 ? '+' : '';
      els.diffEl.textContent = `${sign}${diff}% vs overall`;
      els.diffEl.style.color = color;
      els.diffEl.style.display = '';
    } else {
      const color = getAbsoluteScoreColor(mergedPct);
      els.pctEl.style.color = color;
      els.pctEl.style.textShadow = `0 0 24px ${color}40`;
      els.diffEl.style.display = 'none';
      if (!fullPctObserver) {
        fullPctObserver = new MutationObserver(() => {
          if (calculateFullPercentage() !== null) {
            fullPctObserver!.disconnect();
            fullPctObserver = null;
            updateUI();
          }
        });
        const target = document.querySelector('.jANrlb') || document.body;
        fullPctObserver.observe(target, { childList: true, subtree: true });
      }
    }

    els.barFill.style.width = `${Math.max(2, Math.min(100, (mergedPct + 1) / 2 * 100))}%`;
  }

  els.countEl.textContent = String(totalCount);
  const headReview = liveNewestHeadReview();
  const parts = [
    totalAll > 0 ? `${totalTrusted} trusted of ${totalAll}` : '',
    headReview?.timestamp ? `newest review ${timeAgo(headReview.timestamp / 1000)}` : '',
  ].filter(Boolean);
  const detailText = parts.join(' · ');
  if (detailText !== els.detailEl.textContent) els.detailEl.textContent = detailText;
  els.card.classList.toggle('loading', anyFetching);
  els.card.classList.toggle('done', allDone);
};

const renderSummary = (panel: HTMLElement, result: SummaryResult | string) => {
  panel.textContent = '';
  panel.className = 'rc-summary-panel';
  panel.style.display = 'block';
  if (typeof result === 'string') {
    const answer = el('div', 'rc-answer');
    renderMarkdown(answer, result);
    panel.appendChild(answer);
    return;
  }
  if (result.verdict) {
    const verdict = el('div', 'rc-verdict');
    renderMarkdown(verdict, result.verdict);
    panel.appendChild(verdict);
  }
  if (result.highlights?.length) {
    for (const h of result.highlights) {
      const row = el('div', `rc-highlight ${h.sentiment}`);
      const text = el('span', 'rc-h-text');
      renderMarkdownInline(text, h.text ?? '');
      row.appendChild(text);
      panel.appendChild(row);
    }
  }
  if (result.valueForMoney) {
    const v = Math.max(1, Math.min(5, result.valueForMoney));
    panel.appendChild(el('div', 'rc-value', `Value for money: ${'★'.repeat(v)}${'☆'.repeat(5 - v)}`));
  }
  if (!result.highlights?.length && !result.verdict) {
    panel.textContent = 'No highlights found';
  }
};

const collectReviewTexts = (): string[] => textReviewsFor(Object.values(mergeReviewMaps()));

const refreshSumBtnState = () => {
  const btn = cardEls.sumBtn;
  if (!btn) return;
  const hasQuestion = !!cardEls.questionInput?.value?.trim();
  const cached = !!summaryCache.all;
  btn.textContent = hasQuestion ? 'Ask' : 'Summarize';
  btn.disabled = !hasQuestion && cached;
  if (cardEls.resumBtn) {
    cardEls.resumBtn.hidden = hasQuestion || !cached;
    cardEls.resumBtn.disabled = false;
  }
};

const triggerSummarize = async () => {
  const panel = cardEls.sumPanel;
  if (!panel) return;
  panel.style.display = 'block';
  panel.textContent = 'Summarizing…';
  panel.className = 'rc-summary-panel loading';

  const texts = collectReviewTexts();
  if (!texts.length) { panel.textContent = 'No review text available'; panel.className = 'rc-summary-panel'; return; }

  if (cardEls.sumBtn) cardEls.sumBtn.disabled = true;
  if (cardEls.resumBtn) cardEls.resumBtn.disabled = true;
  const customQuestion = cardEls.questionInput?.value?.trim() || null;
  try {
    const result = await summarizeReviews(texts, null, customQuestion);
    if (!customQuestion && typeof result !== 'string') {
      summaryCache.all = result;
      saveSummaryCache();
      pushContribution({ summary: result });
    }
    renderSummary(panel, result);
  } catch (e) {
    console.error('[Reviews] Summarize error:', e);
    panel.textContent = 'Summarization failed';
    panel.className = 'rc-summary-panel';
  } finally {
    refreshSumBtnState();
  }
};

const observer = new MutationObserver(() => {
  const url = location.href;

  const placeDetails = document.querySelector<HTMLElement>('.dmRWX');
  if (placeDetails && !placeDetails.querySelector('.truescore-simple-score')) {
    injectSimpleScore(placeDetails);
  }

  if (url === lastUrl) return;
  lastUrl = url;

  const featureId = getFeatureId();
  if (!featureId) {
    document.querySelector('#reviews-container')?.remove();
    clearCardEls();
    activeLabelSearch = null;
    labelSearchSeq++;
    return;
  }

  if (featureId !== lastFeatureId) {
    lastFeatureId = featureId;
    resetScores();
    loadSummaryCache();
    loadHighlightsCache();
    activeLabelSearch = null;
    labelSearchSeq++;
    document.querySelector('#reviews-container')?.remove();
    clearCardEls();
    startFetching();
    hydrateFromCloud(featureId);
    // Skip if any live data already arrived — a stale disk read must not
    // clobber a fresh in-memory result.
    loadScoreCache(featureId).then((entry) => {
      if (!entry || getFeatureId() !== featureId || cachedScoreState) return;
      if (Object.keys(mergeReviewMaps()).length > 0) return;
      cachedScoreState = entry;
      if (isFullyHydrated(entry)) {
        // Restore reviewData too — otherwise the live refetch's dedup-skip of
        // cached reviews leaves them out of per-sort aggregates.
        const pickFrom = (ids: string[]) => {
          const out: Record<string, Review> = {};
          for (const id of ids) {
            const r = entry.reviews[id];
            if (r) out[id] = r;
          }
          return out;
        };
        scores.relevant.reviewMap = pickFrom(entry.relevantIds);
        scores.newest.reviewMap = pickFrom(entry.newestIds);
        scores.relevant.reviewData = structuredClone(entry.relevant);
        scores.newest.reviewData = structuredClone(entry.newest);
      }
      updateUI();
    }).catch((e) => console.warn('[gmaps] load score cache failed', e));
  }
  if (!document.querySelector('#reviews-container')) {
    updateUI();
    if (!scores.relevant.isFetching && !scores.relevant.done) startFetching();
  }
});

observer.observe(document.body, { childList: true, subtree: true });
