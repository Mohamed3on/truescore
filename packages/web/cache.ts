import { db, DB_PATH, LEGACY_JSON_PATH } from './db';
import type { ScoreResult } from './gmaps';
import type { Summary } from './llm';
import { displayScore, type Chip, type ChipMeta, type Histogram, type PartialScore, type PlaceMeta, type RemovedReviews } from '@truescore/gmaps-shared';

const HISTOGRAM_TTL_MS = 6 * 60 * 60 * 1000;
// How long a background chip-warm that came back empty is trusted as "this place
// genuinely has no topic chips" before we bother harvesting again.
const CHIP_WARM_TTL_MS = 6 * 60 * 60 * 1000;

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
  highlights?: Chip[];
  highlightsTs?: number;
  // Set when the last scoring pass lost chips to a throttle, so the cached set is
  // short. Serving it would pin the missing topics out of the panel forever.
  highlightsPartial?: boolean;
  // Unscored topic chips harvested from the preview RPC. Cached so /api/highlights
  // can score them without a second preview fetch. Last non-empty set wins.
  chipMeta?: ChipMeta[];
  // When the last background chip-warm completed (success or give-up). With an
  // empty chipMeta it marks a place as recently-confirmed topic-less, so we
  // don't re-harvest on every poll. See chipWarmedEmpty.
  chipWarmTs?: number;
  highlightSummaries?: Record<string, Summary>; // keyed by token
  searches?: Record<string, SearchResult>; // keyed by lowercase query
  histogram?: number[];
  histogramTs?: number;
  meta?: PlaceMeta;
  // A score the extension computed and contributed. Deliberately NOT `score` +
  // `scoreTs`: those mean "the server scraped this", and conflating them would
  // let a contribution suppress the scrape and be served as authoritative
  // forever. This one only ever paints a provisional number while our own
  // scrape runs.
  contributedScore?: PartialScore;
  contributedScoreTs?: number;
  lastAccessTs?: number;
  accessCount?: number;
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

db.run('CREATE TABLE IF NOT EXISTS entries (featureId TEXT PRIMARY KEY, data TEXT NOT NULL)');

const upsertStmt = db.prepare<void, [string, string]>('INSERT OR REPLACE INTO entries (featureId, data) VALUES (?, ?)');
const selectOneStmt = db.prepare<{ data: string }, [string]>('SELECT data FROM entries WHERE featureId = ?');
// Only the /api/places listing fields, projected in sqlite — so building the
// listing never materialises the full entries (see IndexRow below).
type IndexProjection = {
  featureId: string;
  name: string;
  rawPct: number;
  resolvedUrl: string | null;
  histogramJson: string | null;
  googleReviewCount: number | null;
  removedJson: string | null;
  lastAccessTs: number;
};
const selectIndexStmt = db.prepare<IndexProjection, []>(`
  SELECT featureId,
         json_extract(data, '$.name') AS name,
         COALESCE(json_extract(data, '$.score.scorePct'), 0) AS rawPct,
         json_extract(data, '$.resolvedUrl') AS resolvedUrl,
         json_extract(data, '$.histogram') AS histogramJson,
         json_extract(data, '$.meta.googleReviewCount') AS googleReviewCount,
         json_extract(data, '$.meta.removedReviews') AS removedJson,
         COALESCE(json_extract(data, '$.lastAccessTs'), json_extract(data, '$.scoreTs'), 0) AS lastAccessTs
  FROM entries`);

// json_extract hands back nested objects/arrays as JSON text; a malformed one
// just drops out of the penalty rather than failing the whole listing.
const parseJson = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
};

// sqlite is the store; `store` is a bounded LRU window over it. Entries carry full
// review text and average ~360KB, so holding every one resident cost ~1.5GB RSS and
// grew unbounded with each new place looked up. Cap the resident set and read
// through to sqlite on a miss instead. TRUESCORE_CACHE_RESIDENT overrides.
const MAX_RESIDENT = Number(process.env.TRUESCORE_CACHE_RESIDENT ?? 200);
const store = new Map<string, CacheEntry>();

