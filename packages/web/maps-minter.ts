// Self-mint a fresh review bgkey: drive a headless Chrome that loads a Maps
// place as the persisted session and capture the qv9Egd batchexecute it fires —
// the same creds the extension lifts off a live tab, but server-side, so the web
// renews itself without a manual reseed. Three things make Google serve the real
// reviews UI (each a separate spike failure): consent-bypass cookies on
// .google.com, anti-headless (real UA + hidden navigator.webdriver), and a click
// on the Reviews tab. The legacy GET endpoint is retired, hence all this.
import { spawn, spawnSync } from 'child_process';
import { rmSync } from 'fs';
import { buildListReq, parseReviewsResponse } from '@truescore/gmaps-shared';
import { googleFetch, setGoogleCookieOverride, proxyConfig, SEED_COOKIES, USER_AGENT } from './browser';
import type { Seed } from './maps-creds';

const CHROME = process.env.TRUESCORE_CHROME_PATH || '/usr/bin/google-chrome';
const PORT = Number(process.env.TRUESCORE_MINT_PORT) || 9333;
// Eiffel Tower — always has reviews; the bgkey is place-independent so any busy
// place works as the mint target.
const MINT_FID = '0x47e66e2964e34e2d:0x8ddca9ee380ef7e0';
// Pin hl=en (gl=us) so Google serves English tab labels regardless of the proxy
// exit's country — the Reviews-tab nudge below matches aria-label*="eview", which
// silently misses localized labels ("Reseñas", "Avis", …) and never fires qv9Egd,
// so the mint captures no bgkey. Every other path (googleFetch/preview) pins hl too.
const MINT_URL = `https://www.google.com/maps?q=&ftid=${MINT_FID}&hl=en&gl=us`;
// Mirrors the 81-tagged sessionId regex in packages/extension/src/sites/gmaps-capture.ts.
const SID_RE = /\["([A-Za-z0-9_-]{16,}?)",null,null,null,null,null,81\]/;
const MINT_TIMEOUT_MS = 50_000;

const { server: proxyServer, user: proxyUser, pass: proxyPass } = proxyConfig();

// The captured creds minus the cookies they were minted with (the caller pairs
// them back). Same shape as the persisted Seed otherwise.
type Caps = Omit<Seed, 'cookies'>;

let inFlight: Promise<Seed | null> | null = null;

