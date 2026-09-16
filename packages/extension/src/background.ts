// Combined background service worker
import { SCORE_CACHE_PREFIX } from './shared/cache-keys';
import { createThrottledFetcher } from './shared/throttled-fetch';
import { SERVER_SCORE_PORT, type ServerScoreMessage } from './shared/gmaps-bridge-protocol';
import { readNdjson, type HighlightEvent, type HighlightsRequest, type HighlightsResponse, type LookupEvent, type MapsCreds, type Score } from '@truescore/gmaps-shared';

// Drop rc_score_* entries older than 30 days. Registered on install/update
// only — top-level chrome.alarms.create on every SW wake would reset the
// next-fire time and starve the alarm under heavy activity.
const SWEEP_ALARM = 'truescore-sweep';
const ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 24 * 60 });
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SWEEP_ALARM) return;
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - ENTRY_MAX_AGE_MS;
  const stale = Object.keys(all).filter((k) => {
    if (k.startsWith('rc_score_') && !k.startsWith(SCORE_CACHE_PREFIX)) return true;
    if (!k.startsWith(SCORE_CACHE_PREFIX)) return false;
    const ts = (all[k] as { ts?: number } | null)?.ts;
    return typeof ts === 'number' && ts < cutoff;
  });
  if (!stale.length) return;
  await chrome.storage.local.remove(stale);
  console.log(`[truescore] swept ${stale.length} stale score cache entries`);
});

// Seed the user's own truescore server with the live logged-in session a gmaps
// content script captured: its bgkey + the matching google.com cookies (read
// here because chrome.cookies is unavailable to content scripts), paired so the
// server can replay batchexecute. Off unless the user has set rc_seed_url +
// rc_seed_secret in storage; throttled so a scroll-storm of captures is cheap.
const SEED_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastSeed = { bgkey: '', ts: 0 };

