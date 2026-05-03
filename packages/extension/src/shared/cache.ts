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
  try { localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch {}
};
