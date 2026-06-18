// Combined background service worker
import { SCORE_CACHE_PREFIX } from './shared/cache-keys';
import type { MapsCreds } from '@truescore/gmaps-shared';

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

type SeedCreds = Pick<MapsCreds, 'bgkey' | 'bgbind' | 'sessionId' | 'at'>;
const seedMapsCreds = async (creds: SeedCreds) => {
  if (!creds?.bgkey || !creds.bgbind || !creds.sessionId || !creds.at) return;
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'seedMapsCreds' && msg.creds) seedMapsCreds(msg.creds as SeedCreds);
});

// Booking.com: notify content script on tab update
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, { message: 'TabUpdated' }).catch(() => {});
  }
});

// Decathlon: re-inject content script on SPA navigation
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['dist/sites/decathlon-pdp.js'],
    });
  },
  { url: [
    { hostContains: 'decathlon.de', pathContains: '/p/' },
    { hostContains: 'decathlon.co.uk', pathContains: '/p/' },
  ]}
);

// Uniqlo: re-inject on SPA navigation
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['dist/sites/uniqlo-pdp.js'],
    });
  },
  { url: [{ hostContains: 'uniqlo.com', pathContains: '/products/' }] }
);

// IKEA: re-inject on SPA navigation
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['dist/sites/ikea-pdp.js', 'dist/sites/ikea-plp.js'],
    });
  },
  { url: [{ hostContains: 'ikea.com', pathContains: '/p/' }] }
);
