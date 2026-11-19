// Registers a DOM (document/window/Element…) for `bun test` so the extension's
// DOM-touching modules (e.g. the score-grid ranker) can be tested. Additive —
// the pure web/gmaps-shared tests are unaffected.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Keep Bun's own streams: happy-dom's don't pipe into native ones, which breaks
// AI SDK's stream readers (gmaps-shared runAsk).
const { ReadableStream, WritableStream, TransformStream } = globalThis;

GlobalRegistrator.register();

Object.assign(globalThis, { ReadableStream, WritableStream, TransformStream });

// db.ts resolves the sqlite path at import time, so it has to be redirected before
// any test imports it — otherwise `bun test` opens, migrates and writes to the
// developer's real ~/.truescore-cache.{json,sqlite}. Fresh file per run so the
// cache tests see a known-empty store.
if (!process.env.TRUESCORE_CACHE_DB_PATH) {
  const dbPath = join(tmpdir(), `truescore-test-${process.pid}.sqlite`);

  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  process.env.TRUESCORE_CACHE_DB_PATH = dbPath;
  process.env.TRUESCORE_CACHE_PATH ??= join(tmpdir(), `truescore-test-${process.pid}-legacy.json`);
}

// Likewise the cookie jars browser.ts and account.ts save.
process.env.TRUESCORE_COOKIES_PATH ??= join(tmpdir(), `truescore-test-${process.pid}-cookies.json`);

// The extension's chrome.storage.local (shared/cache.ts keeps everything there), in
// memory. Values are cloned in and out, as the real store serializes them.
const local = new Map<string, any>();
const keysOf = (keys?: string | string[] | null) => (keys == null ? [...local.keys()] : [keys].flat());

Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (keys?: string | string[] | null) =>
          Object.fromEntries(keysOf(keys).filter((k) => local.has(k)).map((k) => [k, structuredClone(local.get(k))])),
        set: async (items: Parameters<typeof chrome.storage.local.set>[0]) => {
          for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
        },
        remove: async (keys: string | string[]) => {
          for (const k of [keys].flat()) local.delete(k);
        },
        getKeys: async () => [...local.keys()],
        clear: async () => local.clear(),
      },
    },
  },
});
