import { homedir } from 'os';
import { Database } from 'bun:sqlite';
import type { ScoreResult } from './gmaps';
import type { Summary } from './gemini';
import type { Highlight } from './highlights';
import type { PlaceMeta } from './histogram';

const LEGACY_JSON_PATH = process.env.TRUESCORE_CACHE_PATH || `${homedir()}/.truescore-cache.json`;
const DB_PATH = process.env.TRUESCORE_CACHE_DB_PATH || LEGACY_JSON_PATH.replace(/\.json$/, '') + '.sqlite';
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
  meta?: PlaceMeta;
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

const db = new Database(DB_PATH, { create: true });
db.run('PRAGMA journal_mode = WAL');
db.run('CREATE TABLE IF NOT EXISTS entries (featureId TEXT PRIMARY KEY, data TEXT NOT NULL)');

const upsertStmt = db.prepare<void, [string, string]>('INSERT OR REPLACE INTO entries (featureId, data) VALUES (?, ?)');
const selectAllStmt = db.prepare<{ featureId: string; data: string }, []>('SELECT featureId, data FROM entries');

const store = new Map<string, CacheEntry>();
for (const row of selectAllStmt.all()) {
  try { store.set(row.featureId, JSON.parse(row.data)); }
  catch (e) { console.error(`[cache] skip corrupt row ${row.featureId}:`, e); }
}

// One-shot migration: legacy JSON file → sqlite. Runs only on a fresh DB so a
// stale JSON sitting next to the live DB can't clobber newer entries.
if (store.size === 0) {
  try {
    const f = Bun.file(LEGACY_JSON_PATH);
    if (await f.exists()) {
      const json = await f.json() as Record<string, CacheEntry>;
      const tx = db.transaction((entries: [string, CacheEntry][]) => {
        for (const [id, entry] of entries) upsertStmt.run(id, JSON.stringify(entry));
      });
      const list = Object.entries(json);
      tx(list);
      for (const [id, entry] of list) store.set(id, entry);
      console.log(`[cache] migrated ${list.length} entries from ${LEGACY_JSON_PATH} → ${DB_PATH}`);
    }
  } catch (e) {
    console.error('[cache] legacy JSON migration failed:', e);
  }
}

const persist = (featureId: string, entry: CacheEntry) => {
  store.set(featureId, entry);
  upsertStmt.run(featureId, JSON.stringify(entry));
};

export const cache = {
  get(featureId: string): CacheEntry | undefined {
    return store.get(featureId);
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
    const existing = store.get(featureId);
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
  },
  async touch(featureId: string) {
    const existing = store.get(featureId);
    if (!existing) return;
    persist(featureId, {
      ...existing,
      lastAccessTs: Date.now(),
      accessCount: (existing.accessCount ?? 1) + 1,
    });
  },
  all(): Array<{ featureId: string } & CacheEntry> {
    return Array.from(store, ([featureId, entry]) => ({ featureId, ...entry }));
  },
  async putSummary(featureId: string, summary: Summary) {
    const existing = store.get(featureId);
    if (!existing) return;
    persist(featureId, { ...existing, summary, summaryTs: Date.now() });
  },
  async putHighlights(featureId: string, highlights: Highlight[]) {
    const existing = store.get(featureId);
    if (!existing) return;
    persist(featureId, { ...existing, highlights, highlightsTs: Date.now() });
  },
  async putHighlightSummary(featureId: string, token: string, summary: Summary) {
    const existing = store.get(featureId);
    if (!existing) return;
    const highlightSummaries = { ...(existing.highlightSummaries ?? {}), [token]: summary };
    persist(featureId, { ...existing, highlightSummaries });
  },
  async putSearch(featureId: string, query: string, result: SearchResult) {
    const existing = store.get(featureId);
    if (!existing) return;
    const searches = { ...(existing.searches ?? {}), [query.toLowerCase()]: result };
    persist(featureId, { ...existing, searches });
  },
  async putPreviewBundle(featureId: string, bundle: { histogram: number[] | null; meta: PlaceMeta }) {
    const existing = store.get(featureId);
    if (!existing) return;
    const next: CacheEntry = { ...existing, meta: bundle.meta };
    const histogramChanged = bundle.histogram &&
      (!existing.histogram || existing.histogram.some((v, i) => v !== bundle.histogram![i]));
    if (histogramChanged) {
      next.histogram = bundle.histogram!;
      next.histogramTs = Date.now();
    }
    persist(featureId, next);
  },
};
