import { type MapsCreds, type Signer } from '@truescore/gmaps-shared';
import { setGoogleCookieOverride } from './browser';
import { mintMapsCreds } from './maps-minter';
import { logEvent } from './events';

// The session for the ListUgcPosts batchexecute RPC (the legacy GET endpoint is
// retired): a sessionId, the google.com cookies it belongs to, and the BotGuard VM
// that signs every request of it, since Google binds each bgkey to its exact request.
// Memory only: the VM dies with the process, and the boot mint takes seconds.

// The session is ONE value. It used to be two module globals in two files —
// `cached` here and `cookieOverride` in browser.ts — joined only by apply()
// happening to call both setters. Nothing enforced the pairing, and the env
// fallback below broke it outright: it returned creds with no matching cookie
// override, so googleFetch paired an env bgkey with the anonymous baked jar —
// precisely the combination the comment above says cannot work. Every review RPC
// then came back empty, which reads as a stale session, which triggers a doomed
// headless mint every 60s. Silent zeros, not a crash.
let session: MapsSession | null = null;
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

/** Creds, the cookies they belong to, and the VM that signs for them. Only adoptable together. */
export type MapsSession = { creds: MapsCreds; cookies: string; sign?: Signer };

const adopt = (next: MapsSession): void => {
  session = next;
  setGoogleCookieOverride(next.cookies);
  setRenewOk(true, 'apply');
};

// A fresh mint becomes the live session.
function applySeed(s: MapsSession): void {
  adopt(s);
  seededAt = Date.now();
  console.log(`[maps-creds] seeded session …${s.creds.sessionId.slice(-6)} (${s.cookies.length}b cookies) at ${new Date(seededAt).toISOString()}`);
  logEvent('seed', { src: 'mint', session: s.creds.sessionId.slice(-6), cookieBytes: s.cookies.length });
}

// An operator-supplied session, for pinning one by hand. All of it or nothing:
// TRUESCORE_MAPS_COOKIES is not optional, because a bgkey without the jar that
// minted it is not a session — it is the failure mode this module exists to
// avoid. Only bgbind may be blank: Google stopped sending it on the review RPC,
// and the replay works without it.
const envSession = (): MapsSession | null => {
  const bgkey = process.env.TRUESCORE_MAPS_BGKEY;
  const bgbind = process.env.TRUESCORE_MAPS_BGBIND ?? '';
  const sessionId = process.env.TRUESCORE_MAPS_SESSION;
  const at = process.env.TRUESCORE_MAPS_AT;
  const cookies = process.env.TRUESCORE_MAPS_COOKIES;
  if (!(bgkey && sessionId && at)) return null;
  if (!cookies) {
    console.warn('[maps-creds] TRUESCORE_MAPS_BGKEY is set without TRUESCORE_MAPS_COOKIES — ignoring: the token only validates against the session that minted it');
    return null;
  }
  return { creds: { bgkey, bgbind, sessionId, at, hl: 'en' }, cookies };
};

/** The live session, or null when unconfigured. Never a half of one. */
export function mapsSession(): MapsSession | null {
  if (!session) {
    const fromEnv = envSession();
    if (fromEnv) adopt(fromEnv);
  }
  return session;
}

// null when unconfigured — callers degrade to an empty score rather than throw,
// so a creds-less deploy behaves like the (already review-less) status quo until
// a mint lands, instead of erroring the whole lookup.
export function getMapsCreds(): MapsCreds | null {
  return mapsSession()?.creds ?? null;
}

// The transport calls these from the actual review-RPC outcome (see gmaps.ts),
// AFTER its own retries. A stale reply (reviews empty even on retry) triggers a fresh
// mint; a good reply proves the session works. The mint is anonymous — no extension,
// no human. A good reply doesn't itself flip the banner; renewSession owns that.
export function onStaleRpc(): void { void renewSession('stale-detected'); }
export function onFreshRpc(): void { setRenewOk(true, 'fresh-rpc'); }
// A whole scrape the cache refused: no reviews (or one sort empty, or short of a
// page) for a place that has them. Its replies can parse as valid, which the stale
// check above passes as fresh — so without this the banner stayed hidden while every
// lookup read zero. The next good reply clears it. Mint too: a capped session never
// looks stale, so nothing else would replace it.
export function onThrottledScrape(): void { setRenewOk(false, 'throttled-scrape'); void renewSession('throttled-scrape'); }
export function mapsSessionHealthy(): boolean { return !!getMapsCreds() && renewOk; }

// --- self-mint: a fresh ANONYMOUS session, no browser, no human (see maps-minter) ---
// A cooldown collapses a stale-storm to one attempt (force bypasses it for the timer /
// operator endpoint); mintMapsCreds has its own single-flight one layer down.
const RENEW_COOLDOWN_MS = 60_000;
const RESEED_ALERT_COOLDOWN_MS = 10 * 60_000;
const FIRST_SESSION_WAIT_MS = 20_000;
let lastRenewAttempt = 0;
let lastReseedAlert = 0;
// The latest renewal, settled once its session is adopted or its mint failed.
let renewing: Promise<boolean> = Promise.resolve(false);

export function renewSession(reason: string, force = false): Promise<boolean> {
  if (!force && Date.now() - lastRenewAttempt < RENEW_COOLDOWN_MS) return Promise.resolve(false);
  lastRenewAttempt = Date.now();
  return (renewing = renew(reason));
}

// getMapsCreds for a scrape. One that arrives before there's any session (a fresh
// boot) waits briefly for the mint in flight rather than scoring the place empty.
export async function mapsCredsReady(): Promise<MapsCreds | null> {
  if (!getMapsCreds()) await Promise.race([renewing, Bun.sleep(FIRST_SESSION_WAIT_MS)]);
  return getMapsCreds();
}

async function renew(reason: string): Promise<boolean> {
  console.log(`[maps-creds] minting a fresh session (${reason})…`);
  const minted = await mintMapsCreds();
  if (!minted) {
    setRenewOk(false, `mint-failed:${reason}`);
    // Alert once per episode rather than on every stale RPC.
    if (Date.now() - lastReseedAlert >= RESEED_ALERT_COOLDOWN_MS) {
      lastReseedAlert = Date.now();
      logEvent('needs-reseed', { note: 'auto-mint failed' });
      console.warn('[maps-creds] auto-mint failed');
    }
    return false;
  }
  applySeed(minted); // sets renewOk = true
  console.log(`[maps-creds] session renewed (${reason})`);
  return true;
}

// Hands-off engine: mint on boot, then refresh on a timer well inside the ~day a
// session lasts, so it never expires in front of a user. The reactive path
// (onStaleRpc) is the backstop. TRUESCORE_MINT_INTERVAL_MIN (default 240; 0 disables).
export function startMintTimer(): void {
  void renewSession('boot', true);
  const min = Number(process.env.TRUESCORE_MINT_INTERVAL_MIN ?? 240);
  if (!(min > 0)) { console.log('[maps-creds] proactive mint disabled'); return; }
  const intervalMs = min * 60_000;
  setInterval(() => {
    // Skip if a reactive mint already refreshed within the interval.
    if (seededAt && Date.now() - seededAt < intervalMs) return;
    void renewSession('timer');
  }, intervalMs);
  console.log(`[maps-creds] proactive mint every ${min}min (+ boot)`);
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
