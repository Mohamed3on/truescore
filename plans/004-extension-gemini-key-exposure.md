# Plan 004: Stop shipping the Gemini API key inside the extension bundle

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4a3a843..HEAD -- packages/extension/build.ts packages/extension/src/shared/config.ts packages/extension/src/shared/review-summary.ts packages/extension/src/popup/popup.ts`
> If any cited file changed, compare the "Current state" excerpts against the
> live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (changes the extension's default key source — see "Why")
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `4a3a843`, 2026-06-11

## ⚠️ Required human action before/with this change: rotate the key

The current Gemini API key has been compiled into shippable extension bundles, so
it must be treated as **burned**. A human with access to Google AI Studio must
**revoke the existing `GEMINI_API_KEY` and issue a new one** (the new key goes only
into server-side `.env` for the web app, and/or into each user's popup — never into
the bundle again). The executor model cannot do this. Do not put any key value in
this plan, any commit, or any file. If you (the executor) cannot confirm rotation
happened, proceed with the code changes anyway and note in your report that
rotation is still outstanding — the code change is what stops *future* leakage.

## Why this matters

`packages/extension/build.ts` bakes `GEMINI_API_KEY` (read from `.env`) into every
bundled content script via esbuild `define`. Anyone who obtains a built bundle
(`creamcrop.zip` exists in the repo, implying packaged distribution; even an
unpacked install exposes it) can read the key out of the JavaScript and spend
against the quota. The web app does **not** have this problem — it calls Gemini
server-side. This plan removes the asymmetry: the extension stops embedding a key
and relies solely on the per-user key the popup already manages in
`chrome.storage.sync`.

**Behavioral consequence (this is the MED risk):** after this change, the
extension's AI features (review summaries on Amazon/Booking/Letterboxd/BJJ
Fanatics, etc.) will do nothing until the user sets their own Gemini key in the
TrueScore popup. The popup UI for this already exists, and the code already shows a
"No Gemini API key — set one in the TrueScore popup" message when none is set. For
the Google Maps panel specifically there is **no** regression — `gmaps.ts` gets its
AI from the web server proxy, not the baked key (verified: no extension site script
imports the synchronous key).

## Current state

`packages/extension/build.ts` (the leak — lines 8-11 read the key, 48-50 inject it):
```ts
const envFile = (() => { try { return readFileSync('.env', 'utf8'); } catch { return ''; } })();
const GEMINI_API_KEY =
  envFile.match(/^GEMINI_API_KEY=(.+)$/m)?.[1].trim() || process.env.GEMINI_API_KEY || '';
// ...
  define: {
    'process.env.GEMINI_API_KEY': JSON.stringify(GEMINI_API_KEY),
  },
```
(The `define` block is inside the **first** `esbuild.build({...})` call, the site
scripts bundle. The background and popup bundles have no `define`.)

`packages/extension/src/shared/config.ts` (full — the fallback that consumes it):
```ts
// Build-time fallback (from GEMINI_API_KEY env var)
const BUILD_TIME_KEY = process.env.GEMINI_API_KEY as string;

// Runtime key from chrome.storage, falling back to build-time key
export async function getGeminiApiKey(): Promise<string> {
  try {
    const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
    return geminiApiKey || BUILD_TIME_KEY || '';
  } catch {
    // MAIN world scripts can't access chrome.storage
    return BUILD_TIME_KEY || '';
  }
}

// Sync export for MAIN world scripts (gmaps) that can't use chrome.storage
export const GEMINI_API_KEY = BUILD_TIME_KEY || '';

export const GEMINI_MODEL = 'gemini-3-flash-preview';

export const geminiEndpoint = (apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
```

Verified facts that make this safe to simplify:
- The **only** importer of anything from `config.ts` is
  `packages/extension/src/shared/review-summary.ts` (imports `getGeminiApiKey`,
  `geminiEndpoint`). It already handles an empty key:
  `review-summary.ts:75-76` → `const apiKey = await getGeminiApiKey(); if (!apiKey) throw new Error('No Gemini API key — set one in the TrueScore popup');`
- The synchronous `export const GEMINI_API_KEY` has **no importers anywhere**
  (`grep -rn "GEMINI_API_KEY" packages/extension/src | grep -v config.ts` → only
  `getGeminiApiKey`). It is dead.
- The popup already reads/writes the user key:
  `packages/extension/src/popup/popup.ts:6` `chrome.storage.sync.get('geminiApiKey', …)`,
  `:16` `chrome.storage.sync.set({ geminiApiKey: key }, …)`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Build extension | `bun --cwd packages/extension run build` | `Build complete → ./truescore/` |
| Grep built output for a key var | `grep -rn "GEMINI_API_KEY" packages/extension/truescore/ \| head` | only references to `process.env...` should be gone (see Step 3) |
| Tests | `bun test packages/extension/` | all pass |

## Scope

**In scope**:
- `packages/extension/build.ts` — remove the `.env` read and the `define`.
- `packages/extension/src/shared/config.ts` — remove `BUILD_TIME_KEY` and the dead sync export; `getGeminiApiKey` returns only the popup key.

**Out of scope** (do NOT touch):
- `review-summary.ts` — it already handles the no-key case; no change needed.
- `popup/popup.ts` — the key-setting UI already works.
- The web package — it is not affected (its key stays server-side).
- `gmaps.ts` and the maps panel — they use the server proxy, not this key.
- Do not add a new proxy path for the extension's summaries in this plan (the
  extension and web use different summary schemas; routing through the proxy is a
  larger change recorded as a direction option, not part of this security fix).

## Git workflow

- Branch: `advisor/004-extension-gemini-key`
- Commit style `extension: …` to match `git log`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Stop injecting the key at build time

In `packages/extension/build.ts`:
- Delete the `envFile` / `GEMINI_API_KEY` lines (the `const envFile = …` and the
  `const GEMINI_API_KEY = …` block, lines 8-11) and their explanatory comment.
- Delete the `define` option from the site-scripts `esbuild.build({...})` call
  (lines 48-50):
  ```ts
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(GEMINI_API_KEY),
    },
  ```
  Remove the whole `define` key. Leave the rest of that build call intact.

**Verify**: `grep -n "GEMINI_API_KEY\|define" packages/extension/build.ts` → no
matches. `bun --cwd packages/extension run build` → `Build complete → ./truescore/`.

### Step 2: Make `getGeminiApiKey` return only the user's popup key

Replace `packages/extension/src/shared/config.ts` with:
```ts
// The Gemini key is per-user: set in the TrueScore popup, stored in
// chrome.storage.sync. It is deliberately NOT bundled — a key compiled into the
// extension is readable by anyone who unpacks it.
export async function getGeminiApiKey(): Promise<string> {
  try {
    const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
    return geminiApiKey || '';
  } catch {
    // MAIN-world scripts can't reach chrome.storage; they use the web proxy, not this.
    return '';
  }
}