type SeedCreds = Pick<MapsCreds, 'bgkey' | 'bgbind' | 'sessionId' | 'at' | 'authuser'>;
const seedMapsCreds = async (creds: SeedCreds) => {
  // bgbind may be '': Google stopped sending x-maps-bgbind on the review RPC
  // (gmaps-capture records it empty) and the replay works without it.
  if (!creds?.bgkey || !creds.sessionId || !creds.at) return;
  // A secondary account's creds only replay with its authuser, which the server
  // never sends — seeded, every server request would 400.
  if (creds.authuser && creds.authuser !== '0') return;
  const now = Date.now();
  if (creds.bgkey === lastSeed.bgkey && now - lastSeed.ts < SEED_MIN_INTERVAL_MS) return;
  const { rc_seed_url: url, rc_seed_secret: secret } = await chrome.storage.local.get(['rc_seed_url', 'rc_seed_secret']);
  if (!url || !secret) return;
  // Exactly the cookies the browser would send to the review RPC — guaranteed to
  // match the session that minted the bgkey.
  const jar = await chrome.cookies.getAll({ url: 'https://www.google.com/' });
  const cookies = jar.map((c) => `${c.name}=${c.value}`).join('; ');
  if (!cookies) return;
  try {
    const r = await fetch(`${String(url).replace(/\/$/, '')}/api/maps-creds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-truescore-seed': String(secret) },
      body: JSON.stringify({ bgkey: creds.bgkey, bgbind: creds.bgbind, sessionId: creds.sessionId, at: creds.at, cookies }),
    });
    if (r.ok) lastSeed = { bgkey: creds.bgkey, ts: now };
    else console.warn('[truescore] seed failed', r.status);
  } catch (e) {
    console.warn('[truescore] seed error', e);
  }
};

// IMDb's per-rating vote counts (index 0 = 1★ … 9 = 10★), from the GraphQL API
// IMDb's own site uses. IMDb walls off page scrapers — the CORS proxy Letterboxd
// used now only ever gets its empty 202 — and a content script can't make this
// cross-origin call, so it lives here, throttled across every tab. Null on
// failure; an id IMDb doesn't know has no ratings, so it's all zeros.
const imdbFetch = createThrottledFetcher(10);
const imdbHistogram = async (id: string): Promise<number[] | null> => {
  try {
    const r = await imdbFetch('https://caching.graphql.imdb.com/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-imdb-client-name': 'imdb-web-next-localized' },
      body: JSON.stringify({
        query: 'query($id: ID!) { title(id: $id) { aggregateRatingsBreakdown { histogram { histogramValues { rating voteCount } } } } }',
        variables: { id },
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json())?.data;
    if (!data) return null;
    const counts: number[] = Array(10).fill(0);
    for (const { rating, voteCount } of data.title?.aggregateRatingsBreakdown?.histogram?.histogramValues ?? []) {
      if (rating >= 1 && rating <= 10) counts[rating - 1] = voteCount || 0;
    }
    return counts;
  } catch {
    return null;
  }
};

// Score a place through truescore's own Google session, for a browser whose
// session Google refuses, then fetch its topic chips. /api/lookup is same-origin
// only, so the content script can't call it — we hold the host permission and no
// page CORS applies. Everything is posted back as it lands, so the panel fills in
// as the server works.
const TRUESCORE_API_BASE = 'https://truescore.mohamed3on.com';
type Post = (msg: ServerScoreMessage) => void;

// Chips carry their reviews, so a chip opens without a Google session. A place
// whose chips the server hasn't harvested yet answers 202 while it warms them, so
// poll on the web client's schedule; each `pending` post also keeps this worker
// from idling out mid-wait.
const HIGHLIGHTS_MAX_POLLS = 34;
const HIGHLIGHTS_POLL_MS = 3500;
const serverHighlights = async (featureId: string, post: Post): Promise<void> => {
  for (let poll = 0; poll < HIGHLIGHTS_MAX_POLLS; poll++) {
    const res = await fetch(`${TRUESCORE_API_BASE}/api/highlights`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ featureId } satisfies HighlightsRequest),
    });
    if (res.status === 202) {
      post({ kind: 'pending' });
      await new Promise((r) => setTimeout(r, HIGHLIGHTS_POLL_MS));
      continue;
    }
    if (!res.ok || !res.body) return;
    if (!res.headers.get('content-type')?.includes('ndjson')) {
      for (const chip of ((await res.json()) as HighlightsResponse).highlights ?? []) post({ kind: 'chip', chip });
      return;
    }
    for await (const ev of readNdjson<HighlightEvent>(res.body)) {
      if (ev.type === 'chips') post({ kind: 'candidates', chips: ev.chips });
      else if (ev.type === 'chip') post({ kind: 'chip', chip: ev.highlight });
    }
    return;
  }
};

const serverScore = async (url: string, post: Post): Promise<void> => {
  // Defence in depth behind the bridge: only a Maps place page is ever scored.
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'www.google.com' || !u.pathname.startsWith('/maps/place/')) return;
  } catch {
    return;
  }
  let chips: Promise<void> | undefined;
  try {
    const res = await fetch(`${TRUESCORE_API_BASE}/api/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok || !res.body) return;
    for await (const ev of readNdjson<LookupEvent>(res.body)) {
      // `throttled` means the server's own scrape came back empty: never paint it.
      const score = ev.type === 'lookup' || ev.type === 'refreshed' ? ev.score
        : ev.type === 'provisional' || ev.type === 'score-progress' ? ev.score
        : ev.type === 'score' && !ev.throttled ? ev.score
        : null;
      if (!score) continue;
      // The panel paints the aggregate; the review bodies run to megabytes.
      const { reviews: _bodies, ...aggregate } = score as Score;
      post({ kind: 'score', score: aggregate });
      // Chips once the server has the place's row and isn't scraping it: at once for
      // a cached lookup, when the scrape settles for a fresh one. Scored during the
      // scrape, they'd compete with it for the server's one Google session.
      if (!chips && (ev.type === 'lookup' || ev.type === 'score')) {
        chips = serverHighlights(score.featureId, post).catch((e) => console.warn('[truescore] server highlights failed', e));
      }
    }
  } catch (e) {
    console.warn('[truescore] server score failed', e);
  }
  await chips;
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SERVER_SCORE_PORT) return;
  let open = true;
  port.onDisconnect.addListener(() => { open = false; });
  port.onMessage.addListener((msg) => {
    if (typeof msg?.url !== 'string') return;
    void serverScore(msg.url, (m) => { if (open) port.postMessage(m); })
      .finally(() => { if (open) port.disconnect(); });
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'seedMapsCreds' && msg.creds) seedMapsCreds(msg.creds as SeedCreds);
  if (msg?.type === 'imdbHistogram' && typeof msg.id === 'string') {
    imdbHistogram(msg.id).then(sendResponse);
    return true; // answered asynchronously
  }
});

// Booking.com: notify content script on tab update
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, { message: 'TabUpdated' }).catch(() => {});
  }
});
