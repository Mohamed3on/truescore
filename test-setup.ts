// Registers a DOM (document/window/Element…) for `bun test` so the extension's
// DOM-touching modules (e.g. the score-grid ranker) can be tested. Additive —
// the pure web/gmaps-shared tests are unaffected.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

GlobalRegistrator.register();

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
