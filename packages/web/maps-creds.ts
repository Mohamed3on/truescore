import type { MapsCreds } from '@truescore/gmaps-shared';

// Botguard creds for the ListUgcPosts batchexecute RPC (the legacy GET endpoint
// is retired). The server can't mint an x-maps-bgkey itself — it has no browser
// JS — so for now they're supplied out-of-band via env (paste a set captured
// from a logged-in Maps tab to test locally). Task 6 replaces this with a
// headless browser that mints + refreshes a set on a timer; the rest of the
// review path already calls through here, so only this function changes.
let cached: MapsCreds | null = null;

export function setMapsCreds(creds: MapsCreds): void {
  cached = creds;
}

// null when unconfigured — callers degrade to an empty score rather than throw,
// so a creds-less deploy behaves like the (already review-less) status quo until
// the headless minter lands, instead of erroring the whole lookup.
export function getMapsCreds(): MapsCreds | null {
  if (cached) return cached;
  const bgkey = process.env.TRUESCORE_MAPS_BGKEY;
  const bgbind = process.env.TRUESCORE_MAPS_BGBIND;
  const sessionId = process.env.TRUESCORE_MAPS_SESSION;
  const at = process.env.TRUESCORE_MAPS_AT;
  if (bgkey && bgbind && sessionId && at) {
    cached = { bgkey, bgbind, sessionId, at, hl: 'en' };
    return cached;
  }
  return null;
}
