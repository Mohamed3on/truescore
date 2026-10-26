import * as z from 'zod/mini';

export const cacheGet = (key: string, ttl: number): any => {
  try {
    const raw = localStorage.getItem(key);

    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);

    if (Date.now() - ts > ttl) {
      localStorage.removeItem(key);

      return null;
    }

    return data;
  } catch { return null; }
};

// Definitive fetcher misses (product genuinely has no reviews) are cached too,
// as a short-lived tombstone — hosts that recreate processed nodes would
// otherwise refire the same doomed request on every re-render batch. Transport
// failures stay uncached so transient errors retry normally.
export const NEG_TTL = 6 * 60 * 60 * 1000;

export const cacheGetMaybe = (key: string, ttl: number): { value: any } | null => {
  const data = cacheGet(key, ttl);

  if (data == null) return null;

  if (data.__none) return cacheGet(key, NEG_TTL) ? { value: null } : null;

  return { value: data };
};

export const cacheSetMaybe = (key: string, data: any): void =>
  cacheSet(key, data ?? { __none: true });

// A stored value carrying when it was cached.
const TIMED_ENTRY = z.object({ ts: z.number() });

export const cacheSet = (key: string, data: any): void => {
  const raw = JSON.stringify({ data, ts: Date.now() });

  try {
    localStorage.setItem(key, raw);

    return;
  } catch {}

  // Quota hit: scan once for the oldest cache entries (those carrying a numeric
  // `ts`) and drop them in batches until the write fits. Values without a `ts`
  // (Q&A history, rate-limit counters) are small and left alone.
  const entries: { key: string; ts: number }[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);

    if (!k) continue;

    try {
      const entry = TIMED_ENTRY.safeParse(JSON.parse(localStorage.getItem(k) || '{}'));

      if (entry.success) entries.push({ key: k, ts: entry.data.ts });
    } catch {}
  }

  entries.sort((a, b) => a.ts - b.ts);
  const batch = Math.max(1, Math.ceil(entries.length / 4));

  for (let i = 0; i < entries.length; i += batch) {
    for (let j = i; j < i + batch && j < entries.length; j++) localStorage.removeItem(entries[j]!.key);

    try {
      localStorage.setItem(key, raw);

      return;
    } catch {}
  }
};
