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
  try { localStorage.setItem(key, raw); return; } catch {}

  // Quota hit: scan once for the oldest cache entries (those carrying a numeric
  // `ts`) and drop them in batches until the write fits. Values without a `ts`
  // (Q&A history, rate-limit counters) are small and left alone.
  const entries: { key: string; ts: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    try {
      const ts = JSON.parse(localStorage.getItem(k) || '{}')?.ts;
      if (typeof ts === 'number') entries.push({ key: k, ts });
    } catch {}
  }
  entries.sort((a, b) => a.ts - b.ts);
  const batch = Math.max(1, Math.ceil(entries.length / 4));
  for (let i = 0; i < entries.length; i += batch) {
    for (let j = i; j < i + batch && j < entries.length; j++) localStorage.removeItem(entries[j].key);
    try { localStorage.setItem(key, raw); return; } catch {}
  }
};
