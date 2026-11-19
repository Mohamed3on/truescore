import { isComputed } from './utils';
import { bridgeRequest, STORAGE_REQUEST, type BridgePayload, type StorageOp } from './gmaps-bridge-protocol';
import { CACHE_ENTRY, isLegacyHostKey, LEGACY_HOST_DB } from './cache-keys';

// TrueScore's storage: chrome.storage.local (unlimitedStorage), never the host
// page's localStorage or IndexedDB. A content script shares its page's origin
// storage, so caching there spent the site's own quota: summaries filled
// www.google.com's 5MB and Search stopped submitting. Keys are filed per host
// (`<host>|<key>`), the same split page storage gave, so amazon.de and amazon.com
// never mix and a page script talking to gmaps-bridge reaches only its own host.
// MAIN-world scripts (gmaps) have no chrome.storage and go through gmaps-bridge.

export interface Backend {
  get: (key: string) => Promise<any>;
  set: <T>(key: string, value: T) => Promise<boolean>;
  remove: (key: string) => Promise<void>;
  // Every [key, value] under a key prefix.
  entries: (prefix: string) => Promise<Array<[string, any]>>;
}

// One host's slice of chrome.storage.local. Each op degrades (null, false, [])
// once the extension reloads under the page and its context is gone.
export const hostBackend = (host: string): Backend => {
  const ns = `${host}|`;

  return {
    get: async (key) => {
      try { return (await chrome.storage.local.get(ns + key))[ns + key] ?? null; } catch { return null; }
    },
    set: async (key, value) => {
      try {
        await chrome.storage.local.set({ [ns + key]: value });

        return true;
      } catch { return false; }
    },
    remove: async (key) => {
      try { await chrome.storage.local.remove(ns + key); } catch {}
    },
    entries: async (prefix) => {
      try {
        const keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(ns + prefix));

        if (!keys.length) return [];
        const items = await chrome.storage.local.get(keys);

        return keys.map((k) => [k.slice(ns.length), items[k]]);
      } catch { return []; }
    },
  };
};

const viaBridge = <T>(op: StorageOp, payload: BridgePayload) => bridgeRequest<T>(STORAGE_REQUEST, { op, ...payload });

const bridgeBackend: Backend = {
  get: (key) => viaBridge('get', { key }),
  set: async (key, value) => (await viaBridge<boolean>('set', { key, value })) === true,
  remove: async (key) => { await viaBridge('remove', { key }); },
  entries: async (prefix) => (await viaBridge<Array<[string, any]>>('entries', { prefix })) ?? [],
};

const backend: Backend = globalThis.chrome?.storage?.local ? hostBackend(location.host) : bridgeBackend;

const settled = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// What content scripts kept in the page's own storage before this module, moved
// here and deleted there so the site gets its quota back. localStorage keys are
// ours by prefix (isLegacyHostKey); the IndexedDB database was all ours.
/* oxlint-disable no-restricted-globals -- the one place that reads page storage: to empty it */
const adoptLegacy = async (): Promise<void> => {
  try {
    await Promise.all(Object.keys(localStorage).filter(isLegacyHostKey).map(async (key) => {
      const raw = localStorage.getItem(key);
      let value: unknown = raw;

      try { value = JSON.parse(raw ?? 'null'); } catch {}

      if (value === null || await backend.set(key, value)) localStorage.removeItem(key);
    }));
  } catch {}

  try {
    if (!(await indexedDB.databases()).some((db) => db.name === LEGACY_HOST_DB)) return;
    const db = await settled(indexedDB.open(LEGACY_HOST_DB));
    const store = db.transaction('cache').objectStore('cache');
    const [keys, values] = await Promise.all([settled(store.getAllKeys()), settled(store.getAll())]);
    db.close();
    const moved = await Promise.all(keys.map((key, i) => backend.set(String(key), values[i])));

    if (moved.every(Boolean)) indexedDB.deleteDatabase(LEGACY_HOST_DB);
  } catch {}
};
/* oxlint-enable no-restricted-globals */

const ready = adoptLegacy();

// A value kept as written, with no expiry: settings, summaries, Q&A history.
export const storeGet = async (key: string): Promise<any> => {
  await ready;

  return backend.get(key);
};

export const storeSet = async <T>(key: string, value: T): Promise<boolean> => {
  await ready;

  return backend.set(key, value);
};

export const storeDel = async (key: string): Promise<void> => {
  await ready;

  return backend.remove(key);
};

/** Every stored value under a key prefix, as [key, value]. */
export const storeEntries = async (prefix: string): Promise<Array<[string, any]>> => {
  await ready;

  return backend.entries(prefix);
};

// A cache entry: { data, ts }, fresh for `ttl` after it was written, or for a TTL
// computed from its data. Stale entries are dropped on read; background.ts sweeps
// the ones never read again.

export type CacheTtl = number | ((data: any) => number);

export const cacheGet = async (key: string, ttl: CacheTtl): Promise<any> => {
  const entry = CACHE_ENTRY.safeParse(await storeGet(key));

  if (!entry.success) return null;
  const { data, ts } = entry.data;

  if (Date.now() - ts > (isComputed(ttl) ? ttl(data) : ttl)) {
    void storeDel(key);

    return null;
  }

  return data ?? null;
};

export const cacheSet = (key: string, data: any): Promise<boolean> => storeSet(key, { data, ts: Date.now() });

// Definitive fetcher misses (product genuinely has no reviews) are cached too,
// as a short-lived tombstone — hosts that recreate processed nodes would
// otherwise refire the same doomed request on every re-render batch. Transport
// failures stay uncached so transient errors retry normally.
export const NEG_TTL = 6 * 60 * 60 * 1000;

export const cacheGetMaybe = async (key: string, ttl: number): Promise<{ value: any } | null> => {
  const data = await cacheGet(key, ttl);

  if (data == null) return null;

  if (data.__none) return (await cacheGet(key, NEG_TTL)) ? { value: null } : null;

  return { value: data };
};

export const cacheSetMaybe = (key: string, data: any): Promise<boolean> =>
  cacheSet(key, data ?? { __none: true });

/**
 * Edits the cache entries under a key prefix: `edit` returns an entry's new data, null
 * to drop it, or undefined to leave it. An edited entry keeps its ts: patching never
 * extends how long it lives.
 */
export const cacheEdit = async (prefix: string, edit: (data: any, key: string) => any): Promise<void> => {
  await Promise.all((await storeEntries(prefix)).map(([key, value]) => {
    const entry = CACHE_ENTRY.safeParse(value);

    if (!entry.success) return;
    const data = edit(entry.data.data, key);

    if (data === null) return backend.remove(key);

    if (data !== undefined) return backend.set(key, { ...entry.data, data });
  }));
};

/** Every cache entry under a key prefix, as [key, data], whatever its age. */
export const cacheEntries = async (prefix: string): Promise<Array<[string, any]>> =>
  (await storeEntries(prefix)).flatMap(([key, value]): Array<[string, any]> => {
    const entry = CACHE_ENTRY.safeParse(value);

    return entry.success ? [[key, entry.data.data]] : [];
  });
