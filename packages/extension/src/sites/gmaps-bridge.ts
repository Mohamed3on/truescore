import { STORAGE_GET, STORAGE_SET, STORAGE_RESULT } from '../shared/gmaps-bridge-protocol';

// ISOLATED world, document_start. Bridges chrome.* APIs that MAIN-world
// gmaps.ts can't reach itself: the Gemini API key (one-shot via dataset) and
// chrome.storage.local (request/response via CustomEvents).
chrome.storage.sync.get('geminiApiKey', ({ geminiApiKey }) => {
  if (geminiApiKey) {
    document.documentElement.dataset.tsGeminiKey = geminiApiKey;
  }
});

const respond = (id: string, value: unknown) => {
  document.dispatchEvent(new CustomEvent(STORAGE_RESULT, { detail: { id, value } }));
};

document.addEventListener(STORAGE_GET, (e) => {
  const { id, key } = (e as CustomEvent).detail || {};
  if (!id || !key) return;
  chrome.storage.local.get(key, (items) => respond(id, items?.[key] ?? null));
});

document.addEventListener(STORAGE_SET, (e) => {
  const { id, key, value } = (e as CustomEvent).detail || {};
  if (!id || !key) return;
  chrome.storage.local.set({ [key]: value }, () => respond(id, true));
});
