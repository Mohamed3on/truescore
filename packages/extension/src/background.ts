// Combined background service worker
import { SCORE_CACHE_PREFIX } from './shared/cache-keys';
import { createThrottledFetcher } from './shared/throttled-fetch';
import { SERVER_SCORE_PORT, type ServerScoreMessage } from './shared/gmaps-bridge-protocol';
import { readNdjson, type HighlightEvent, type HighlightsRequest, type HighlightsResponse, type LookupEvent, type Score } from '@truescore/gmaps-shared';

// Drop rc_score_* entries older than 30 days. Registered on install/update
// only — top-level chrome.alarms.create on every SW wake would reset the
// next-fire time and starve the alarm under heavy activity.
const SWEEP_ALARM = 'truescore-sweep';
const ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 24 * 60 });
  // Config for seeding the server with a Maps session, retired 2026-09-29; the secret
  // shouldn't outlive the feature.
  void chrome.storage.local.remove(['rc_seed_url', 'rc_seed_secret']);
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

// IMDb's per-rating vote counts (index 0 = 1★ … 9 = 10★) per title id, from the
// GraphQL API IMDb's own site uses. IMDb walls off page scrapers — the CORS proxy
// Letterboxd used now only ever gets its empty 202 — and a content script can't
// make this cross-origin call, so it lives here, throttled across every tab. One
// query answers a whole list of ids, so a title page's recommendation strip costs
// a single request. Null on failure; an id IMDb doesn't know has no ratings, so
// it's all zeros.
const imdbFetch = createThrottledFetcher(10);
const imdbHistograms = async (ids: string[]): Promise<Record<string, number[]> | null> => {
  try {
    const r = await imdbFetch('https://caching.graphql.imdb.com/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-imdb-client-name': 'imdb-web-next-localized' },
      body: JSON.stringify({
        query: 'query($ids: [ID!]!) { titles(ids: $ids) { id aggregateRatingsBreakdown { histogram { histogramValues { rating voteCount } } } } }',
        variables: { ids },
      }),
    });
    if (!r.ok) return null;
    const titles = (await r.json())?.data?.titles;
    if (!Array.isArray(titles)) return null;
    const histograms: Record<string, number[]> = {};
    for (const title of titles) {
      if (typeof title?.id !== 'string') continue;
      const counts: number[] = Array(10).fill(0);
      for (const { rating, voteCount } of title.aggregateRatingsBreakdown?.histogram?.histogramValues ?? []) {
        if (rating >= 1 && rating <= 10) counts[rating - 1] = voteCount || 0;
      }
      histograms[title.id] = counts;
    }
    return histograms;
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
  if (msg?.type === 'imdbHistograms' && Array.isArray(msg.ids)) {
    imdbHistograms(msg.ids.filter((id: unknown) => typeof id === 'string')).then(sendResponse);
    return true; // answered asynchronously
  }
});

// Booking.com: notify content script on tab update
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, { message: 'TabUpdated' }).catch(() => {});
  }
});
