import { test, expect } from 'bun:test';
import { cache, type CacheEntry } from './cache';

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