// Every place's listing fields, always resident — ~100 bytes each, so /api/places
// stays an in-memory read rather than a full-table json scan on every request.
type IndexRow = { name: string; scorePct: number; adjusted: boolean; resolvedUrl: string | null; lastAccessTs: number };
const index = new Map<string, IndexRow>();

const rowToIndex = (r: IndexProjection): IndexRow => {
  const { pct, adjusted } = displayScore({
    score: (r.rawPct ?? 0) / 100,
    histogram: parseJson<Histogram>(r.histogramJson),
    googleReviewCount: r.googleReviewCount,
    removedReviews: parseJson<RemovedReviews>(r.removedJson),
  });
  return { name: r.name, scorePct: pct, adjusted, resolvedUrl: r.resolvedUrl, lastAccessTs: r.lastAccessTs };
};

for (const row of selectIndexStmt.all()) index.set(row.featureId, rowToIndex(row));

// Map iterates in insertion order, so delete-then-set moves a key to the newest end
// and the first key is always the least-recently-used one to drop.
const remember = (featureId: string, entry: CacheEntry): void => {
  if (MAX_RESIDENT <= 0) return;
  store.delete(featureId);
  store.set(featureId, entry);
  if (store.size > MAX_RESIDENT) store.delete(store.keys().next().value!);
};

const indexEntry = (featureId: string, entry: CacheEntry): void => {
  const { pct, adjusted } = displayScore({
    score: entry.score.scorePct / 100,
    histogram: entry.histogram,
    googleReviewCount: entry.meta?.googleReviewCount,
    removedReviews: entry.meta?.removedReviews,
  });
  index.set(featureId, {
    name: entry.name,
    scorePct: pct,
    adjusted,
    resolvedUrl: entry.resolvedUrl ?? null,
    lastAccessTs: entry.lastAccessTs ?? entry.scoreTs,
  });
};

// Read through the resident window to sqlite. A corrupt row is dropped rather than
// thrown, so one bad entry can't fail every lookup (as the old boot loop guarded).
const read = (featureId: string): CacheEntry | undefined => {
  const hit = store.get(featureId);
  if (hit) { remember(featureId, hit); return hit; }
  const row = selectOneStmt.get(featureId);
  if (!row) return undefined;
  try {
    const entry = JSON.parse(row.data) as CacheEntry;
    remember(featureId, entry);
    return entry;
  } catch (e) {
    console.error(`[cache] skip corrupt row ${featureId}:`, e);
    return undefined;
  }
};

// One-shot migration: legacy JSON file → sqlite. Runs only on a fresh DB so a
// stale JSON sitting next to the live DB can't clobber newer entries.
if (index.size === 0) {
  try {
    const f = Bun.file(LEGACY_JSON_PATH);
    if (await f.exists()) {
      const json = await f.json() as Record<string, CacheEntry>;
      const tx = db.transaction((entries: [string, CacheEntry][]) => {
        for (const [id, entry] of entries) upsertStmt.run(id, JSON.stringify(entry));
      });
      const list = Object.entries(json);
      tx(list);
      for (const [id, entry] of list) indexEntry(id, entry);
      console.log(`[cache] migrated ${list.length} entries from ${LEGACY_JSON_PATH} → ${DB_PATH}`);
    }
  } catch (e) {
    console.error('[cache] legacy JSON migration failed:', e);
  }
}

const persist = (featureId: string, entry: CacheEntry) => {
  remember(featureId, entry);
  indexEntry(featureId, entry);
  upsertStmt.run(featureId, JSON.stringify(entry));
};

const emptyStat = { totalReviews: 0, trustedReviews: 0, scorePct: 0 };
const emptyScore = (featureId: string): ScoreResult => ({
  featureId, totalReviews: 0, trustedReviews: 0, scorePct: 0,
  relevant: emptyStat, newest: emptyStat, reviews: [],
});

