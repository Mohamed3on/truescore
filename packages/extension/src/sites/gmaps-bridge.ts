import { STORAGE_GET, STORAGE_SET, STORAGE_RESULT, LLM_SETTINGS_GET, SERVER_SCORE_GET, SERVER_SCORE_RESULT, SERVER_SCORE_PORT, type ServerScoreMessage } from '../shared/gmaps-bridge-protocol';
import { getProviderChoice, getReasoningEffort } from '../shared/config';

// ISOLATED world, document_start. Bridges chrome.storage.local, which
// MAIN-world gmaps.ts can't reach itself (request/response via CustomEvents).

// Relays whatever the request produced; gmaps.ts types each reply by the request it made.
const respond = <Reply>(id: string, value: Reply) => {
  document.dispatchEvent(new CustomEvent(STORAGE_RESULT, { detail: { id, value } }));
};

document.addEventListener(STORAGE_GET, (e) => {
  if (!(e instanceof CustomEvent)) return;
  const { id, key } = e.detail || {};

  if (!id || !key) return;

  try {
    chrome.storage.local.get(key, (items) => respond(id, items?.[key] ?? null));
  } catch {
    respond(id, null); // context invalidated (extension reloaded) — fail fast
  }
});

document.addEventListener(STORAGE_SET, (e) => {
  if (!(e instanceof CustomEvent)) return;
  const { id, key, value } = e.detail || {};

  if (!id || !key) return;

  try {
    chrome.storage.local.set({ [key]: value }, () => respond(id, true));
  } catch {
    respond(id, false);
  }
});

// Only the two choices themselves (see LLM_SETTINGS_GET).
document.addEventListener(LLM_SETTINGS_GET, async (e) => {
  if (!(e instanceof CustomEvent)) return;
  const { id } = e.detail || {};

  if (!id) return;
  const [reasoningEffort, provider] = await Promise.all([getReasoningEffort(), getProviderChoice()]);
  respond(id, { reasoningEffort, provider });
});

// Any script in the page can dispatch this event, so the place is never taken from
// it: that would let google.com's own JS (or an XSS there) use us to bypass CORS
// and push arbitrary URLs at the server. The only legitimate subject is the Maps
// page this bridge is running in, which we can read ourselves; only the search
// text comes from the event.
document.addEventListener(SERVER_SCORE_GET, (e) => {
  if (!(e instanceof CustomEvent)) return;
  const { id, query, asWritten } = e.detail || {};

  if (!id) return;

  const relay = (msg: ServerScoreMessage) => document.dispatchEvent(
    new CustomEvent(SERVER_SCORE_RESULT, { detail: { id, msg } }));

  if (location.hostname !== 'www.google.com' || !location.pathname.startsWith('/maps/place/')) return relay({ kind: 'end' });

  try {
    const port = chrome.runtime.connect({ name: SERVER_SCORE_PORT });
    port.onMessage.addListener(relay);
    port.onDisconnect.addListener(() => relay({ kind: 'end' }));
    port.postMessage({ url: location.href, query, asWritten: asWritten === true });
  } catch {
    relay({ kind: 'end' }); // context invalidated (extension reloaded)
  }
});
