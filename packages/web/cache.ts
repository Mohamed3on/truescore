import { db, DB_PATH, LEGACY_JSON_PATH } from './db';
import type { ScoreResult } from './gmaps';
import type { Summary } from './llm';
import { displayScore, type Chip, type ChipMeta, type Histogram, type PartialScore, type PlaceMeta, type RemovedReviews, type SortStats } from '@truescore/gmaps-shared';

const HISTOGRAM_TTL_MS = 6 * 60 * 60 * 1000;
// How long a cached review search is served before it's re-run.
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
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
  canonicalName: string | null;
  resolvedUrl: string | null;
  scoreTs: number | null;
  scorePct: number | null;
  ratio: number | null;
  contributedJson: string | null;
  contributedScoreTs: number | null;
  lastAccessTs: number | null;
  histogramJson: string | null;
  googleReviewCount: number | null;
  removedJson: string | null;
};
const selectIndexStmt = db.prepare<IndexProjection, []>(`
  SELECT featureId,
         json_extract(data, '$.name') AS name,
         json_extract(data, '$.meta.canonicalName') AS canonicalName,
         json_extract(data, '$.resolvedUrl') AS resolvedUrl,
         json_extract(data, '$.scoreTs') AS scoreTs,
         json_extract(data, '$.score.scorePct') AS scorePct,
         json_extract(data, '$.score.ratio') AS ratio,
         json_extract(data, '$.contributedScore') AS contributedJson,
         json_extract(data, '$.contributedScoreTs') AS contributedScoreTs,
         json_extract(data, '$.lastAccessTs') AS lastAccessTs,
         json_extract(data, '$.histogram') AS histogramJson,
         json_extract(data, '$.meta.googleReviewCount') AS googleReviewCount,
         json_extract(data, '$.meta.removedReviews') AS removedJson
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
// null: the place exists but has no score to list.
type IndexRow = { name: string; scorePct: number; adjusted: boolean; resolvedUrl: string | null; lastAccessTs: number };
const index = new Map<string, IndexRow | null>();

// What the listing reads off an entry: the full CacheEntry, or the projection
// above rebuilt into its shape — so both paths go through one toIndexRow.
type ListedScore = Pick<SortStats, 'scorePct' | 'ratio'>;
type Listable = {
  name: string;
  resolvedUrl?: string | null;
  scoreTs?: number | null;
  score?: ListedScore | null;
  contributedScore?: ListedScore | null;
  contributedScoreTs?: number | null;
  lastAccessTs?: number | null;
  histogram?: Histogram | null;
  meta?: { canonicalName?: string | null; googleReviewCount?: number | null; removedReviews?: RemovedReviews | null } | null;
};

const toIndexRow = (e: Listable): IndexRow | null => {
  // A contribution-only stub (scoreTs 0) holds a placeholder 0 we never computed:
  // list the extension's contributed score instead, or nothing at all.
  const score = e.scoreTs === 0 ? e.contributedScore : e.score;
  if (!score) return null;
  const { pct, adjusted } = displayScore({
    score,
    histogram: e.histogram,
    googleReviewCount: e.meta?.googleReviewCount,
    removedReviews: e.meta?.removedReviews,
  });
  return {
    // A name blanked by a bare ?q=&ftid= link reads back from the preview.
    name: e.name || e.meta?.canonicalName || '',
    scorePct: pct,
    adjusted,
    resolvedUrl: e.resolvedUrl ?? null,
    lastAccessTs: e.lastAccessTs || e.scoreTs || e.contributedScoreTs || 0,
  };
};

const rowToIndex = (r: IndexProjection): IndexRow | null => toIndexRow({
  ...r,
  score: { scorePct: r.scorePct ?? 0, ratio: r.ratio ?? undefined },
  contributedScore: parseJson<ListedScore>(r.contributedJson),
  histogram: parseJson<Histogram>(r.histogramJson),
  meta: { canonicalName: r.canonicalName, googleReviewCount: r.googleReviewCount, removedReviews: parseJson<RemovedReviews>(r.removedJson) },
});

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
  index.set(featureId, toIndexRow(entry));
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
// cache with a false 0. A scrape with reviews but one sort empty is the same
// throttle hitting that sort — both sorts page the same reviews — and caching it
// served "Newest 0%" as authoritative. (Legacy rows may lack the sorts.)
const isThrottledScrape = (score: Pick<ScoreResult, 'totalReviews' | 'relevant' | 'newest'>, liveTotal: number | null | undefined): boolean =>
  score.totalReviews === 0
    ? liveTotal !== 0
    : score.relevant?.totalReviews === 0 || score.newest?.totalReviews === 0;

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
  // so revalidate re-scrapes instead of serving a possibly-false 0. Same for a
  // score with one sort empty.
  scoreUsable(entry: CacheEntry, currentTotal?: number | null): boolean {
    return !isThrottledScrape(entry.score, currentTotal);
  },
  histogramFresh(entry: CacheEntry): boolean {
    return !!entry.histogramTs && Date.now() - entry.histogramTs < HISTOGRAM_TTL_MS;
  },
  // Returns false when a 0-review scrape can't be confirmed genuine (histogram shows
  // reviews = throttle, or histogram unknown = preview failed / dead featureId):
  // nothing is persisted, so the prior entry stands and the next lookup retries.
  async putScore(featureId: string, name: string, score: ScoreResult, totalReviewsAtCache: number | null, resolvedUrl?: string): Promise<boolean> {
    const existing = read(featureId);
    if (isThrottledScrape(score, totalReviewsAtCache)) return false;
    persist(featureId, {
      ...existing,
      // Never blank a name: a bare ?q=&ftid= link — the home tile of a place we
      // only know from an extension contribution — carries none.
      name: name || existing?.name || '',
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
  // Every place with a score to list: ours, or a stub's contributed one.
  all(): Array<{ featureId: string } & IndexRow> {
    return [...index].flatMap(([featureId, row]) => (row ? [{ featureId, ...row }] : []));
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
    // Short = missing any chip we know the place has: emptied by a throttle here,
    // or never scored at all — a chip that threw, or one an extension
    // contribution left out (it posts only the chips that succeeded).
    const partial = usable.length < Math.max(highlights.length, existing.chipMeta?.length ?? 0);
    // A short set never replaces a complete one: it wouldn't be served, so
    // writing it would only throw the good set away.
    if (partial && this.highlightsServable(existing)) return;
    persist(featureId, {
      ...existing,
      highlights: usable,
      highlightsTs: Date.now(),
      highlightsPartial: partial || undefined,
    });
  },
  async putHighlightSummary(featureId: string, token: string, summary: Summary) {
    const existing = read(featureId);
    if (!existing) return;
    const highlightSummaries = { ...(existing.highlightSummaries ?? {}), [token]: summary };
    persist(featureId, { ...existing, highlightSummaries });
  },
  // Served only while recent and non-empty: `ts` used to be written and never
  // read, so a search was served unchanged forever — and rows cached before
  // putSearch refused empties still hold them.
  searchServable(s: SearchResult | undefined): s is SearchResult {
    return !!s?.totalReviews && Date.now() - s.ts < SEARCH_TTL_MS;
  },
  // Never trust a zero: an empty search is what a credless or stale session
  // hands back (fetchAllForSearch serves [] rather than throw). Cached, it hid
  // the term — and the summary's auto-scored chip, which never forces — from
  // every visitor for good. A term that truly matches nothing costs one cheap
  // RPC to re-ask.
  async putSearch(featureId: string, query: string, result: SearchResult) {
    const existing = read(featureId);
    if (!existing || !result.totalReviews) return;
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
    const next: CacheEntry = { ...existing };
    // Keep the last non-empty meta and chip set: a later shot with no place data
    // (an A-B bucket, a throttle) mustn't wipe them — nor, with the removal
    // notice, the penalty.
    if (Object.values(bundle.meta).some((v) => v != null)) next.meta = bundle.meta;
    if (bundle.chips?.length) next.chipMeta = bundle.chips;
    // A readable histogram is a successful preview: stamp it even when unchanged,
    // or every lookup past the TTL refetches.
    if (bundle.histogram) {
      next.histogram = bundle.histogram;
      next.histogramTs = Date.now();
    }
    persist(featureId, next);
  },
};
