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
// Google caps about half of fresh sessions for life at 5 reviews a request with no
// next page (what an unsigned request gets). So each round races a few sessions and
// keeps the first uncapped one; all capped is ~1 in 8, and a second round follows.
const MINT_RACE = 3;
const MINT_ROUNDS = 2;

type Minted = { session: MapsSession; stop: () => void };
let inFlight: Promise<MapsSession | null> | null = null;
// The mint signing for the adopted session; stopped when a newer one takes over.
let live: Minted | null = null;

// Single-flight: a stale-storm of triggers collapses to one mint.
export function mintMapsCreds(): Promise<MapsSession | null> {
  return (inFlight ??= (async () => {
    // Without the proxy (local dev, tests) the mint would come from this machine's own IP.
    if (!PROXY_URL) { console.warn('[maps-minter] no proxy configured — cannot mint'); return null; }
    for (let round = 0; round < MINT_ROUNDS; round++) {
      const race = Array.from({ length: MINT_RACE }, runMint);
      const won = await Promise.any(race).catch(() => null);
      // One session is adopted; the rest stop, even those that land later.
      for (const attempt of race) attempt.then((m) => { if (m !== won) m.stop(); }, () => {});
      if (!won) continue;
      live?.stop();
      live = won;
      return won.session;
    }
    return null;
  })().finally(() => { inFlight = null; }));
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

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
  await vm.boot({ interpreter: await googleFetch(`https:${url}`, undefined, cookies), program, globalName });
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