// Persist a stub if the place hasn't been looked up yet, so the existing
// putX methods (which all guard `if (!existing) return`) can apply their
// patches without needing an upsert variant. Revalidate replaces the
// zero-score with real data on the next /api/lookup.
const ensureEntry = (featureId: string, name: string): void => {
  if (index.has(featureId)) return;
  persist(featureId, { name, score: emptyScore(featureId), scoreTs: 0 });
};

// A 0-review scrape is only a trustworthy "review-less place" result when the live
// histogram CONFIRMS zero (liveTotal === 0). If the histogram shows reviews
// (liveTotal > 0) the empty is a throttle — Google's 200 + empty body. If the
// histogram is unknown (null/undefined — the preview fetch failed, or the featureId
// is dead) we can't confirm the place is genuinely empty. In both cases don't trust
// the 0 — never persist or serve it — so a transient preview failure can't poison the
// cache with a false 0.
const isThrottledScrape = (totalReviews: number, liveTotal: number | null | undefined): boolean =>
  totalReviews === 0 && liveTotal !== 0;

// A chip Google said carries reviews (count > 0) that came back with none is the
// same 200-with-empty-body throttle putScore refuses to trust — scoreHighlight
// has already retried it once on a fresh proxy exit. Persisting it freezes that
// topic at 0% (rendered red, and wrong) until the place's review count drifts
// past the 1% revalidate threshold. `fetched === 0` strictly: a producer that
// never set the field is not making a claim about a throttle.
const chipThrottled = (h: Chip): boolean => h.fetched === 0 && h.count > 0;

