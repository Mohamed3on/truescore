import { STORAGE_GET, STORAGE_SET, STORAGE_RESULT, MAPS_CREDS_CAPTURED } from '../shared/gmaps-bridge-protocol';

// ISOLATED world, document_start. Bridges chrome.storage.local, which
// MAIN-world gmaps.ts can't reach itself (request/response via CustomEvents).
const respond = (id: string, value: unknown) => {
  document.dispatchEvent(new CustomEvent(STORAGE_RESULT, { detail: { id, value } }));
};

document.addEventListener(STORAGE_GET, (e) => {
  const { id, key } = (e as CustomEvent).detail || {};
  if (!id || !key) return;
  try {
    chrome.storage.local.get(key, (items) => respond(id, items?.[key] ?? null));
  } catch {
    respond(id, null); // context invalidated (extension reloaded) — fail fast
  }
});

document.addEventListener(STORAGE_SET, (e) => {
  const { id, key, value } = (e as CustomEvent).detail || {};
  if (!id || !key) return;
  try {
    chrome.storage.local.set({ [key]: value }, () => respond(id, true));
  } catch {
    respond(id, false);
  }
});

// Forward batchexecute creds captured in the MAIN world to the background worker,
// which reads the matching google.com cookies (the "cookies" permission isn't
// available to content scripts) and seeds the user's own truescore server.
document.addEventListener(MAPS_CREDS_CAPTURED, (e) => {
  const creds = (e as CustomEvent).detail;
  if (!creds?.bgkey) return;
  try { chrome.runtime.sendMessage({ type: 'seedMapsCreds', creds }); } catch {}
});