// Single-flight: a stale-storm of triggers collapses to one Chrome launch.
export function mintMapsCreds(cookies: string): Promise<Seed | null> {
  return (inFlight ??= runMint(cookies).finally(() => { inFlight = null; }));
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

async function runMint(cookies: string): Promise<Seed | null> {
  if (!proxyServer) { console.warn('[maps-minter] no proxy configured — cannot mint'); return null; }
  if (!cookies) { console.warn('[maps-minter] no cookies — cannot mint (needs a prior seed)'); return null; }
  const t0 = Date.now();
  const userDataDir = `/tmp/ts-mint-${t0}`;
  // detached:true → Chrome leads its own process group, so the whole tree (gpu,
  // network service, crashpad) can be SIGKILLed at once in finally.
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--proxy-server=${proxyServer}`,
    `--user-data-dir=${userDataDir}`, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--no-first-run', '--disable-extensions', '--disable-crash-reporter', '--window-size=1280,2000', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  let ws: WebSocket | undefined;
  try {
    const caps = await withTimeout(capture(cookies, (w) => (ws = w)), MINT_TIMEOUT_MS);
    if (!caps?.bgkey) { console.warn(`[maps-minter] no bgkey captured in ${Date.now() - t0}ms`); return null; }
    // Verify the minted bgkey actually fetches reviews through the server's own
    // path before we trust it; the cookies it was minted with are the override.
    setGoogleCookieOverride(cookies);
    const req = buildListReq(MINT_FID, 'newest', { ...caps, hl: 'en' });
    const { reviews } = parseReviewsResponse(await googleFetch(req.url, req.init));
    if (!reviews.length) { console.warn('[maps-minter] minted bgkey verified empty — discarding'); return null; }
    console.log(`[maps-minter] minted bgkey …${caps.bgkey.slice(-6)} in ${Date.now() - t0}ms (verify: ${reviews.length} reviews)`);
    return { ...caps, cookies };
  } catch (e) {
    console.warn('[maps-minter] mint error:', e instanceof Error ? e.message : e);
    return null;
  } finally {
    try { ws?.close(); } catch {}
    // Kill the whole process group, not just the parent pid — Chrome's children
    // (network service, crashpad) otherwise outlive it. pkill on the unique
    // user-data-dir mops up any straggler the group kill missed.
    try { if (chrome.pid) process.kill(-chrome.pid, 'SIGKILL'); } catch {}
    try { chrome.kill('SIGKILL'); } catch {}
    try { spawnSync('pkill', ['-9', '-f', userDataDir]); } catch {}
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

async function capture(cookies: string, setWs: (w: WebSocket) => void): Promise<Caps | null> {
  // Wait for DevTools; the /json ws url is port-less when fetched with
  // Host: localhost (rebind guard), so rebuild it against 127.0.0.1:port.
  let wsUrl = '';
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`, { headers: { Host: 'localhost' } });
      const page = (await r.json() as any[]).find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) wsUrl = `ws://127.0.0.1:${PORT}${new URL(page.webSocketDebuggerUrl).pathname}`;
    } catch {}
    if (!wsUrl) await Bun.sleep(250);
  }
  if (!wsUrl) throw new Error('devtools never came up');

  const ws = new WebSocket(wsUrl);
  setWs(ws);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws connect failed')); });

  let cdpId = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
  const listeners: ((m: any) => void)[] = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id)!; pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
    else if (msg.method) for (const l of listeners) l(msg);
  };
  const cdp = (method: string, params: any = {}) => new Promise<any>((res, rej) => { const id = ++cdpId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

  let captured: Caps | null = null;
  listeners.push(async (msg) => {
    if (msg.method === 'Fetch.authRequired') {
      // The reason Fetch is enabled at all: Chrome can't take inline proxy creds,
      // so we answer the proxy's auth challenge here.
      await cdp('Fetch.continueWithAuth', { requestId: msg.params.requestId, authChallengeResponse: { response: 'ProvideCredentials', username: proxyUser, password: proxyPass } }).catch(() => {});
    } else if (msg.method === 'Fetch.requestPaused') {
      const { requestId, request } = msg.params;
      // Every request pauses (auth needs interception — see Fetch.enable below),
      // so grab the bgkey off the one batchexecute en route, then release it.
      // Field extraction mirrors packages/extension/src/sites/gmaps-capture.ts.
      try {
        if (!captured && request.url.includes('batchexecute')) {
          const h: Record<string, string> = {};
          for (const k in request.headers) h[k.toLowerCase()] = request.headers[k];
          if (h['x-maps-bgkey']) {
            let postData = request.postData || '';
            if (!postData) { try { postData = (await cdp('Fetch.getRequestPostData', { requestId })).postData || ''; } catch {} }
            let decoded = postData; try { decoded = decodeURIComponent(postData); } catch {}
            const bgbind = h['x-maps-bgbind'] || '';
            const atRaw = (postData.match(/(?:^|&)at=([^&]+)/) || [])[1];
            captured = { bgkey: h['x-maps-bgkey'], bgbind, sessionId: (bgbind.match(SID_RE) || decoded.match(SID_RE) || [])[1] || '', at: atRaw ? decodeURIComponent(atRaw) : '' };
          }
        }
      } catch { /* swallow — still release the request below */ }
      await cdp('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  });

  await cdp('Network.enable');
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  // Fetch must intercept (non-empty patterns) to feed the proxy its credentials —
  // CDP rejects handleAuthRequests with empty patterns, and the rotating proxy
  // needs auth per-connection — so every request pauses and we continue it.
  await cdp('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
  // Anti-headless: a "HeadlessChrome" UA or navigator.webdriver=true makes Google
  // serve a reviews-less stripped page, so no qv9Egd ever fires.
  await cdp('Network.setUserAgentOverride', { userAgent: USER_AGENT, acceptLanguage: 'en-US,en;q=0.9', platform: 'MacIntel' });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});" }).catch(() => {});

  // The whole jar in one CDP round-trip: the persisted session cookies (__Host-
  // host-only, the rest on .google.com so they reach every subdomain) plus the
  // consent bypass.
  const cookieParams: any[] = cookies.split('; ').flatMap((pair) => {
    const eq = pair.indexOf('='); if (eq < 1) return [];
    const name = pair.slice(0, eq), value = pair.slice(eq + 1);
    return [name.startsWith('__Host-')
      ? { name, value, url: 'https://www.google.com/', secure: true, path: '/' }
      : { name, value, domain: '.google.com', path: '/', secure: true }];
  });
  for (const [name, value] of Object.entries(SEED_COOKIES)) cookieParams.push({ name, value, domain: '.google.com', path: '/' });
  await cdp('Network.setCookies', { cookies: cookieParams }).catch(() => {});

  await cdp('Page.navigate', { url: MINT_URL }).catch(() => {});

  // Once the Reviews tab renders, clicking it fires qv9Egd; poll+nudge until the
  // interceptor captures the bgkey (or the outer timeout fires). Selectors mirror
  // packages/extension/src/sites/gmaps-capture.ts.
  const nudge = `(function(){document.querySelector('button[role="tab"][aria-label*="eview" i]')?.click();var el=document.querySelector('.jftiEf[data-review-id]');el=el?el.parentElement:null;while(el){var s=getComputedStyle(el);if((s.overflowY==='auto'||s.overflowY==='scroll')&&el.scrollHeight>el.clientHeight){el.scrollBy({top:1e6});break;}el=el.parentElement;}return 1;})()`;
  for (let i = 0; i < 45 && !captured; i++) { await Bun.sleep(800); await cdp('Runtime.evaluate', { expression: nudge }).catch(() => {}); }
  return captured;
}
