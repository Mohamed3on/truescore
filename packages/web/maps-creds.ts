import { homedir } from 'os';
import { dirname, join } from 'path';
import { writeFileSync, renameSync } from 'fs';
import { buildListReq, parseReviewsResponse, type MapsCreds } from '@truescore/gmaps-shared';
import { setGoogleCookieOverride, googleFetch, rotateSessionCookies } from './browser';
import { mintMapsCreds } from './maps-minter';
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
// The cookies the live session was seeded with — kept for the RotateCookies
// keepalive (refreshSessionCookies) to roll the session-trust tokens forward.
let cookieStr: string | null = null;
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
  cookieStr = s.cookies;
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
// no human. A good reply doesn't itself flip the banner; renewSession/onMintFailed own that.
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

// --- cookie roll-forward: refresh the session-trust tokens (no Chrome) ---
// renewSession above re-mints the bgkey but reuses the seeded cookies verbatim,
// and googleFetch throws away Set-Cookie — so __Secure-1PSIDTS/3PSIDTS are never
// refreshed and the jar goes stale in ~a day, forcing a manual extension reseed.
// A periodic RotateCookies POST rolls them forward; we verify reviews still load
// before adopting the new jar, so a bad rotation can't poison a working session.
const VERIFY_FID = '0x47e66e2964e34e2d:0x8ddca9ee380ef7e0'; // Eiffel Tower — always has reviews; the bgkey is place-independent.

// Swap in a refreshed jar WITHOUT touching seededAt: the bgkey is unchanged, so its
// age must keep ticking from the real seed, not reset on every cookie roll.
function adoptCookies(cookies: string): void {
  if (!cached) return;
  setGoogleCookieOverride(cookies);
  cookieStr = cookies;
  setRenewOk(true, 'cookie-rotate');
  try {
    persistSeed({ bgkey: cached.bgkey, bgbind: cached.bgbind, sessionId: cached.sessionId, at: cached.at, cookies, ts: seededAt ?? Date.now() });
  } catch (e) {
    console.error('[maps-creds] failed to persist refreshed cookies — in-memory jar still active', e);
  }
}

export async function refreshSessionCookies(reason: string): Promise<boolean> {
  if (!cookieStr || !cached) return false;
  let rolled: string | null = null;
  try {
    rolled = await rotateSessionCookies(cookieStr);
  } catch (e) {
    console.warn(`[maps-creds] cookie rotate error (${reason})`, e instanceof Error ? e.message : e);
    logEvent('cookie-rotate', { result: 'error', reason, msg: e instanceof Error ? e.message : String(e) });
    return false;
  }
  if (!rolled) { logEvent('cookie-rotate', { result: 'unchanged', reason }); return false; } // RotateCookies returned no new tokens — jar already current
  // Verify against the live RPC before adopting. The probe flips the global
  // override to the candidate jar, so restore it if the candidate comes back empty.
  setGoogleCookieOverride(rolled);
  let ok = false;
  try {
    const req = buildListReq(VERIFY_FID, 'newest', cached);
    ok = parseReviewsResponse(await googleFetch(req.url, req.init)).reviews.length > 0;
  } catch { /* network/parse failure counts as not-ok */ }
  if (!ok) {
    setGoogleCookieOverride(cookieStr);
    console.warn(`[maps-creds] cookie refresh (${reason}) verified empty — keeping current jar`);
    logEvent('cookie-rotate', { result: 'verify-empty', reason });
    return false;
  }
  adoptCookies(rolled);
  console.log(`[maps-creds] session cookies refreshed (${reason})`);
  logEvent('cookie-rotate', { result: 'adopted', reason });
  return true;
}

// Roll cookies forward well inside the ~day it takes the jar to go stale. Cheap
// (one HTTP POST, no Chrome), and it also fires ~10s after boot so a burst of
// deploys — each resetting the interval — can't starve it. 0 disables -> falls
// back to the extension reseed + the web banner. TRUESCORE_COOKIE_REFRESH_MIN.
export function startCookieRefreshTimer(): void {
  const min = Number(process.env.TRUESCORE_COOKIE_REFRESH_MIN ?? 30);
  if (!(min > 0)) { console.log('[maps-creds] cookie refresh disabled'); return; }
  const tick = () => { void refreshSessionCookies('timer'); };
  setInterval(tick, min * 60_000);
  setTimeout(tick, 10_000);
  console.log(`[maps-creds] cookie refresh every ${min}min (+ boot)`);
}

// Hands-off engine: mint on boot if we have no creds, then refresh on a timer well
// inside the ~day a session lasts, so it never expires in front of a user. The
// reactive path (onStaleRpc) is the backstop; the extension is the fallback if
// stealth minting ever fails. TRUESCORE_MINT_INTERVAL_MIN (default 240; 0 disables).
export function startMintTimer(): void {
  if (!getMapsCreds()) void renewSession('boot', true);
  const min = Number(process.env.TRUESCORE_MINT_INTERVAL_MIN ?? 240);
  if (!(min > 0)) { console.log('[maps-creds] proactive mint disabled'); return; }
  setInterval(() => { void renewSession('timer'); }, min * 60_000);
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
