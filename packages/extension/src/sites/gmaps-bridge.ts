import { STORAGE_GET, STORAGE_SET, STORAGE_RESULT, MAPS_CREDS_VERIFIED, SERVER_SCORE_GET, SERVER_SCORE_RESULT } from '../shared/gmaps-bridge-protocol';

// ISOLATED world, document_start. Bridges chrome.storage.local, which
// MAIN-world gmaps.ts can't reach itself (request/response via CustomEvents).
// Page scripts reach these listeners too, not just our MAIN-world code. The seed
// config must stay out of their reach: rc_seed_url decides where the worker POSTs
// the user's whole google.com cookie jar, so a writable one is an account
// takeover, and rc_seed_secret is a credential. Nothing in the page needs either.
const pageMayTouch = (key: string) => !key.startsWith('rc_seed_');

const respond = (id: string, value: unknown) => {
  document.dispatchEvent(new CustomEvent(STORAGE_RESULT, { detail: { id, value } }));
};

document.addEventListener(STORAGE_GET, (e) => {
  const { id, key } = (e as CustomEvent).detail || {};
  if (!id || !key || !pageMayTouch(key)) return;
  try {
    chrome.storage.local.get(key, (items) => respond(id, items?.[key] ?? null));
  } catch {
    respond(id, null); // context invalidated (extension reloaded) — fail fast
  }
});

document.addEventListener(STORAGE_SET, (e) => {
  const { id, key, value } = (e as CustomEvent).detail || {};
  if (!id || !key || !pageMayTouch(key)) return;
  try {
    chrome.storage.local.set({ [key]: value }, () => respond(id, true));
  } catch {
    respond(id, false);
  }
});

// Forward batchexecute creds to the background worker, which reads the matching
// google.com cookies (the "cookies" permission isn't available to content
// scripts) and seeds the user's own truescore server. Gated on the VERIFIED
// event, not the raw capture: creds that Google refuses would otherwise be
// handed to the server, where they break scoring for everyone.
document.addEventListener(MAPS_CREDS_VERIFIED, (e) => {
  const creds = (e as CustomEvent).detail;
  if (!creds?.bgkey) return;
  try { chrome.runtime.sendMessage({ type: 'seedMapsCreds', creds }); } catch {}
});

// Any script in the page can dispatch this event, so the URL is never taken from
// it: that would let google.com's own JS (or an XSS there) use us to bypass CORS
// and push arbitrary URLs at the server. The only legitimate subject is the Maps
// page this bridge is running in, which we can read ourselves.
document.addEventListener(SERVER_SCORE_GET, (e) => {
  const { id } = (e as CustomEvent).detail || {};
  if (!id || location.hostname !== 'www.google.com' || !location.pathname.startsWith('/maps/place/')) return;
  const url = location.href;
  const reply = (value: unknown) => document.dispatchEvent(
    new CustomEvent(SERVER_SCORE_RESULT, { detail: { id, value } }));
  try {
    chrome.runtime.sendMessage({ type: 'serverScore', url }, (res) => reply(res?.score ?? null));
  } catch {
    reply(null); // context invalidated (extension reloaded)
  }
});
