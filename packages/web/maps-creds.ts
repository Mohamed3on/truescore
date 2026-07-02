import { homedir } from 'os';
import { dirname, join } from 'path';
import { writeFileSync, renameSync } from 'fs';
import { type MapsCreds } from '@truescore/gmaps-shared';
import { setGoogleCookieOverride } from './browser';
import { logEvent } from './events';

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

// One session: bgkey/bgbind/sessionId/at coupled to the cookies it was captured
// with. The extension seeds it (POST /api/maps-creds); applySeed persists it.
export type Seed = { bgkey: string; bgbind: string; sessionId: string; at: string; cookies: string };
type PersistedSeed = Seed & { ts: number };

let cached: MapsCreds | null = null;
let seededAt: number | null = null;
// Banner health: true while reviews load. Flipped false only when review RPCs come
// back empty even after the transport's retries (a genuinely expired session that
// needs a reseed), and true again on the next good reply — so a transient throttle
// (which the retries absorb) doesn't flap it.
let renewOk = true;

// Flip session health, logging only real transitions — renewOk is touched on every
// good/bad RPC, so a raw assignment would be per-RPC noise; we want the edges.
const setRenewOk = (v: boolean, reason: string): void => {
  if (v === renewOk) return;
  renewOk = v;
  logEvent('health', { renewOk: v, reason });
};

export function setMapsCreds(creds: MapsCreds): void {
  cached = creds;
}

const apply = (s: Seed): void => {
  setMapsCreds({ bgkey: s.bgkey, bgbind: s.bgbind, sessionId: s.sessionId, at: s.at, hl: 'en' });
  setGoogleCookieOverride(s.cookies);
  setRenewOk(true, 'apply');
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
export function applySeed(seed: Seed, src: 'extension' | 'mint' = 'extension'): void {
  apply(seed);
  seededAt = Date.now();
  try {
    persistSeed({ ...seed, ts: seededAt });
  } catch (e) {
    console.error('[maps-creds] failed to persist seed to disk — in-memory seed still active, but it will not survive a restart', e);
  }
  console.log(`[maps-creds] seeded bgkey …${seed.bgkey.slice(-6)} (${seed.cookies.length}b cookies) at ${new Date(seededAt).toISOString()}`);
  logEvent('seed', { src, bgkey: seed.bgkey.slice(-6), cookieBytes: seed.cookies.length });
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
    logEvent('seed', { src: 'disk', bgkey: s.bgkey.slice(-6), cookieBytes: s.cookies.length });
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

// The transport calls these from the actual review-RPC outcome (see gmaps.ts),
// AFTER its own retries. A stale reply (reviews empty even on retry) triggers a fresh
// mint; a good reply proves the session works. The mint is anonymous — no extension,
// no human. A good reply doesn't itself flip the banner; renewSession owns that.
export function onStaleRpc(): void { void renewSession('stale-detected'); }
export function onFreshRpc(): void { setRenewOk(true, 'fresh-rpc'); }
export function mapsSessionHealthy(): boolean { return !!getMapsCreds() && renewOk; }

// --- self-mint: refresh the bgkey via a stealth-cloaked headless browser ---
// Google serves an automated browser a review-less page UNLESS it's cloaked by
// puppeteer-extra-plugin-stealth (see maps-minter). mintMapsCreds captures a fresh
// ANONYMOUS session, so the server keeps itself seeded with no human and no extension.
// A cooldown collapses a stale-storm to one attempt (force bypasses it for the timer /
// operator endpoint); mintMapsCreds has its own single-flight one layer down.
const RENEW_COOLDOWN_MS = 60_000;
const RESEED_ALERT_COOLDOWN_MS = 10 * 60_000;
let lastRenewAttempt = 0;
let lastReseedAlert = 0;

export async function renewSession(reason: string, force = false): Promise<boolean> {
  if (!force && Date.now() - lastRenewAttempt < RENEW_COOLDOWN_MS) return false;
  lastRenewAttempt = Date.now();
  console.log(`[maps-creds] minting a fresh session (${reason})…`);
  // Lazy-load the minter so puppeteer-extra + the stealth evasion graph stay out of
  // the boot path — they're only needed the handful of times a day we actually mint.
  const { mintMapsCreds } = await import('./maps-minter');
  const minted = await mintMapsCreds();
  if (!minted) {
    setRenewOk(false, `mint-failed:${reason}`);
    // Stealth is an arms race; if minting starts failing, an extension reseed is the
    // fallback. Alert once per episode rather than on every stale RPC.
    if (Date.now() - lastReseedAlert >= RESEED_ALERT_COOLDOWN_MS) {
      lastReseedAlert = Date.now();
      logEvent('needs-reseed', { note: 'auto-mint failed — extension reseed as fallback' });
      console.warn('[maps-creds] auto-mint failed — falling back to extension reseed');
    }
    return false;
  }
  applySeed(minted, 'mint'); // sets renewOk = true
  console.log(`[maps-creds] session renewed (${reason})`);
  return true;
}

// Hands-off engine: mint on boot if we have no creds, then refresh on a timer well
// inside the ~day a session lasts, so it never expires in front of a user. The
// reactive path (onStaleRpc) is the backstop; the extension is the fallback if
// stealth minting ever fails. TRUESCORE_MINT_INTERVAL_MIN (default 240; 0 disables).
export function startMintTimer(): void {
  if (!getMapsCreds()) void renewSession('boot', true);
  const min = Number(process.env.TRUESCORE_MINT_INTERVAL_MIN ?? 240);
  if (!(min > 0)) { console.log('[maps-creds] proactive mint disabled'); return; }
  const intervalMs = min * 60_000;
  setInterval(() => {
    // Skip if a reactive mint / extension reseed already refreshed within the interval.
    if (seededAt && Date.now() - seededAt < intervalMs) return;
    void renewSession('timer');
  }, intervalMs);
  console.log(`[maps-creds] proactive mint every ${min}min (+ boot if credless)`);
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