export const GEMINI_MODEL = 'gemini-3-flash-preview';

export const geminiEndpoint = (apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
```
(This removes `BUILD_TIME_KEY` and the dead `export const GEMINI_API_KEY`.)

**Verify**:
- `grep -rn "BUILD_TIME_KEY\|process.env" packages/extension/src/shared/config.ts` → no matches.
- `grep -rn "GEMINI_API_KEY" packages/extension/src` → only matches inside comments / the env-var *name* if any; **no code import** of a `GEMINI_API_KEY` symbol. (The async `getGeminiApiKey` is the only export used.)
- `bun --cwd packages/extension run build` → builds clean.
- `bun test packages/extension/` → all pass.

### Step 3: Confirm the built bundle carries no key

The build no longer defines `process.env.GEMINI_API_KEY`, so esbuild leaves the
reference unresolved — but since nothing reads it anymore, it should be absent.

**Verify**: `grep -rn "geminiApiKey\|generativelanguage" packages/extension/truescore/ | head`
should show the endpoint string and the `chrome.storage.sync.get('geminiApiKey')`
read, but **no literal API key value**. Spot-check by eye that no
`AIza…`-shaped string appears: `grep -rEn "AIza[0-9A-Za-z_-]{10,}" packages/extension/truescore/`
→ **no matches**. (If this matches, the old key is still embedded — STOP.)

## Test plan

No new unit tests (this is a config/removal change; the AI path is network code
that the suite doesn't mock). Verification is the grep gates in Steps 2-3 plus a
clean build and the existing `bun test`.

Optional manual check (only if you can load the unpacked extension):
1. Load `packages/extension/truescore/` unpacked with **no** key set in the popup.
2. Trigger a review summary on a supported site → expect the visible message
   "No Gemini API key — set one in the TrueScore popup" (not a silent failure).
3. Set a key in the popup → the summary now works.

## Done criteria

ALL must hold:

- [ ] `grep -n "define\|GEMINI_API_KEY" packages/extension/build.ts` → no matches.
- [ ] `packages/extension/src/shared/config.ts` has no `BUILD_TIME_KEY` and no `export const GEMINI_API_KEY`.
- [ ] `grep -rEn "AIza[0-9A-Za-z_-]{10,}" packages/extension/truescore/` → no matches.
- [ ] `bun --cwd packages/extension run build` succeeds.
- [ ] `bun test packages/extension/` → all pass.
- [ ] Report states whether key rotation was completed by a human (or flags it outstanding).
- [ ] `plans/README.md` status row for 004 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- `grep -rn "GEMINI_API_KEY" packages/extension/src` reveals a **code import** of
  the synchronous `GEMINI_API_KEY` symbol (not `getGeminiApiKey`) anywhere — that
  means a content script depends on the baked key and removing it would break that
  feature. Report the file; the plan must be revised to bridge the key from
  `chrome.storage` for that script.
- After the change, the built bundle still contains an `AIza…`-shaped string.
- The drift check shows the cited files moved since `4a3a843`.

## Maintenance notes

- The invariant: **no API key, ever, in `build.ts` `define` or any bundled source.**
  A reviewer should reject any PR that re-adds a `define` of a secret.
- `.env` in `packages/extension/` is no longer read by the build; it can stay for
  local reference but is inert. (It is gitignored — confirmed.)
- Deferred direction (not this plan): route the extension's summaries through the
  web server's `/api/summarize` / `/api/ask` (which already accept
  extension-supplied `reviewTexts`) so users don't need their own key at all. That
  requires reconciling the two summary schemas and is a feature change, recorded in
  `plans/README.md`.
