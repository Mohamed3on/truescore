import { STORAGE_GET, STORAGE_SET, STORAGE_RESULT } from '../shared/gmaps-bridge-protocol';

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
