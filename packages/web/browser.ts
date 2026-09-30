import { homedir } from 'os';
import { buildListReq, parseReviewsResponse, signReq, type MapsCreds, type Signer } from '@truescore/gmaps-shared';
import { logEvent } from './events';

const COOKIES_PATH = process.env.TRUESCORE_COOKIES_PATH || `${homedir()}/.truescore-cookies.json`;
const COOKIES_TTL_MS = Number(process.env.TRUESCORE_COOKIES_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

// The residential proxy, its auth inline.
export const PROXY_URL = (() => {
  const server = process.env.TRUESCORE_PROXY_SERVER;
  if (!server) return undefined;
  const u = new URL(server);
  u.username = process.env.TRUESCORE_PROXY_USER || '';
  u.password = process.env.TRUESCORE_PROXY_PASS || '';
  return u.toString();
})();

// One canonical Chrome identity for the whole package — googleFetch sends it as a
// header; the minter gives it to its BotGuard VM's navigator. Must stay
// a real Chrome UA (a "HeadlessChrome" UA makes Google serve a reviews-less page).
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const FETCH_HEADERS_BASE = {
  'User-Agent': USER_AGENT,
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.google.com/maps/',
};

// Pre-seeded values that signal "consent already given" — bypasses the EU consent dance.
// Google then issues __Secure-ENID and __Secure-BUCKET on the next page load, which
// together with these are enough to authenticate listugcposts and preview/place RPCs.
const SEED_COOKIES: Record<string, string> = {
  CONSENT: 'YES+cb.20210720-07-p0.en+FX+410',
  SOCS: 'CAESHAgBEhJnd3NfMjAyMzAyMDgtMF9SQzIaAmVuIAEaBgiAm6KfBg',
};

// Eiffel Tower — the canonical "always has reviews" place. verifyReviewsLoad probes
// it to confirm a freshly-minted session serves reviews.
const REVIEW_PROBE_FID = '0x47e66e2964e34e2d:0x8ddca9ee380ef7e0';

type CachedCookies = { header: string; ts: number };
let cookiesCache: CachedCookies | null = null;
let cookiesRefreshing: Promise<string> | null = null;

// The adopted session's cookies (its minted page's jar) replace the baked anonymous
// jar: its sessionId, `at` and signer all belong to that jar.
let cookieOverride: string | null = null;
export function setGoogleCookieOverride(header: string | null): void {
  cookieOverride = header && header.trim() ? header.trim() : null;
}

// A fresh anonymous google.com jar and the Maps page that set it. The minter reads the
// page's session id and BotGuard challenge too.
export async function fetchMapsPage(): Promise<{ html: string; cookies: string }> {
  const jar: Record<string, string> = { ...SEED_COOKIES };
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch('https://www.google.com/maps?hl=en', {
    proxy: PROXY_URL,
    redirect: 'follow',
    headers: { ...FETCH_HEADERS_BASE, Accept: 'text/html,application/xhtml+xml', Cookie: cookieHeader() },
  });
  const setCookies = (r.headers as any).getAll
    ? (r.headers as any).getAll('set-cookie')
    : [r.headers.get('set-cookie')].filter(Boolean);
  for (const c of (setCookies || []) as string[]) {
    const m = c?.match(/^([^=]+)=([^;]*)/);
    if (m?.[1]) jar[m[1]] = m[2] ?? '';
  }
  return { html: await r.text(), cookies: cookieHeader() };
}

export async function getGoogleCookieHeader(): Promise<string> {
  if (cookieOverride) return cookieOverride;
  if (!cookiesCache) {
    try {
      const f = Bun.file(COOKIES_PATH);
      if (await f.exists()) cookiesCache = await f.json();
    } catch {}
  }
  if (cookiesCache && Date.now() - cookiesCache.ts < COOKIES_TTL_MS) return cookiesCache.header;
  if (cookiesRefreshing) return cookiesRefreshing;
  cookiesRefreshing = (async () => {
    const { cookies: header } = await fetchMapsPage();
    cookiesCache = { header, ts: Date.now() };
    await Bun.write(COOKIES_PATH, JSON.stringify(cookiesCache));
    console.log(`[browser] baked google cookies via proxy`);
    return header;
  })().finally(() => { cookiesRefreshing = null; });
  return cookiesRefreshing;
}

// The server must only ever fetch Google's own hosts. Everything legitimately
// passed here (listugcposts, preview/place, the maps HTML) is *.google.com; an
// attacker-supplied place URL is the one thing that isn't. Reject by hostname
// SUFFIX — a substring check would wrongly admit "google.com.attacker.example".
export function assertGoogleHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error('invalid URL');
  }
  if (host !== 'google.com' && !host.endsWith('.google.com')) {
    throw new Error(`refusing to fetch non-Google host: ${host}`);
  }
}

