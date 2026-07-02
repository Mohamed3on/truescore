import { MAPS_CREDS_CAPTURED, PREVIEW_CAPTURED, type MapsCapturedCreds } from '../shared/gmaps-bridge-protocol';
import { credsFromBatchExecute } from '@truescore/gmaps-shared';

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

  // The only request carrying x-maps-bgkey is the review-list batchexecute, so that
  // header alone identifies it; credsFromBatchExecute lifts sessionId + at from it.

  // Active half of the capture: nudge Maps into firing a review batchexecute on
  // demand and resolve when storeCreds next intercepts one. The consumer
  // (gmaps.ts) just awaits window.__truescoreRequestMapsCreds() rather than
  // owning the DOM nudge + wait. Deduped to one in-flight nudge.
  const CAPTURE_WAIT_MS = 6000;
  let captureResolve: ((c: MapsCapturedCreds | null) => void) | null = null;
  let captureInFlight: Promise<MapsCapturedCreds | null> | null = null;
  const settleCapture = (c: MapsCapturedCreds | null) => {
    const resolve = captureResolve;
    captureResolve = null;
    captureInFlight = null;
    resolve?.(c);
  };
  const findReviewsScroll = (): HTMLElement | null => {
    let el = document.querySelector<HTMLElement>('.jftiEf[data-review-id]')?.parentElement ?? null;
    while (el) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return null;
  };
  const requestCapture = (): Promise<MapsCapturedCreds | null> => {
    if (captureInFlight) return captureInFlight;
    captureInFlight = new Promise((resolve) => { captureResolve = resolve; });
    // Open the Reviews tab if needed, then scroll — Maps fires the bgkey-bearing
    // batchexecute when the list loads or paginates; a no-op click on an already-
    // open tab won't refetch, but a scroll forces the next page.
    document.querySelector<HTMLElement>('button[role="tab"][aria-label*="eview" i]')?.click();
    const scrollOnce = () => findReviewsScroll()?.scrollBy({ top: 1e6 });
    scrollOnce();
    setTimeout(scrollOnce, 1200);
    setTimeout(() => settleCapture(window.__truescoreMapsCreds ?? null), CAPTURE_WAIT_MS);
    return captureInFlight;
  };
  window.__truescoreRequestMapsCreds = requestCapture;

  const storeCreds = (urlStr: string, headers: Record<string, string>, body: unknown) => {
    if (!urlStr.includes('batchexecute')) return;
    const bgkey = headers['x-maps-bgkey'];
    if (!bgkey) return;
    const bgbind = headers['x-maps-bgbind'] || '';
    const bodyStr = typeof body === 'string' ? body : '';
    const { sessionId, at } = credsFromBatchExecute(bgkey, bgbind, bodyStr);
    if (!sessionId) return;
    const creds: MapsCapturedCreds = { bgkey, bgbind, sessionId, at, ts: Date.now() };
    window.__truescoreMapsCreds = creds;
    document.dispatchEvent(new CustomEvent(MAPS_CREDS_CAPTURED, { detail: creds }));
    settleCapture(creds);
  };

  const origFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    // Gate on the URL before normalising headers — Maps fires many fetches per
    // interaction and only the review RPC carries creds.
    if (url.includes('batchexecute')) try { storeCreds(url, headerMap(init?.headers), init?.body); } catch {}
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
