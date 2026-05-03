import { homedir } from 'os';
import type { ScoreResult } from './gmaps';
import type { Summary } from './gemini';
import type { Highlight } from './highlights';

const PATH = process.env.TRUESCORE_CACHE_PATH || `${homedir()}/.truescore-cache.json`;
const HISTOGRAM_TTL_MS = 6 * 60 * 60 * 1000;

export type CacheEntry = {
  name: string;
  resolvedUrl?: string;
  score: ScoreResult;
  scoreTs: number;
  // Total reviews on Google at the time score/highlights/summaries were last computed.
  // If the live histogram total differs from this, all review-derived caches are stale.
  totalReviewsAtCache?: number;
  summary?: Summary;
  summaryTs?: number;
  highlights?: Highlight[];
  highlightsTs?: number;
  highlightSummaries?: Record<string, Summary>; // keyed by token
  searches?: Record<string, SearchResult>; // keyed by lowercase query
  histogram?: number[];
  histogramTs?: number;
};

export type SearchResult = {
  query: string;
  totalReviews: number;
  trustedReviews: number;
  scorePct: number;
  reviews: Array<{ reviewId: string; stars: number; reviewerReviewCount: number; timestamp: number | null; text: string }>;
  summary?: Summary;
  ts: number;
};

let store: Record<string, CacheEntry> = {};

async function load() {
  try {
    const f = Bun.file(PATH);
    if (await f.exists()) store = await f.json();
  } catch (e) {
    console.error('[cache] load failed, starting empty:', e);
    store = {};
  }
}

async function flush() {
  await Bun.write(PATH, JSON.stringify(store));
}

// Both must be non-null and different. Null on either side = treat as unchanged
// (e.g. a histogram fetch failed; we don't want to needlessly invalidate).
function currentTotalChanged(prev: number | null | undefined, next: number | null | undefined): boolean {
  if (prev == null || next == null) return false;
  return prev !== next;
}

await load();

export const cache = {
  get(featureId: string): CacheEntry | undefined {
    return store[featureId];
  },
  // Cached entry is fresh iff the place's total review count is unchanged
  // since we last computed. If we don't know the live total (histogram fetch
  // failed), trust the cache. If we have no baseline (legacy entry), refetch.
  scoreFresh(entry: CacheEntry, currentTotal?: number | null): boolean {
    if (currentTotal == null) return true;
    if (entry.totalReviewsAtCache == null) return false;
    return entry.totalReviewsAtCache === currentTotal;
  },
  histogramFresh(entry: CacheEntry): boolean {
    return !!entry.histogramTs && Date.now() - entry.histogramTs < HISTOGRAM_TTL_MS;
  },
  async putScore(featureId: string, name: string, score: ScoreResult, totalReviewsAtCache: number | null, resolvedUrl?: string) {
    const existing = store[featureId];
    // If total review count changed (or we couldn't determine it before), wipe
    // all review-derived caches. Otherwise preserve summary/highlights/searches.
    const totalChanged =
      existing != null &&
      currentTotalChanged(existing.totalReviewsAtCache, totalReviewsAtCache);
    const preserved = totalChanged
      ? {}
      : {
          summary: existing?.summary,
          summaryTs: existing?.summaryTs,
          highlights: existing?.highlights,
          highlightsTs: existing?.highlightsTs,
          highlightSummaries: existing?.highlightSummaries,
          searches: existing?.searches,
        };
    store[featureId] = {
      ...preserved,
      name,
      resolvedUrl: resolvedUrl ?? existing?.resolvedUrl,
      score,
      scoreTs: Date.now(),
      totalReviewsAtCache: totalReviewsAtCache ?? existing?.totalReviewsAtCache,
      histogram: existing?.histogram,
      histogramTs: existing?.histogramTs,
    };
    await flush();
  },
  async putSummary(featureId: string, summary: Summary) {
    const existing = store[featureId];
    if (!existing) return;
    store[featureId] = { ...existing, summary, summaryTs: Date.now() };
    await flush();
  },
  async putHighlights(featureId: string, highlights: Highlight[]) {
    const existing = store[featureId];
    if (!existing) return;
    store[featureId] = { ...existing, highlights, highlightsTs: Date.now() };
    await flush();
  },
  async putHighlightSummary(featureId: string, token: string, summary: Summary) {
    const existing = store[featureId];
    if (!existing) return;
    const highlightSummaries = { ...(existing.highlightSummaries ?? {}), [token]: summary };
    store[featureId] = { ...existing, highlightSummaries };
    await flush();
  },
  async putSearch(featureId: string, query: string, result: SearchResult) {
    const existing = store[featureId];
    if (!existing) return;
    const searches = { ...(existing.searches ?? {}), [query.toLowerCase()]: result };
    store[featureId] = { ...existing, searches };
    await flush();
  },
  async putHistogram(featureId: string, histogram: number[]) {
    const existing = store[featureId];
    if (!existing) return;
    store[featureId] = { ...existing, histogram, histogramTs: Date.now() };
    await flush();
  },
};
