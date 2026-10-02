import { MAPS_CREDS_CAPTURED, PREVIEW_CAPTURED, type MapsCapturedCreds } from '../shared/gmaps-bridge-protocol';
import { credsFromBatchExecute, installMapsSigner } from '@truescore/gmaps-shared';

// MAIN world, document_start — early enough that our fetch/XHR patches wrap the
// references before Maps' own app grabs them. Two captures:
//
// 1. /maps/preview/place RPC responses (chip tokens at [6][153][0]) — keyed by
//    featureId so back-to-back navigations don't clobber each other.
// 2. Botguard creds off Google's ListUgcPosts batchexecute request (bgkey in the
//    request headers, at/sessionId in the body). Google retired the legacy GET
//    listugcposts endpoint; the only way to fetch reviews now is to replay this
//    batchexecute. A capture carries the session (sessionId, at, authuser) that
//    gmaps.ts keeps; each replay's key is signed separately by Maps' own BotGuard
//    (__truescoreSignMaps below).
(() => {
  const cache: Record<string, { json: any; ts: number }> = {};
  window.__truescorePreviews = cache;

  const MAX_ENTRIES = 20;

  const isPreviewUrl = (u: string | URL) => String(u).includes('/maps/preview/place?');

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

  // Active half of the capture: nudge Maps into firing a review batchexecute on
  // demand and resolve when storeCreds next intercepts one. The consumer
  // (gmaps.ts) just awaits window.__truescoreRequestMapsCreds() rather than
  // owning the DOM nudge + wait. Deduped to one in-flight nudge.
  const CAPTURE_WAIT_MS = 6000;
  let captureResolve: ((c: MapsCapturedCreds | null) => void) | null = null;
  let captureInFlight: Promise<MapsCapturedCreds | null> | null = null;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  const settleCapture = (c: MapsCapturedCreds | null) => {
    clearTimeout(captureTimer);
    captureTimer = undefined;
    const resolve = captureResolve;
    captureResolve = null;
    captureInFlight = null;
    resolve?.(c);
  };
  // Anchor on the rating histogram (.jANrlb) or a review card, both in the
  // scrolling pane — Maps loads the list only once it scrolls into view, so a
  // list pushed below the fold (e.g. by a removal notice) has no card yet.
  const findReviewsScroll = (): HTMLElement | null => {
    let el = document.querySelector<HTMLElement>('.jftiEf[data-review-id], .jANrlb')?.parentElement ?? null;
    while (el) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return null;
  };
  // Google's own visual-element id for the Reviews tab (jslog "145620") is the
  // same in every language; an English aria-label match silently missed every
  // non-English UI (German "Rezensionen zu …").
  const reviewsTab = () => document.querySelector<HTMLElement>('button[role="tab"][jslog^="145620"]');
  const requestCapture = (): Promise<MapsCapturedCreds | null> => {
    if (captureInFlight) return captureInFlight;
    captureInFlight = new Promise((resolve) => { captureResolve = resolve; });
    // Open the Reviews tab if needed, then scroll — Maps fires the bgkey-bearing
    // batchexecute when the list loads or paginates; a no-op click on an already-
    // open tab won't refetch, but a scroll forces the next page. Both are retried
    // because on a cold load the first nudge lands before Maps has rendered the
    // tabs at all: only the scroll used to repeat, so the click was lost and
    // nothing re-nudges once the page goes quiet (the observer's retry needs a
    // mutation).
    // Scrolling the Overview pane lazy-loads its own reviews section and usually
    // yields creds without leaving the tab the user is on, so the click is a
    // fallback: skipped once anything has been captured.
    const nudgeOnce = () => {
      if (!window.__truescoreMapsCreds) reviewsTab()?.click();
      findReviewsScroll()?.scrollBy({ top: 1e6 });
    };
    nudgeOnce();
    setTimeout(nudgeOnce, 1200);
    setTimeout(nudgeOnce, 3000);
    // A capture settles it at once (storeCreds); none by now and Maps isn't sending one.
    captureTimer = setTimeout(() => settleCapture(null), CAPTURE_WAIT_MS);
    return captureInFlight;
  };
  window.__truescoreRequestMapsCreds = requestCapture;

  // Our replays are signed the way Maps signs its own (see installMapsSigner). Maps
  // builds its VM the first time it needs a key, and nudging its review list does that.
  installMapsSigner();
  const signOnce = window.__truescoreSignMaps!;
  window.__truescoreSignMaps = async (request) => {
    const key = await signOnce(request);
    if (key) return key;
    await requestCapture();
    return signOnce(request);
  };

  // Maps' own review request is the only one carrying x-maps-bgkey with a source-path
  // (our replays send no source-path; re-saving them as captures kept a stale set
  // from ever giving way to a fresh one). credsFromBatchExecute lifts sessionId + at.
  const storeCreds = (url: string, req: Request, body: string) => {
    const bgkey = req.headers.get('x-maps-bgkey');
    if (!bgkey) return;
    const { sessionId, at } = credsFromBatchExecute(bgkey, '', body);
    if (!sessionId) return;
    // The signed-in account Maps sent this as — the creds only replay as that account.
    const authuser = new URL(url, location.href).searchParams.get('authuser') ?? undefined;
    const creds: MapsCapturedCreds = { bgkey, bgbind: '', sessionId, at, authuser, ts: Date.now() };
    window.__truescoreMapsCreds = creds;
    document.dispatchEvent(new CustomEvent(MAPS_CREDS_CAPTURED, { detail: creds }));
    settleCapture(creds);
  };

  const origFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    // Maps sends its review request as a bare Request (2026-10), headers and body on
    // it rather than in init; one Request reads any call shape. Cloned, so the body
    // Maps sends stays unread.
    if (url.includes('batchexecute') && url.includes('source-path')) try {
      const req = new Request(input instanceof Request ? input.clone() : input, init);
      req.text().then((body) => storeCreds(url, req, body)).catch(() => {});
    } catch {}
    const promise = origFetch.call(this, input, init);
    if (isPreviewUrl(url)) {
      promise.then((r) => r.clone().text()).then((t) => store(url, t)).catch(() => {});
    }
    return promise;
  };

  // Maps fetches the place preview over XHR.
  const origOpen = XMLHttpRequest.prototype.open;
  (XMLHttpRequest.prototype as any).open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    if (isPreviewUrl(url)) {
      this.addEventListener('load', () => { try { store(String(url), this.responseText); } catch {} });
    }
    return (origOpen as (...a: any[]) => void).call(this, method, url, ...rest);
  };
})();
