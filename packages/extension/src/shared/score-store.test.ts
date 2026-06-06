import { test, expect, describe } from 'bun:test';
import { createScoreStore, type Storage } from './score-store';
import type { Review } from '@truescore/gmaps-shared';

const NOW = 1_780_000_000_000; // fixed ms clock
const DAY = 86_400_000;
// timestamp is microseconds (Google's shape); store divides by 1000 to get ms.
const rv = (id: string, daysAgo: number, stars = 5, count = 9): Review =>
  ({ reviewId: id, stars, reviewerReviewCount: count, timestamp: (NOW - daysAgo * DAY) * 1000, text: id });

const memStorage = (init: Record<string, unknown> = {}): Storage => {
  const m = new Map<string, unknown>(Object.entries(init));
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k: string, v: unknown) => { m.set(k, v); return true; },
  };
};

const newStore = (storage = memStorage()) => createScoreStore({ storage, now: () => NOW });
const KEY = 'rc_score_v2_test';

describe('newest head — the bug this module was extracted for', () => {
  test('a newer review ingested after a cache restore wins by timestamp, not insertion order', async () => {
    const storage = memStorage();
    // Build a real cache entry: old + older are the newest at cache time.
    const builder = newStore(storage);
    builder.ingest('relevant', [rv('old', 30), rv('older', 60)]);
    builder.ingest('newest', [rv('old', 30), rv('older', 60)]);
    expect(await builder.persistIfReady(KEY)).toBe(true);

    // Fresh store restores that cache (pre-seeds newest = old, older)...
    const store = newStore(storage);
    expect(await store.loadCache(KEY)).toBe(true);
    expect(store.newestHeadId()).toBe('old');

    // ...then the live refetch appends a genuinely newer review AFTER the
    // cached ones. Insertion order would still say 'old'; timestamp says 'fresh'.
    store.ingest('newest', [rv('fresh', 1)]);
    expect(store.newestHeadId()).toBe('fresh');
    expect(store.newestHeadReview()?.reviewId).toBe('fresh');
  });

  test('persistIfReady writes the timestamp head, so the next load is not stale', async () => {
    const storage = memStorage();
    const builder = newStore(storage);
    builder.ingest('newest', [rv('old', 30)]);
    builder.ingest('relevant', [rv('old', 30)]);
    await builder.persistIfReady(KEY);

    const store = newStore(storage);
    await store.loadCache(KEY);
    store.ingest('newest', [rv('fresh', 1)]);
    store.ingest('relevant', [rv('fresh', 1)]);
    await store.persistIfReady(KEY);

    const reloaded = newStore(storage);
    await reloaded.loadCache(KEY);
    expect(reloaded.newestHeadId()).toBe('fresh');
  });
});

describe('reconcile', () => {
  const seed = async () => {
    const storage = memStorage();
    const b = newStore(storage);
    b.ingest('newest', [rv('old', 30)]);
    b.ingest('relevant', [rv('old', 30)]);
    await b.persistIfReady(KEY);
    const store = newStore(storage);
    await store.loadCache(KEY);
    return store;
  };

  test('matching live head → fresh, sets servedFresh', async () => {
    const store = await seed();
    expect(store.reconcile('old')).toBe('fresh');
    expect(store.servedFresh()).toBe(true);
  });

  test('different live head → stale, drops cache so a re-persist can proceed', async () => {
    const store = await seed();
    expect(store.reconcile('fresh')).toBe('stale');
    expect(store.servedFresh()).toBe(false);
  });

  test('no cache → unknown', () => {
    expect(newStore().reconcile('anything')).toBe('unknown');
  });
});

describe('period bucketing + trust filtering', () => {
  test('mergedStats counts only in-period reviews and only trusted authors score', () => {
    const store = newStore();
    store.ingest('relevant', [
      rv('a', 5, 5, 9),   // 5d, 5★, trusted
      rv('b', 40, 1, 9),  // 40d, 1★, trusted — in past-year, not past-month
      rv('c', 5, 5, 1),   // 5d, 5★, untrusted (1 review)
    ]);

    const month = store.mergedStats('inPastMonth');
    expect(month.totalAll).toBe(2);     // a + c within 30d
    expect(month.totalTrusted).toBe(1); // c is untrusted
    expect(month.mergedPct).toBe(1);    // a (+1) / 1 trusted

    const year = store.mergedStats('inPastYear');
    expect(year.totalAll).toBe(3);
    expect(year.totalTrusted).toBe(2);  // a, b
    expect(year.mergedPct).toBe(0);     // (+1 a, -1 b) / 2
  });

  test('scorePct trust-filters per sort', () => {
    const store = newStore();
    store.ingest('newest', [rv('a', 1, 5, 9), rv('b', 1, 1, 1)]); // b untrusted
    expect(store.scorePct('newest', 'total')).toBe(1); // only a counts
  });
});

describe('loadCache guards', () => {
  test('skips when live data already arrived', async () => {
    const storage = memStorage();
    const b = newStore(storage);
    b.ingest('newest', [rv('x', 1)]);
    await b.persistIfReady(KEY);

    const store = newStore(storage);
    store.ingest('newest', [rv('live', 1)]); // live data present before the disk read resolves
    expect(await store.loadCache(KEY)).toBe(false);
    expect(store.newestHeadId()).toBe('live');
  });

  test('skips when stillValid() flipped (SPA nav)', async () => {
    const storage = memStorage({ [KEY]: { ts: NOW, relevant: {}, newest: {}, merged: {} } });
    const store = newStore(storage);
    expect(await store.loadCache(KEY, () => false)).toBe(false);
  });

  test('returns false when nothing cached', async () => {
    expect(await newStore().loadCache(KEY)).toBe(false);
  });
});

describe('persistIfReady', () => {
  test('a served-fresh whole cache is not rewritten', async () => {
    const storage = memStorage();
    const b = newStore(storage);
    b.ingest('newest', [rv('old', 30)]);
    b.ingest('relevant', [rv('old', 30)]);
    await b.persistIfReady(KEY);

    const store = newStore(storage);
    await store.loadCache(KEY);
    expect(store.reconcile('old')).toBe('fresh');
    expect(await store.persistIfReady(KEY)).toBe(false);
  });

  test('nothing live → no write', async () => {
    expect(await newStore().persistIfReady(KEY)).toBe(false);
  });

  test('reset clears everything', async () => {
    const store = newStore();
    store.ingest('newest', [rv('a', 1)]);
    store.reset();
    expect(store.hasLiveData()).toBe(false);
    expect(store.newestHeadId()).toBe(null);
  });
});
