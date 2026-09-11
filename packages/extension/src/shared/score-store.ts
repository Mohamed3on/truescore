// The score-cache state machine, lifted out of gmaps.ts into one deep module so
// the hydrate → ingest → reconcile → persist cycle has a single owner and a real
// test surface. Storage and the clock are injected (the seam): the extension
// passes the gmaps-bridge chrome.storage proxy and Date.now; tests pass an
// in-memory map and a fixed clock. gmaps keeps the fetch lifecycle (isFetching/
// done/cursor/abort) and all DOM — this module owns only the review data,
// the per-period aggregates, the cached entry, and the freshness verdict.
import { isTrusted, starScore, type Review, type SortKey } from '@truescore/gmaps-shared';

export const TIME_PERIODS = ['total', 'inPastYear', 'inPastMonth'] as const;
export type Period = (typeof TIME_PERIODS)[number];
const SORT_KEYS: readonly SortKey[] = ['relevant', 'newest'];

export type ReviewData = {
  reviewsScores: Record<Period, number>;
  trustedReviews: Record<Period, number>;
  totalReviews: Record<Period, number>;
};

export type ScoreCacheEntry = {
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

export type MergedStats = { totalCount: number; totalAll: number; totalTrusted: number; mergedPct: number };
export type Reconcile = 'fresh' | 'stale' | 'unknown';

export type Storage = {
  get: <T>(key: string) => Promise<T | null>;
  set: (key: string, value: any) => Promise<unknown>;
};

export const makeReviewData = (): ReviewData => ({
  reviewsScores: { total: 0, inPastYear: 0, inPastMonth: 0 },
  trustedReviews: { total: 0, inPastYear: 0, inPastMonth: 0 },
  totalReviews: { total: 0, inPastYear: 0, inPastMonth: 0 },
});

const isFullyHydrated = (e: ScoreCacheEntry | null): e is FullScoreCacheEntry =>
  !!e?.reviews && !!e?.relevantIds && !!e?.newestIds && !!e?.newestHeadId;

export const createScoreStore = ({ storage, now }: { storage: Storage; now: () => number }) => {
  let reviewMap: Record<SortKey, Record<string, Review>> = { relevant: {}, newest: {} };
  // Ids this visit's live fetch returned, either sort — a cache-restored review
  // is held but not seen until a live page returns it too.
  let seen = new Set<string>();
  let cached: ScoreCacheEntry | null = null;
  let servedFresh = false;

  const classify = (timestamp: number | null): Record<Period, boolean> => {
    if (!timestamp) return { total: true, inPastYear: false, inPastMonth: false };
    const t = timestamp / 1000;
    const n = now();
    return { total: true, inPastYear: t >= n - 365 * 86400000, inPastMonth: t >= n - 30 * 86400000 };
  };

  const process = (review: Review, rd: ReviewData) => {
    const trusted = isTrusted(review.reviewerReviewCount);
    const periods = classify(review.timestamp);
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

  // Aggregates are tallied on read, against the clock now — never kept from
  // ingest time, so a review restored from cache ages out of Past Month / Past
  // Year on its own instead of keeping the bucket it had when first fetched.
  const tally = (reviews: Record<string, Review>): ReviewData => {
    const rd = makeReviewData();
    for (const id in reviews) process(reviews[id], rd);
    return rd;
  };

  // A sort's live aggregates, else the cached entry's (one without review bodies).
  const sortData = (sort: SortKey): ReviewData | undefined =>
    Object.keys(reviewMap[sort]).length ? tally(reviewMap[sort]) : cached?.[sort];

  const merge = (): Record<string, Review> => {
    const m: Record<string, Review> = {};
    for (const key of SORT_KEYS) for (const id in reviewMap[key]) if (!m[id]) m[id] = reviewMap[key][id];
    return m;
  };

  const pickFrom = (reviews: Record<string, Review>, ids: string[]): Record<string, Review> => {
    const out: Record<string, Review> = {};
    for (const id of ids) { const r = reviews[id]; if (r) out[id] = r; }
    return out;
  };

  // The newest review we pulled, by timestamp — NOT Object.keys()[0]. loadCache
  // pre-seeds newest with the cached (older) reviews and the live refetch appends
  // genuinely-newer ones after them, so insertion order would report the stale
  // cached head as "newest" even after fresh reviews land.
  const newestHeadId = (): string | null => {
    let bestId: string | null = null;
    let bestTs = -Infinity;
    for (const id in reviewMap.newest) {
      const ts = reviewMap.newest[id].timestamp ?? -Infinity;
      if (ts > bestTs) { bestTs = ts; bestId = id; }
    }
    return bestId;
  };

  const store = {
    reset() {
      reviewMap = { relevant: {}, newest: {} };
      seen = new Set();
      cached = null;
      servedFresh = false;
    },

    // Add a page of one sort, deduped by reviewId (the live copy replaces a
    // cache-restored one).
    ingest(sort: SortKey, reviews: Review[]) {
      for (const r of reviews) { reviewMap[sort][r.reviewId] = r; seen.add(r.reviewId); }
    },

    // Call once the live fetch has paged `sort` to its last page: every review
    // Google still lists has now been seen, so one this visit never fetched was
    // removed since. It goes from both sorts — left in either, the merged score
    // would keep counting it, on top of the removal penalty that already counts
    // it. The disk entry still has it, so that goes stale too.
    dropUnseen(sort: SortKey) {
      const gone = Object.keys(reviewMap[sort]).filter((id) => !seen.has(id));
      if (!gone.length) return;
      for (const key of SORT_KEYS) for (const id of gone) delete reviewMap[key][id];
      cached = null;
    },

    hasLiveData: (): boolean => SORT_KEYS.some((k) => Object.keys(reviewMap[k]).length > 0),
    mergedReviews: (): Record<string, Review> => merge(),
    servedFresh: (): boolean => servedFresh,
    newestHeadId,

    newestHeadReview(): Review | null {
      const id = newestHeadId() ?? cached?.newestHeadId;
      if (!id) return null;
      return reviewMap.newest[id] ?? cached?.reviews?.[id] ?? null;
    },

    // Compare the live newest-sort head to the cached one. Differ → drop the
    // cache as stale. Match (and cache is whole) → mark served-fresh so persist
    // skips and the caller can abort its speculative refetch.
    reconcile(liveHeadId: string): Reconcile {
      const cachedHead = cached?.newestHeadId;
      if (cachedHead && cachedHead !== liveHeadId) { cached = null; return 'stale'; }
      if (cachedHead === liveHeadId && isFullyHydrated(cached)) { servedFresh = true; return 'fresh'; }
      return 'unknown';
    },

    scorePct(sort: SortKey, period: Period): number {
      const d = sortData(sort);
      return d ? d.reviewsScores[period] / d.trustedReviews[period] || 0 : 0;
    },

    sortTotal(sort: SortKey, period: Period): number {
      return sortData(sort)?.totalReviews[period] || 0;
    },

    sortTrusted(sort: SortKey, period: Period): number {
      return sortData(sort)?.trustedReviews[period] || 0;
    },

    mergedStats(period: Period): MergedStats {
      const merged = merge();
      const liveCount = Object.keys(merged).length;
      if (liveCount === 0 && cached) {
        const m = cached.merged;
        const trusted = m.trustedReviews[period];
        return {
          totalCount: m.totalReviews.total,
          totalAll: m.totalReviews[period],
          totalTrusted: trusted,
          mergedPct: trusted ? m.reviewsScores[period] / trusted : 0,
        };
      }
      let totalAll = 0, totalTrusted = 0, totalScore = 0;
      for (const id in merged) {
        const r = merged[id];
        if (!classify(r.timestamp)[period]) continue;
        totalAll++;
        if (isTrusted(r.reviewerReviewCount)) { totalTrusted++; totalScore += starScore(r.stars); }
      }
      return { totalCount: liveCount, totalAll, totalTrusted, mergedPct: totalTrusted ? totalScore / totalTrusted : 0 };
    },

    // Hydrate from disk. Skips (returns false, mutating nothing) when live data
    // already arrived, the cache is already set, or `stillValid` flipped while
    // the async read was in flight (an SPA nav to another place).
    async loadCache(key: string, stillValid: () => boolean = () => true): Promise<boolean> {
      const entry = await storage.get<ScoreCacheEntry>(key);
      if (!entry || !stillValid() || cached || store.hasLiveData()) return false;
      cached = entry;
      if (isFullyHydrated(entry)) {
        reviewMap.relevant = pickFrom(entry.reviews, entry.relevantIds);
        reviewMap.newest = pickFrom(entry.reviews, entry.newestIds);
      }
      return true;
    },

    // Write the merged snapshot back to disk. No-ops (returns false) when a
    // served-fresh cache is already whole, when there's nothing live to persist,
    // or when nothing changed since the cached entry. Caller gates on both sorts
    // being done and on having a featureId for the key.
    async persistIfReady(key: string): Promise<boolean> {
      if (servedFresh && isFullyHydrated(cached)) return false;
      const liveMerged = merge();
      if (!Object.keys(liveMerged).length) return false;
      const newestIds = Object.keys(reviewMap.newest);
      const entry: ScoreCacheEntry = {
        ts: now(),
        newestHeadId: newestHeadId() ?? newestIds[0],
        relevant: tally(reviewMap.relevant),
        newest: tally(reviewMap.newest),
        merged: tally(liveMerged),
        reviews: liveMerged,
        relevantIds: Object.keys(reviewMap.relevant),
        newestIds,
      };
      if (isFullyHydrated(cached) &&
          cached.newestHeadId === entry.newestHeadId &&
          cached.merged.totalReviews.total === entry.merged.totalReviews.total) {
        return false;
      }
      cached = entry;
      await storage.set(key, entry);
      return true;
    },
  };
  return store;
};

export type ScoreStore = ReturnType<typeof createScoreStore>;
