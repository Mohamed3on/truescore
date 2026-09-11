import { test, expect } from 'bun:test';
import { cache, type CacheEntry } from './cache';
import type { ScoreResult } from './gmaps';
import type { Summary } from './llm';

// Only entry.score.totalReviews is read by scoreUsable, so a partial cast is enough.
const entry = (totalReviews: number) => ({ score: { totalReviews } } as unknown as CacheEntry);

test('scoreUsable: a cached 0-review score is usable only when the histogram confirms 0', () => {
  expect(cache.scoreUsable(entry(0), 0)).toBe(true); // histogram confirms genuinely empty
  expect(cache.scoreUsable(entry(0), 500)).toBe(false); // histogram shows reviews → throttle
  expect(cache.scoreUsable(entry(0), null)).toBe(false); // histogram unknown (preview failed / dead FID) → don't trust
  expect(cache.scoreUsable(entry(0), undefined)).toBe(false);
});

test('scoreUsable: a cached non-empty score is always usable, whatever the histogram', () => {
  for (const t of [null, undefined, 0, 9999] as Array<number | null | undefined>) {
    expect(cache.scoreUsable(entry(42), t)).toBe(true);
  }
});

// --- read-through store: sqlite is the store, the resident Map is a bounded window ---

const scoreOf = (featureId: string, reviews: number): ScoreResult => ({
  featureId,
  totalReviews: reviews,
  trustedReviews: reviews,
  scorePct: 90,
  relevant: { totalReviews: reviews, trustedReviews: reviews, scorePct: 90 },
  newest: { totalReviews: reviews, trustedReviews: reviews, scorePct: 90 },
  reviews: [],
});

// More entries than the resident cap (200), so the earliest ones are guaranteed to
// have been evicted from the in-memory window by the time we read them back.
const IDS = Array.from({ length: 205 }, (_, i) => `read-through-test-${i}`);
for (const [i, id] of IDS.entries()) await cache.putScore(id, `Place ${i}`, scoreOf(id, 10), 10);

test('get() reads through to sqlite for entries evicted from the resident window', () => {
  const first = cache.get(IDS[0]!);
  expect(first?.name).toBe('Place 0');
  expect(first?.score.totalReviews).toBe(10);
});

test('all() lists every place, not just the resident window', () => {
  const listed = cache.all().filter((p) => p.featureId.startsWith('read-through-test-'));
  expect(listed).toHaveLength(IDS.length);
  expect(listed.find((p) => p.featureId === IDS[0])).toMatchObject({ name: 'Place 0', scorePct: 90 });
});

test('a patch applied to an evicted entry preserves the data still on disk', async () => {
  await cache.putSummary(IDS[1]!, { text: 'x' } as unknown as Summary);
  const entry = cache.get(IDS[1]!);
  expect(entry?.name).toBe('Place 1'); // survived the read-modify-write
  expect(entry?.summary).toBeDefined();
});

// Chips got the "never trust a 0" rule the score path already had.
const chip = (label: string, count: number, fetched?: number) =>
  ({ label, token: `t-${label}`, count, fetched, score: { totalReviews: fetched ?? 0, trustedReviews: 0, scorePct: 0 } }) as any;

test('putHighlights drops chips a throttle emptied, and marks the set short', async () => {
  const fid = 'thr-1';
  await cache.putScore(fid, 'Test Place', { featureId: fid, totalReviews: 10, trustedReviews: 5, scorePct: 40, relevant: { totalReviews: 10, trustedReviews: 5, scorePct: 40 }, newest: { totalReviews: 10, trustedReviews: 5, scorePct: 40 }, reviews: [] } as unknown as ScoreResult, 10);

  await cache.putHighlights(fid, [chip('good', 12, 12), chip('throttled', 8, 0)]);
  const entry = cache.get(fid)!;

  expect(entry.highlights?.map((h) => h.label)).toEqual(['good']);
  expect(entry.highlightsPartial).toBe(true);
  // Short sets aren't served — the missing topic comes back on the next request
  // instead of rendering red at 0% until the review count drifts.
  expect(cache.highlightsServable(entry)).toBe(false);
});

test('a chip Google itself says is empty is kept — count 0 is not a throttle', async () => {
  const fid = 'thr-2';
  await cache.putScore(fid, 'Test Place', { featureId: fid, totalReviews: 10, trustedReviews: 5, scorePct: 40, relevant: { totalReviews: 10, trustedReviews: 5, scorePct: 40 }, newest: { totalReviews: 10, trustedReviews: 5, scorePct: 40 }, reviews: [] } as unknown as ScoreResult, 10);

  await cache.putHighlights(fid, [chip('good', 12, 12), chip('genuinely-empty', 0, 0)]);
  const entry = cache.get(fid)!;

  expect(entry.highlights?.map((h) => h.label)).toEqual(['good', 'genuinely-empty']);
  expect(entry.highlightsPartial).toBeUndefined();
  expect(cache.highlightsServable(entry)).toBe(true);
});

