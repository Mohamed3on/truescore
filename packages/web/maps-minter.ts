// Self-mint an ANONYMOUS Maps session, hands-off, with no browser. One plain GET of
// Maps carries all of it: the cookie jar, the session id (the page's kEI) and Maps'
// BotGuard challenge. Google binds each bgkey to its exact request (gmaps-shared
// botguard), so the challenge's VM keeps running in a worker (./botguard-worker) and
// signs every review request of the session until the next mint replaces it.
import { PAGE_SIZE, type Signer } from '@truescore/gmaps-shared';
import { fetchMapsPage, googleFetch, verifyReviewsLoad, PROXY_URL, USER_AGENT } from './browser';
import type { MapsSession } from './maps-creds';
import { logEvent } from './events';

// Google refuses keys the VM signs the moment it starts, and takes them seconds later.
const WARMUP_MS = 3_000;
const MINT_TIMEOUT_MS = 30_000;
const SIGN_TIMEOUT_MS = 5_000;
// The racers share one interpreter download, so one that hangs would sink them all.
const INTERPRETER_TIMEOUT_MS = 15_000;
// Google caps about half of fresh sessions for life at 5 reviews a request with no
// next page (what an unsigned request gets). So a mint races a few sessions and
// keeps the first uncapped one, starting another the moment one fails rather than
// waiting out the slowest of a round — up to MINT_ATTEMPTS in all.
const MINT_RACE = 3;
const MINT_ATTEMPTS = 6;

type Minted = { session: MapsSession; stop: () => void };
let inFlight: Promise<MapsSession | null> | null = null;
// The mint signing for the adopted session; stopped when a newer one takes over.
let live: Minted | null = null;

// Single-flight: a stale-storm of triggers collapses to one mint.
export function mintMapsCreds(): Promise<MapsSession | null> {
  return (inFlight ??= (async () => {
    // Without the proxy (local dev, tests) the mint would come from this machine's own IP.
    if (!PROXY_URL) { console.warn('[maps-minter] no proxy configured — cannot mint'); return null; }
    const won = await firstOf(runMint, MINT_RACE, MINT_ATTEMPTS);
    if (!won) return null;
    live?.stop();
    live = won;
    return won.session;
  })().finally(() => { inFlight = null; interpreters.clear(); }));
}

// `width` attempts at once, each failure replaced at once until `attempts` have
// run: the first to succeed wins, null if none does. Only one is kept — the rest
// stop, even those that land later.
export function firstOf<T extends { stop: () => void }>(attempt: () => Promise<T>, width: number, attempts: number): Promise<T | null> {
  return new Promise((resolve) => {
    let started = 0;
    let failed = 0;
    let won = false;
    const start = () => {
      started++;
      attempt().then(
        (m) => { if (won) m.stop(); else { won = true; resolve(m); } },
        () => { if (++failed === attempts) resolve(null); else if (!won && started < attempts) start(); },
      );
    };
    for (let i = 0; i < Math.min(width, attempts); i++) start();
  });
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

// The BotGuard interpreter a challenge names is one script whatever the session,
// so a mint's racers share one download of it. Dropped when the mint ends, and at
// once if the download fails or times out, so the next racer fetches it afresh.
const interpreters = new Map<string, Promise<string>>();
const interpreterAt = (url: string, cookies: string): Promise<string> => {
  const known = interpreters.get(url);
  if (known) return known;
  const script = withTimeout(googleFetch(url, undefined, cookies), INTERPRETER_TIMEOUT_MS);
  interpreters.set(url, script);
  script.catch(() => { if (interpreters.get(url) === script) interpreters.delete(url); });
  return script;
};

// One session: resolves only an uncapped one; anything else stops its VM and rejects.
async function runMint(): Promise<Minted> {
  const t0 = Date.now();
  const vm = botguardWorker();
  try {
    const session = await withTimeout(startSession(vm), MINT_TIMEOUT_MS);
    // Verify the session actually serves reviews before we trust it — via a cookie
    // override so a bad mint can't clobber the live session's global jar. The probe
    // place always fills a page, so a short one is a capped session.
    const verify = await verifyReviewsLoad(session.creds, session.cookies, session.sign);
    if (verify < PAGE_SIZE) throw new Error(verify ? 'verify-capped' : 'verify-empty');
    console.log(`[maps-minter] minted session in ${Date.now() - t0}ms (verify: ${verify} reviews)`);
    logEvent('mint', { result: 'ok', ms: Date.now() - t0, verify });
    return { session, stop: vm.stop };
  } catch (e) {
    vm.stop();
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[maps-minter] mint failed in ${Date.now() - t0}ms: ${reason}`);
    logEvent('mint', { result: 'fail', ms: Date.now() - t0, reason });
    throw e;
  }
}

async function startSession(vm: BotguardWorker): Promise<MapsSession> {
  const { html, cookies } = await fetchMapsPage();
  const sessionId = html.match(/kEI='([^']+)'/)?.[1];
  const challenge = html.match(/"USpUDc":("(?:[^"\\]|\\.)*")/)?.[1];
  if (!sessionId || !challenge) throw new Error('no session in the Maps page');
  // jspb: "%.@." then the array minus its "[": [id, script, [,,,interpreterUrl], hash, program, globalName, …]
  const [, , [, , , url], , program, globalName] = JSON.parse(`[${JSON.parse(challenge).slice(4)}`);
  await vm.boot({ interpreter: await interpreterAt(`https:${url}`, cookies), program, globalName });
  await Bun.sleep(WARMUP_MS);
  return { creds: { bgkey: '', bgbind: '', sessionId, at: '', hl: 'en' }, cookies, sign: vm.sign };
}

type BotguardWorker = ReturnType<typeof botguardWorker>;

// The VM in its own worker: boot() hands it the page's challenge and resolves once it's
// up; sign() then gets each request's key; stop() ends it, failing whatever is pending.
function botguardWorker() {
  const worker = new Worker(new URL('./botguard-worker.ts', import.meta.url).href);
  const pending = new Map<number, (key: string | null) => void>();
  let booted = () => {};
  let ids = 0;
  worker.onmessage = ({ data }) => (data === 'ready' ? booted() : pending.get(data.id)?.(data.key));
  const sign: Signer = (request) => new Promise((resolve) => {
    const id = ++ids;
    const done = (key: string | null) => { clearTimeout(timer); pending.delete(id); resolve(key); };
    const timer = setTimeout(done, SIGN_TIMEOUT_MS, null);
    pending.set(id, done);
    worker.postMessage({ id, request });
  });
  return {
    boot: (challenge: { interpreter: string; program: string; globalName: string }) => new Promise<void>((resolve, reject) => {
      booted = resolve;
      worker.onerror = (e) => reject(new Error(`botguard: ${e.message}`));
      worker.postMessage({ ...challenge, userAgent: USER_AGENT });
    }),
    sign,
    stop: () => { worker.terminate(); pending.forEach((done) => done(null)); },
  };
}