export const cache = {
  get(featureId: string): CacheEntry | undefined {
    return read(featureId);
  },
  // Cached entry is fresh iff the place's total review count is unchanged
  // since we last computed. If we don't know the live total (histogram fetch
  // failed), trust the cache. If we have no baseline (legacy entry), refetch.
  scoreFresh(entry: CacheEntry, currentTotal?: number | null): boolean {
    if (currentTotal == null) return true;
    if (entry.totalReviewsAtCache == null) return false;
    return entry.totalReviewsAtCache === currentTotal;
  },
  // A cached 0-review score is only usable when the live histogram confirms zero; if
  // it shows reviews (throttle) or is unknown (preview failed), treat it as unusable
  // so revalidate re-scrapes instead of serving a possibly-false 0.
  scoreUsable(entry: CacheEntry, currentTotal?: number | null): boolean {
    return !isThrottledScrape(entry.score.totalReviews, currentTotal);
  },
  histogramFresh(entry: CacheEntry): boolean {
    return !!entry.histogramTs && Date.now() - entry.histogramTs < HISTOGRAM_TTL_MS;
  },
  // Returns false when a 0-review scrape can't be confirmed genuine (histogram shows
  // reviews = throttle, or histogram unknown = preview failed / dead featureId):
  // nothing is persisted, so the prior entry stands and the next lookup retries.
  async putScore(featureId: string, name: string, score: ScoreResult, totalReviewsAtCache: number | null, resolvedUrl?: string): Promise<boolean> {
    const existing = read(featureId);
    if (isThrottledScrape(score.totalReviews, totalReviewsAtCache)) return false;
    persist(featureId, {
      ...existing,
      name,
      resolvedUrl: resolvedUrl ?? existing?.resolvedUrl,
      score,
      scoreTs: Date.now(),
      totalReviewsAtCache: totalReviewsAtCache ?? existing?.totalReviewsAtCache,
      lastAccessTs: existing?.lastAccessTs ?? Date.now(),
      accessCount: existing?.accessCount ?? 1,
    });
    return true;
  },
  async touch(featureId: string) {
    const existing = read(featureId);
    if (!existing) return;
    persist(featureId, {
      ...existing,
      lastAccessTs: Date.now(),
      accessCount: (existing.accessCount ?? 1) + 1,
    });
  },
  all(): Array<{ featureId: string } & IndexRow> {
    return Array.from(index, ([featureId, row]) => ({ featureId, ...row }));
  },
  async putSummary(featureId: string, summary: Summary) {
    const existing = read(featureId);
    if (!existing) return;
    persist(featureId, { ...existing, summary, summaryTs: Date.now() });
  },
  // Cached chips are servable only when the last pass wasn't cut short. Before
  // this, `highlights` had no freshness rule at all — highlightsTs was written
  // and never read — so a throttled set was served unchanged forever.
  highlightsServable(entry: CacheEntry): boolean {
    return !!entry.highlights?.length && !entry.highlightsPartial;
  },
  async putHighlights(featureId: string, highlights: Chip[]) {
    const existing = read(featureId);
    if (!existing) return;
    const usable = highlights.filter((h) => !chipThrottled(h));
    if (!usable.length) return;
    persist(featureId, {
      ...existing,
      highlights: usable,
      highlightsTs: Date.now(),
      highlightsPartial: usable.length < highlights.length || undefined,
    });
  },
  async putHighlightSummary(featureId: string, token: string, summary: Summary) {
    const existing = read(featureId);
    if (!existing) return;
    const highlightSummaries = { ...(existing.highlightSummaries ?? {}), [token]: summary };
    persist(featureId, { ...existing, highlightSummaries });
  },
  async putSearch(featureId: string, query: string, result: SearchResult) {
    const existing = read(featureId);
    if (!existing) return;
    const searches = { ...(existing.searches ?? {}), [query.toLowerCase()]: result };
    persist(featureId, { ...existing, searches });
  },
  async putContribution(featureId: string, name: string, patch: {
    summary?: Summary;
    highlights?: Chip[];
    highlightSummaries?: Record<string, Summary>;
    score?: PartialScore;
  }) {
    ensureEntry(featureId, name);
    if (patch.summary) await this.putSummary(featureId, patch.summary);
    if (patch.highlights) await this.putHighlights(featureId, patch.highlights);
    if (patch.highlightSummaries) {
      for (const [token, summary] of Object.entries(patch.highlightSummaries)) {
        await this.putHighlightSummary(featureId, token, summary);
      }
    }
    if (patch.score) await this.putContributedScore(featureId, patch.score);
  },
  // A 0-review contribution is the extension's own throttle/empty state, never
  // worth painting — drop it rather than flashing "0 reviews" at the next visitor.
  async putContributedScore(featureId: string, score: PartialScore) {
    const existing = read(featureId);
    if (!existing || score.totalReviews <= 0) return;
    persist(featureId, { ...existing, contributedScore: score, contributedScoreTs: Date.now() });
  },
  // Record a background chip-warm outcome: cache the harvested set (stable
  // tokens) and stamp the attempt time. An empty result stamps the time only,
  // so chipWarmedEmpty can suppress re-harvesting a topic-less place for a while.
  async recordChipWarm(featureId: string, chips: ChipMeta[]) {
    const existing = read(featureId);
    if (!existing) return;
    const next: CacheEntry = { ...existing, chipWarmTs: Date.now() };
    if (chips.length) next.chipMeta = chips;
    persist(featureId, next);
  },
  // True when a recent background warm found no chips — treat the place as
  // genuinely topic-less rather than harvesting again on every poll. Cleared
  // naturally once a warm does cache chips (chipMeta becomes non-empty).
  chipWarmedEmpty(entry: CacheEntry): boolean {
    return !entry.chipMeta?.length && entry.chipWarmTs != null && Date.now() - entry.chipWarmTs < CHIP_WARM_TTL_MS;
  },
  async putPreviewBundle(featureId: string, bundle: { histogram: number[] | null; meta: PlaceMeta; chips?: ChipMeta[] }) {
    const existing = read(featureId);
    if (!existing) return;
    const next: CacheEntry = { ...existing, meta: bundle.meta };
    // Keep the last non-empty chip set: a later empty A-B bucket mustn't wipe good chips.
    if (bundle.chips?.length) next.chipMeta = bundle.chips;
    const histogramChanged = bundle.histogram &&
      (!existing.histogram || existing.histogram.some((v, i) => v !== bundle.histogram![i]));
    if (histogramChanged) {
      next.histogram = bundle.histogram!;
      next.histogramTs = Date.now();
    }
    persist(featureId, next);
  },
};
