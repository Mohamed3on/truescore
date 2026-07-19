// Async key/value cache backed by IndexedDB. Same {data, ts} + TTL contract as
// shared/cache.ts, but with a multi-hundred-MB quota instead of localStorage's
// ~5MB — so the bulky data that accumulates without bound (Goodreads scores one
// entry per candidate book) never has to be evicted. Reads degrade to null and
// writes to no-ops if IndexedDB is unavailable, so callers just re-fetch.

const DB_NAME = 'truescore';
const STORE = 'cache';

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> =>
  (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // A transient open failure shouldn't disable IDB for the whole session.
  }).catch((e) => { dbPromise = null; throw e; }));

const run = <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> =>
  openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = op(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );

export const idbGet = async (key: string, ttl: number): Promise<any> => {
  try {
    const entry = await run<{ data: any; ts: number } | undefined>('readonly', (s) => s.get(key));
    if (!entry) return null;
    if (Date.now() - entry.ts > ttl) { idbDel(key); return null; }
    return entry.data;
  } catch { return null; }
};

export const idbSet = async (key: string, data: any): Promise<void> => {
  try { await run('readwrite', (s) => s.put({ data, ts: Date.now() }, key)); } catch {}
};

export const idbDel = (key: string): void => {
  run('readwrite', (s) => s.delete(key)).catch(() => {});
};
