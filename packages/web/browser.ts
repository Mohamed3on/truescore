import { homedir } from 'os';

const COOKIES_PATH = process.env.TRUESCORE_COOKIES_PATH || `${homedir()}/.truescore-cookies.json`;
const COOKIES_TTL_MS = Number(process.env.TRUESCORE_COOKIES_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

// The residential proxy as its three parts. Exported so the headless minter can
// feed the auth separately to Chrome (which can't take inline proxy creds),
// while googleFetch below assembles them into a single URL.
export const proxyConfig = (): { server: string; user: string; pass: string } => ({
  server: process.env.TRUESCORE_PROXY_SERVER || '',
  user: process.env.TRUESCORE_PROXY_USER || '',
  pass: process.env.TRUESCORE_PROXY_PASS || '',
});

const PROXY_URL = (() => {
  const { server, user, pass } = proxyConfig();
  if (!server) return undefined;
  const u = new URL(server);
  if (user) u.username = user;
  if (pass) u.password = pass;
  return u.toString();
})();

// One canonical Chrome identity for the whole package — googleFetch sends it as a
// header; the headless minter feeds it to Network.setUserAgentOverride. Must stay
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
// Exported so the minter sets the same consent cookies in its headless session.
export const SEED_COOKIES: Record<string, string> = {
  CONSENT: 'YES+cb.20210720-07-p0.en+FX+410',
  SOCS: 'CAESHAgBEhJnd3NfMjAyMzAyMDgtMF9SQzIaAmVuIAEaBgiAm6KfBg',
};

type CachedCookies = { header: string; ts: number };
let cookiesCache: CachedCookies | null = null;
let cookiesRefreshing: Promise<string> | null = null;

// When the extension seeds a live logged-in session (cookies that match its
// captured bgkey), use those verbatim instead of the baked anonymous jar — the
// botguard token only validates against the session that minted it.
let cookieOverride: string | null = null;
export function setGoogleCookieOverride(header: string | null): void {
  cookieOverride = header && header.trim() ? header.trim() : null;
}

async function bakeCookies(): Promise<string> {
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
  return cookieHeader();
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
    const header = await bakeCookies();
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
): Promise<string> {
  assertGoogleHost(url);
  const cookie = await getGoogleCookieHeader();
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
      if (networkErr) throw networkErr;
      // Google explains 4xx rejections (stale bgkey/at, quota) in the body —
      // keep a snippet so the handler's catch logs *why*, not just the status.
      const snippet = (await r!.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
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

// Keep the seeded session alive the way Chrome does: a periodic RotateCookies POST
// mints fresh __Secure-1PSIDTS/3PSIDTS — the session-trust tokens. googleFetch
// discards Set-Cookie and a normal Maps request never rotates *SIDTS, so without
// this the seeded jar freezes and Google soft-rejects it (empty review RPCs) in
// ~a day — the manual extension reseed we want to avoid. Returns the merged jar
// when something rotated, null otherwise (caller keeps the current jar).
export async function rotateSessionCookies(cookie: string): Promise<string | null> {
  const r = await fetch('https://accounts.google.com/RotateCookies', {
    proxy: PROXY_URL,
    method: 'POST',
    body: '[0,null]',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Cookie: cookie },
  });
  if (!r.ok) return null;
  const setCookies: string[] = (r.headers as any).getAll
    ? (r.headers as any).getAll('set-cookie')
    : ([r.headers.get('set-cookie')].filter(Boolean) as string[]);
  const jar = new Map<string, string>();
  for (const pair of cookie.split('; ')) {
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  let changed = false;
  for (const c of setCookies) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (!m?.[1]) continue;
    const name = m[1], value = m[2] ?? '';
    if (jar.get(name) !== value) { jar.set(name, value); changed = true; }
  }
  return changed ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : null;
}

export async function fetchPlacePreview(placeUrl: string): Promise<any> {
  const html = await googleFetch(placeUrl);
  const m = html.match(/\/maps\/preview\/place\?[^"\s<>]+/);
  if (!m) throw new Error('preview URL not found in place HTML');
  const u = new URL(`https://www.google.com${m[0].replace(/&amp;/g, '&')}`);
  // Pin locale to en-US so chip labels and strings don't take on the proxy exit's geo.
  u.searchParams.set('hl', 'en');
  u.searchParams.set('gl', 'us');
  const body = await googleFetch(u.toString());
  return JSON.parse(body.replace(/^\)\]\}'\s*/, ''));
}
