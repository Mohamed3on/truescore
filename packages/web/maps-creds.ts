import { homedir } from 'os';
import { chmodSync } from 'fs';
import type { MapsCreds } from '@truescore/gmaps-shared';
import { setGoogleCookieOverride } from './browser';

// Botguard creds for the ListUgcPosts batchexecute RPC (the legacy GET endpoint
// is retired and the server has no browser JS to mint an x-maps-bgkey itself).
// The extension seeds a live set — bgkey + the matching google.com cookies — via
// POST /api/maps-creds. We hold them in memory AND mirror the last set to disk:
// the web auto-deploys on every push, and each restart would otherwise blank the
// session until the next Maps visit re-seeds. bgkey and cookies persist as one
// coupled blob — the token only validates against the session that minted it.
const SEED_PATH = process.env.TRUESCORE_MAPS_CREDS_PATH || `${homedir()}/.truescore-maps-creds.json`;

type Seed = { bgkey: string; bgbind: string; sessionId: string; at: string; cookies: string };
type PersistedSeed = Seed & { ts: number };

let cached: MapsCreds | null = null;
let seededAt: number | null = null;

export function setMapsCreds(creds: MapsCreds): void {
  cached = creds;
}

const apply = (s: Seed): void => {
  setMapsCreds({ bgkey: s.bgkey, bgbind: s.bgbind, sessionId: s.sessionId, at: s.at, hl: 'en' });
  setGoogleCookieOverride(s.cookies);
};

// A fresh seed from the extension: apply in memory, then mirror to disk (0600 —
// it carries a logged-in Google session) so it survives the next restart.
export async function applySeed(seed: Seed): Promise<void> {
  apply(seed);
  seededAt = Date.now();
  await Bun.write(SEED_PATH, JSON.stringify({ ...seed, ts: seededAt } satisfies PersistedSeed));
  try { chmodSync(SEED_PATH, 0o600); } catch {}
  console.log(`[maps-creds] seeded bgkey …${seed.bgkey.slice(-6)} (${seed.cookies.length}b cookies) at ${new Date(seededAt).toISOString()}`);
}

// Reload the last seed on boot so a deploy/restart doesn't serve empty until the
// next Maps visit. Best-effort: a missing/corrupt file just leaves us credless.
export async function loadPersistedSeed(): Promise<void> {
  try {
    const f = Bun.file(SEED_PATH);
    if (!(await f.exists())) return;
    const s = (await f.json()) as PersistedSeed;
    if (!s?.bgkey || !s.cookies) return;
    apply(s);
    seededAt = typeof s.ts === 'number' ? s.ts : null;
    console.log(`[maps-creds] restored seed from disk, bgkey …${s.bgkey.slice(-6)}, last seeded ${seededAt ? new Date(seededAt).toISOString() : '?'}`);
  } catch (e) {
    console.warn('[maps-creds] failed to restore seed', e);
  }
}

// null when unconfigured — callers degrade to an empty score rather than throw,
// so a creds-less deploy behaves like the (already review-less) status quo until
// the extension seeds, instead of erroring the whole lookup.
export function getMapsCreds(): MapsCreds | null {
  if (cached) return cached;
  const bgkey = process.env.TRUESCORE_MAPS_BGKEY;
  const bgbind = process.env.TRUESCORE_MAPS_BGBIND;
  const sessionId = process.env.TRUESCORE_MAPS_SESSION;
  const at = process.env.TRUESCORE_MAPS_AT;
  if (bgkey && bgbind && sessionId && at) {
    cached = { bgkey, bgbind, sessionId, at, hl: 'en' };
    return cached;
  }
  return null;
}

// Liveness + age for the GET probe on /api/maps-creds. Never returns the secrets
// themselves — just whether we have a session and how old the last seed is.
export function mapsCredsStatus(): { hasCreds: boolean; seededAt: string | null; ageMinutes: number | null } {
  return {
    hasCreds: !!getMapsCreds(),
    seededAt: seededAt ? new Date(seededAt).toISOString() : null,
    ageMinutes: seededAt ? Math.round((Date.now() - seededAt) / 60000) : null,
  };
}