test('an all-throttled pass persists nothing rather than blanking the panel', async () => {
  const fid = 'thr-3';
  await cache.putScore(fid, 'Test Place', { featureId: fid, totalReviews: 10, trustedReviews: 5, scorePct: 40, relevant: { totalReviews: 10, trustedReviews: 5, scorePct: 40 }, newest: { totalReviews: 10, trustedReviews: 5, scorePct: 40 }, reviews: [] } as unknown as ScoreResult, 10);

  await cache.putHighlights(fid, [chip('a', 5, 12)]);
  await cache.putHighlights(fid, [chip('a', 5, 0), chip('b', 9, 0)]);

  expect(cache.get(fid)!.highlights?.map((h) => h.label)).toEqual(['a']);
});

const stat = (n: number, pct = 80) => ({ totalReviews: n, trustedReviews: n, scorePct: pct });
const scrape = (fid: string, relevant: number, newest: number): ScoreResult =>
  ({ featureId: fid, ...stat(relevant + newest), relevant: stat(relevant), newest: stat(newest), reviews: [] });

test('a scrape with one sort empty is a throttle, not a score', async () => {
  expect(await cache.putScore('part-1', 'P', scrape('part-1', 200, 0), 5000)).toBe(false);
  expect(cache.get('part-1')).toBeUndefined();
  expect(cache.scoreUsable({ score: scrape('x', 200, 0) } as CacheEntry, 5000)).toBe(false);
  expect(await cache.putScore('part-1', 'P', scrape('part-1', 200, 150), 5000)).toBe(true);
});

test('putScore never blanks a stored name', async () => {
  await cache.putScore('name-1', 'Kept Name', scrape('name-1', 10, 10), 20);
  await cache.putScore('name-1', '', scrape('name-1', 10, 10), 20); // a bare ?q=&ftid= link
  expect(cache.get('name-1')?.name).toBe('Kept Name');
});

test('searches: an empty result is never cached, and a cached one expires', async () => {
  const search = (n: number, ts = Date.now()) => ({ query: 'pho', totalReviews: n, trustedReviews: n, scorePct: 50, reviews: [], ts });
  await cache.putScore('search-1', 'S', scrape('search-1', 10, 10), 20);
  await cache.putSearch('search-1', 'Pho', search(0)); // what a credless / stale session returns
  expect(cache.get('search-1')?.searches?.pho).toBeUndefined();
  await cache.putSearch('search-1', 'Pho', search(4));
  expect(cache.searchServable(cache.get('search-1')?.searches?.pho)).toBe(true);
  expect(cache.searchServable(search(4, Date.now() - 25 * 3600_000))).toBe(false);
  expect(cache.searchServable(search(0))).toBe(false); // a legacy cached empty
});

test('a preview with no place data keeps the good meta, and a readable one re-stamps the histogram', async () => {
  const fid = 'preview-1';
  await cache.putScore(fid, 'P', scrape(fid, 10, 10), 300);
  const meta = { canonicalName: 'P', removedReviews: { text: '21 to 50 reviews removed', min: 21, max: 50 } };
  await cache.putPreviewBundle(fid, { histogram: [200, 40, 20, 10, 30], meta, chips: [] });
  const stamped = cache.get(fid)!.histogramTs!;
  await cache.putPreviewBundle(fid, { histogram: null, meta: {}, chips: [] });
  expect(cache.get(fid)!.meta).toEqual(meta);
  const realNow = Date.now;
  Date.now = () => realNow() + 7 * 3600_000; // past the 6h TTL
  try {
    await cache.putPreviewBundle(fid, { histogram: [200, 40, 20, 10, 30], meta, chips: [] }); // unchanged
    expect(cache.get(fid)!.histogramTs).toBeGreaterThan(stamped);
    expect(cache.histogramFresh(cache.get(fid)!)).toBe(true);
  } finally {
    Date.now = realNow;
  }
});

test('a set missing a known chip is short, and never replaces a complete one', async () => {
  const fid = 'chips-1';
  await cache.putScore(fid, 'C', scrape(fid, 10, 10), 20);
  const metas = ['a', 'b', 'c', 'd', 'e'].map((l) => ({ token: `t-${l}`, label: l, count: 5 }));
  await cache.recordChipWarm(fid, metas);
  // Two chips threw, so only three were scored: short, not served.
  await cache.putHighlights(fid, ['a', 'b', 'c'].map((l) => chip(l, 5, 5)));
  expect(cache.highlightsServable(cache.get(fid)!)).toBe(false);
  await cache.putHighlights(fid, ['a', 'b', 'c', 'd', 'e'].map((l) => chip(l, 5, 5)));
  expect(cache.highlightsServable(cache.get(fid)!)).toBe(true);
  // A later short set — a throw, or an extension contribution — keeps the full one.
  await cache.putContribution(fid, 'C', { highlights: [chip('a', 5, 5)] });
  expect(cache.get(fid)!.highlights).toHaveLength(5);
});

test('a contribution-only stub lists its contributed score, not a placeholder 0', async () => {
  const score = { featureId: 'stub-1', ...stat(412, 87), ratio: 0.87, relevant: stat(300, 85), newest: stat(200, 90) };
  await cache.putContribution('stub-1', 'Extension Place', { score });
  const row = cache.all().find((p) => p.featureId === 'stub-1')!;
  expect(row.scorePct).toBe(87);
  expect(Date.now() - row.lastAccessTs).toBeLessThan(60_000);
  // A stub with no score of any kind has nothing to list.
  await cache.putContribution('stub-2', 'Summary Only', { summary: { text: 'x' } as unknown as Summary });
  expect(cache.all().find((p) => p.featureId === 'stub-2')).toBeUndefined();
});
