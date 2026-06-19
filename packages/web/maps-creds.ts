import { homedir } from 'os';
import { dirname, join } from 'path';
import { writeFileSync, renameSync } from 'fs';
import type { MapsCreds } from '@truescore/gmaps-shared';
import { setGoogleCookieOverride } from './browser';
import { mintMapsCreds } from './maps-minter';

// Botguard creds for the ListUgcPosts batchexecute RPC (the legacy GET endpoint
// is retired and the server has no browser JS to mint an x-maps-bgkey itself).
// The extension seeds a live set — bgkey + the matching google.com cookies — via
// POST /api/maps-creds. We hold them in memory AND mirror the last set to disk:
// the web auto-deploys on every push, and each restart would otherwise blank the
// session until the next Maps visit re-seeds. bgkey and cookies persist as one
// coupled blob — the token only validates against the session that minted it.
// Live next to the cookies file (TRUESCORE_COOKIES_PATH → /var/lib/truescore on
// the box) so the coupled bgkey+cookies session persists in the same managed
// state dir, not the service user's home; fall back to the home dir for local
// dev. TRUESCORE_MAPS_CREDS_PATH overrides outright.
const COOKIES_PATH = process.env.TRUESCORE_COOKIES_PATH;
const SEED_PATH =
  process.env.TRUESCORE_MAPS_CREDS_PATH ||
  (COOKIES_PATH ? join(dirname(COOKIES_PATH), 'maps-creds.json') : `${homedir()}/.truescore-maps-creds.json`);

// One session: bgkey/bgbind/sessionId/at coupled to the cookies that minted it.
// The minter produces it, applySeed persists it. Exported so maps-minter shares
// the shape instead of redeclaring it.
export type Seed = { bgkey: string; bgbind: string; sessionId: string; at: string; cookies: string };
type PersistedSeed = Seed & { ts: number };

let cached: MapsCreds | null = null;
let seededAt: number | null = null;
// The cookies the live session was seeded with — kept so the headless minter can
// renew the bgkey against them without a manual reseed.
let cookieStr: string | null = null;
// Banner health: true while the session is usable OR self-renewal is keeping up.
// Flipped false ONLY when a renewal attempt fails (or we're credless) — NOT on a
// single stale RPC, which just triggers a renewal. (Keying the banner on per-RPC
// staleness flapped it on transient proxy blips while reviews still worked.)
let renewOk = true;

export function setMapsCreds(creds: MapsCreds): void {
  cached = creds;
}

const apply = (s: Seed): void => {
  setMapsCreds({ bgkey: s.bgkey, bgbind: s.bgbind, sessionId: s.sessionId, at: s.at, hl: 'en' });
  setGoogleCookieOverride(s.cookies);
  cookieStr = s.cookies;
  renewOk = true;
};

// Write the seed atomically at 0600: create a fresh temp at that mode, then
// rename over the target, so the real file — a logged-in Google session — never
// exists world-readable (no chmod-after-write window). New temp each call, so
// the mode always applies on creation.
const persistSeed = (data: PersistedSeed): void => {
  const tmp = `${SEED_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, SEED_PATH);
};

// A fresh seed from the extension: apply in memory, then mirror to disk so it
// survives the next restart. The in-memory seed is what serves reviews, so a
// disk failure is logged loudly (never swallowed) but doesn't fail the seed.
export function applySeed(seed: Seed): void {
  apply(seed);
  seededAt = Date.now();
  try {
    persistSeed({ ...seed, ts: seededAt });
  } catch (e) {
    console.error('[maps-creds] failed to persist seed to disk — in-memory seed still active, but it will not survive a restart', e);
  }
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

// The transport calls these from the actual review-RPC outcome (see gmaps.ts).
// A stale reply only *triggers a renewal* — it deliberately doesn't flip the
// banner, since one bad reply is usually transient and the renewal (or the next
// good reply) resolves it. A good reply proves the session works.
export function onStaleRpc(): void { void renewSession('stale-detected'); }
export function onFreshRpc(): void { renewOk = true; }
export function mapsSessionHealthy(): boolean { return !!getMapsCreds() && renewOk; }

// --- self-renewal: mint a fresh bgkey via headless Chrome (maps-minter) ---
// The cookies outlive the bgkey by months, so as long as we have them we re-mint
// instead of needing an extension reseed. One coordinator owns both throttles:
// the cooldown (collapses a stale-storm to one attempt; `force` bypasses it for
// the operator endpoint) and, one layer down, mintMapsCreds's own single-flight.
const RENEW_COOLDOWN_MS = 60_000;
let lastRenewAttempt = 0;

export async function renewSession(reason: string, force = false): Promise<boolean> {
  if (!cookieStr) { console.warn(`[maps-creds] cannot renew (${reason}) — no cookies; needs an extension reseed`); renewOk = false; return false; }
  if (!force && Date.now() - lastRenewAttempt < RENEW_COOLDOWN_MS) return false;
  lastRenewAttempt = Date.now();
  console.log(`[maps-creds] renewing session via headless mint (${reason})…`);
  const minted = await mintMapsCreds(cookieStr);
  if (!minted) { console.warn(`[maps-creds] renew failed (${reason}) — banner shows until the cookies are refreshed`); renewOk = false; return false; }
  applySeed(minted); // sets renewOk = true
  console.log(`[maps-creds] session renewed (${reason})`);
  return true;
}

// Proactive path: refresh on a timer so the bgkey rarely expires mid-lookup,
// but skip the launch when the session was already refreshed within the interval
// (by an extension reseed or a reactive mint) — no point re-minting a fresh key.
// Tunable via TRUESCORE_MINT_INTERVAL_MIN (0 disables); env-tuned once the TTL is known.
export function startRenewTimer(): void {
  const min = Number(process.env.TRUESCORE_MINT_INTERVAL_MIN ?? 30);
  if (!(min > 0)) { console.log('[maps-creds] proactive renew disabled'); return; }
  const intervalMs = min * 60_000;
  setInterval(() => {
    if (!cookieStr || (seededAt && Date.now() - seededAt < intervalMs)) return;
    void renewSession('timer');
  }, intervalMs);
  console.log(`[maps-creds] proactive renew every ${min}min`);
}

// Liveness + age for the GET probe on /api/maps-creds. Never returns the secrets
// themselves — just whether we have a session, how old it is, and if it's stale.
export function mapsCredsStatus(): { hasCreds: boolean; healthy: boolean; stale: boolean; seededAt: string | null; ageMinutes: number | null } {
  return {
    hasCreds: !!getMapsCreds(),
    healthy: mapsSessionHealthy(),
    stale: !renewOk,
    seededAt: seededAt ? new Date(seededAt).toISOString() : null,
    ageMinutes: seededAt ? Math.round((Date.now() - seededAt) / 60000) : null,
  };
}