// 429: explicit throttle. 5xx covers proxy-origin timeouts (502/504), upstream
// unavailability (503), and Cloudflare-shape errors (522/524) that show up when
// the proxy provider sits behind Cloudflare and the listugcposts fan-out from
// /api/highlights spikes connection counts.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 522, 524]);
const MAX_ATTEMPTS = 4;

// init carries the batchexecute POST (method/body/headers from the shared
// builder); preview/place + the maps HTML are plain GETs and pass none.
export async function googleFetch(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
  overrideCookie?: string,
): Promise<string> {
  assertGoogleHost(url);
  // overrideCookie lets the minter verify a freshly-minted (anonymous) jar without
  // flipping the global cookie override — so a failed verify can't poison the live session.
  const cookie = overrideCookie ?? await getGoogleCookieHeader();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let r: Response | null = null;
    let networkErr: Error | null = null;
    try {
      r = await fetch(url, {
        proxy: PROXY_URL,
        method: init?.method,
        body: init?.body,
        headers: { ...FETCH_HEADERS_BASE, ...init?.headers, Cookie: cookie },
      });
    } catch (e) {
      networkErr = e instanceof Error ? e : new Error(String(e));
    }
    if (r?.ok) return r.text();
    const status = r?.status ?? 0;
    const retryable = networkErr !== null || RETRY_STATUSES.has(status);
    const last = attempt === MAX_ATTEMPTS - 1;
    if (!retryable || last) {
      if (networkErr) {
        logEvent('fetch-fail', { kind: 'network', msg: networkErr.message, url: url.slice(0, 60) });
        throw networkErr;
      }
      // Google explains 4xx rejections (stale bgkey/at, quota) in the body —
      // keep a snippet so the handler's catch logs *why*, not just the status.
      // The event captures it too — a 407 "reached your traffic limit" (proxy
      // quota) vs a 4xx bgkey rejection look identical without the body.
      const snippet = (await r!.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
      logEvent('fetch-fail', { kind: 'http', status, body: snippet.slice(0, 80), url: url.slice(0, 60) });
      throw new Error(`googleFetch ${status} for ${url.slice(0, 80)}…${snippet ? ` body=${snippet}` : ''}`);
    }
    const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
    console.warn(
      `[googleFetch] ${networkErr ? networkErr.message : status} — retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${delay}ms`,
    );
    await Bun.sleep(delay);
  }
  throw new Error('googleFetch: unreachable');
}

// Does this creds+cookies combo actually load reviews? Probes the canonical place
// through googleFetch (proxy + retry + logging) — the minter calls it to verify a
// fresh session before adopting it. overrideCookie fetches with a specific jar
// without touching the global cookie override, so a bad verify can't poison the live
// session. Returns the review count (0 on empty); a transport error propagates.
export async function verifyReviewsLoad(creds: MapsCreds, overrideCookie?: string, sign?: Signer): Promise<number> {
  const req = buildListReq(REVIEW_PROBE_FID, 'newest', creds);
  return parseReviewsResponse(await googleFetch(req.url, await signReq(req.init, sign), overrideCookie)).reviews.length;
}

// Each place's preview-RPC URL, as its Maps page embeds it. Finding it cost a whole
// page download per preview — five a quick chip-harvest round — so it's kept and
// replayed, and the page is read again only when a replay fails. Replaying is safe:
// which reply carries the topic chips is random per request, not per URL.
const previewUrls = new Map<string, string>();
const PREVIEW_URLS_MAX = 1000;

async function previewUrlFor(placeUrl: string): Promise<string> {
  const html = await googleFetch(placeUrl);
  const m = html.match(/\/maps\/preview\/place\?[^"\s<>]+/);
  if (!m) throw new Error('preview URL not found in place HTML');
  const u = new URL(`https://www.google.com${m[0].replace(/&amp;/g, '&')}`);
  // Pin locale to en-US so chip labels and strings don't take on the proxy exit's geo.
  u.searchParams.set('hl', 'en');
  u.searchParams.set('gl', 'us');
  const url = u.toString();
  previewUrls.set(placeUrl, url);
  if (previewUrls.size > PREVIEW_URLS_MAX) previewUrls.delete(previewUrls.keys().next().value!);
  return url;
}

const fetchPreview = async (url: string): Promise<any> =>
  JSON.parse((await googleFetch(url)).replace(/^\)\]\}'\s*/, ''));

export async function fetchPlacePreview(placeUrl: string): Promise<any> {
  const known = previewUrls.get(placeUrl);
  if (known) {
    try {
      return await fetchPreview(known);
    } catch {
      if (previewUrls.get(placeUrl) === known) previewUrls.delete(placeUrl);
    }
  }
  return fetchPreview(await previewUrlFor(placeUrl));
}
