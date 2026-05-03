import { PREVIEW_CAPTURED } from '../shared/gmaps-bridge-protocol';

// MAIN world, document_start. Snoops /maps/preview/place RPC responses (the
// JSON Maps' own app fires on every place page) so harvesters can read chip
// tokens at [6][153][0] without re-fetching or driving the chip UI.
//
// Captures keyed by featureId so back-to-back navigations don't overwrite
// each other's data. Bounded LRU prevents long sessions from accumulating MBs.
(() => {
  if (window.__truescorePreviewCapture) return;
  window.__truescorePreviewCapture = true;
  const cache: Record<string, { json: any; ts: number }> = window.__truescorePreviews ?? {};
  window.__truescorePreviews = cache;

  const MAX_ENTRIES = 20;

  const isPreviewUrl = (u: unknown): boolean => {
    if (!u) return false;
    const s = typeof u === 'string' ? u : String(u);
    return s.includes('/maps/preview/place?') || s.includes('/maps/preview/place%3F');
  };

  const featureIdFromUrl = (u: string): string | null => {
    const m = u.replace(/%3A/gi, ':').match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/i);
    return m ? m[1] : null;
  };

  const store = (url: string, text: string) => {
    const featureId = featureIdFromUrl(url);
    if (!featureId) return;
    try {
      const json = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
      cache[featureId] = { json, ts: Date.now() };
      const keys = Object.keys(cache);
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => cache[a].ts - cache[b].ts);
        for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete cache[keys[i]];
      }
      document.dispatchEvent(new CustomEvent(PREVIEW_CAPTURED, { detail: { featureId } }));
    } catch {}
  };

  const origFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const promise = origFetch.call(this, input, init);
    if (isPreviewUrl(url)) {
      promise.then((r) => r.clone().text()).then((t) => store(url, t)).catch(() => {});
    }
    return promise;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  (XMLHttpRequest.prototype as any).open = function (method: string, url: string | URL, ...rest: any[]) {
    if (isPreviewUrl(url)) {
      this.addEventListener('load', () => {
        try { store(String(url), (this as XMLHttpRequest).responseText); } catch {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
