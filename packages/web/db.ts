import { homedir } from 'os';
import { Database } from 'bun:sqlite';

// One sqlite file, shared by the score cache (cache.ts) and the session-event log
// (events.ts). Owned here so neither feature module has to re-export a raw handle.
// Path: legacy `.truescore-cache.json` → `.sqlite` sibling; TRUESCORE_CACHE_DB_PATH
// overrides. LEGACY_JSON_PATH is exported for cache.ts's one-shot JSON→sqlite migration.
export const LEGACY_JSON_PATH = process.env.TRUESCORE_CACHE_PATH || `${homedir()}/.truescore-cache.json`;
export const DB_PATH = process.env.TRUESCORE_CACHE_DB_PATH || LEGACY_JSON_PATH.replace(/\.json$/, '') + '.sqlite';
export const db = new Database(DB_PATH, { create: true });
db.run('PRAGMA journal_mode = WAL');
