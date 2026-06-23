// Drop the oldest cache entries (those carrying a numeric `ts`) to free room.
// Plain localStorage values without a `ts` (e.g. Q&A history, rate-limit) are skipped.
const evictOldest = (): boolean => {
  const entries: { key: string; ts: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    try {
      const ts = JSON.parse(localStorage.getItem(k) || '{}')?.ts;
      if (typeof ts === 'number') entries.push({ key: k, ts });
    } catch {}
  }
  if (!entries.length) return false;
  entries.sort((a, b) => a.ts - b.ts);
  const drop = Math.max(1, Math.ceil(entries.length / 4));
  for (let i = 0; i < drop; i++) localStorage.removeItem(entries[i].key);
  return true;
};

export const cacheGet = (key: string, ttl: number): any => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > ttl) { localStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
};

export const cacheSet = (key: string, data: any): void => {
  const raw = JSON.stringify({ data, ts: Date.now() });
  // Retry past QuotaExceededError by evicting the oldest entries until it fits.
  for (let attempt = 0; attempt < 6; attempt++) {
    try { localStorage.setItem(key, raw); return; }
    catch { if (!evictOldest()) return; }
  }
};
