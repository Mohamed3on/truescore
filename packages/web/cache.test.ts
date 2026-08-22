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
