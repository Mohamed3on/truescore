import { MAPS_CREDS_CAPTURED, PREVIEW_CAPTURED, type MapsCapturedCreds } from '../shared/gmaps-bridge-protocol';

// MAIN world, document_start — early enough that our fetch/XHR patches wrap the
// references before Maps' own app grabs them. Two captures:
//
// 1. /maps/preview/place RPC responses (chip tokens at [6][153][0]) — keyed by
//    featureId so back-to-back navigations don't clobber each other.
// 2. Botguard creds off Google's ListUgcPosts batchexecute XHR (bgkey/bgbind in
//    request headers, at/sessionId in the body). Google retired the legacy GET
//    listugcposts endpoint; the only way to fetch reviews now is to replay this
//    batchexecute, and its x-maps-bgkey can't be forged — only lifted here. One
//    capture is session-bound (reusable across places/sorts/tokens), so gmaps.ts
//    caches it globally and refreshes whenever a newer one flies by.
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

  // Normalise fetch's many header shapes (Headers | [k,v][] | object) to lowercase keys.
  const headerMap = (hh: any): Record<string, string> => {
    const h: Record<string, string> = {};
    if (!hh) return h;
    if (typeof hh.forEach === 'function' && !Array.isArray(hh)) hh.forEach((v: string, k: string) => (h[k.toLowerCase()] = v));
    else if (Array.isArray(hh)) for (const [k, v] of hh) h[String(k).toLowerCase()] = v;
    else for (const k of Object.keys(hh)) h[k.toLowerCase()] = hh[k];
    return h;
  };

  // The only request carrying x-maps-bgkey is the review-list batchexecute, so
  // that header alone identifies it. sessionId is the 81-tagged token in the
  // bgbind (or the f.req body): ["<sid>",null,null,null,null,null,81].
  const SID_RE = /\["([A-Za-z0-9_-]{16,}?)",null,null,null,null,null,81\]/;
  const storeCreds = (urlStr: string, headers: Record<string, string>, body: unknown) => {
    if (!/batchexecute/.test(urlStr)) return;
    const bgkey = headers['x-maps-bgkey'];
    if (!bgkey) return;
    const bgbind = headers['x-maps-bgbind'] || '';
    const bodyStr = typeof body === 'string' ? body : '';
    let decoded = bodyStr;
    try { decoded = decodeURIComponent(bodyStr); } catch {}
    const sessionId = (bgbind.match(SID_RE) || decoded.match(SID_RE) || [])[1];
    if (!sessionId) return;
    const atRaw = (bodyStr.match(/(?:^|&)at=([^&]+)/) || [])[1];
    const creds: MapsCapturedCreds = {
      bgkey,
      bgbind,
      sessionId,
      at: atRaw ? decodeURIComponent(atRaw) : '',
      ts: Date.now(),
    };
    window.__truescoreMapsCreds = creds;
    document.dispatchEvent(new CustomEvent(MAPS_CREDS_CAPTURED, { detail: creds }));
  };

  const origFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    try { storeCreds(url, headerMap(init?.headers), init?.body); } catch {}
    const promise = origFetch.call(this, input, init);
    if (isPreviewUrl(url)) {
      promise.then((r) => r.clone().text()).then((t) => store(url, t)).catch(() => {});
    }
    return promise;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;
  type CapXHR = XMLHttpRequest & { __tsUrl?: string; __tsHeaders?: Record<string, string> };
  (XMLHttpRequest.prototype as any).open = function (this: CapXHR, method: string, url: string | URL, ...rest: any[]) {
    this.__tsUrl = String(url);
    this.__tsHeaders = {};
    if (isPreviewUrl(url)) {
      this.addEventListener('load', () => { try { store(String(url), this.responseText); } catch {} });
    }
    return (origOpen as (...a: any[]) => void).call(this, method, url, ...rest);
  };
  (XMLHttpRequest.prototype as any).setRequestHeader = function (this: CapXHR, name: string, value: string) {
    if (this.__tsHeaders) this.__tsHeaders[name.toLowerCase()] = value;
    return origSetHeader.call(this, name, value);
  };
  (XMLHttpRequest.prototype as any).send = function (this: CapXHR, body?: Document | XMLHttpRequestBodyInit | null) {
    try { if (this.__tsUrl) storeCreds(this.__tsUrl, this.__tsHeaders || {}, body); } catch {}
    return origSend.call(this, body as any);
  };
})();
