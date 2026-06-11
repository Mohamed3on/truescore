# Plan 002: One `bun run check` typechecks both packages and CI gates on it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4a3a843..HEAD -- packages/web/tsconfig.json packages/web packages/extension packages/gmaps-shared/src/index.ts .github/workflows/deploy-web.yml package.json`
> If the cited files changed, compare the "Current state" excerpts against the
> live code before proceeding; on a mismatch, treat it as a STOP condition.

> **UPDATE (2026-06-11, after execution):** this was executed as **web-only**. The
> extension portion (Step 2 below — tsconfig + `@types/chrome` + fixing its type
> errors) was **split into [plan 006](006-extension-typecheck.md)** because adding a
> strict extension tsconfig surfaced **~96 genuine type errors**, far past the
> threshold for fixing inline. What landed on `main`: web + `gmaps-shared`
> typecheck cleanly, the root `check` script (`bun test && tsc gmaps-shared && tsc
> web`), and the CI gate. The root `check` does **not** yet include the extension —
> plan 006 adds it. Treat Step 2 and the extension lines in Scope/Done below as
> superseded by 006.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `4a3a843`, 2026-06-11
- **Executed**: web-only; extension split to plan 006

## Why this matters

There is no one-command way to know the repo is healthy, and CI deploys to
production on every push to `main` (`/packages/web/**`) **without running tests or
a typecheck first** — only a post-deploy smoke test. Two concrete gaps make this
worse:

1. `packages/web` does not typecheck: its `tsconfig.json` sets `lib: ["ESNext"]`
   (no DOM) but `client.ts` and `markdown.ts` are browser code → ~130 errors, plus
   ~13 genuine "possibly undefined / unknown" errors in server files and a shared
   function. `bunx tsc --noEmit` currently fails.
2. `packages/extension` has **no `tsconfig.json` and no `@types/chrome`** — it is
   never typechecked at all (esbuild strips types without checking them).

After this plan: `bun run check` at the repo root runs `bun test` plus a clean
`tsc --noEmit` for all three packages, and the deploy workflow runs it before
rsync. A broken type or test stops the deploy instead of reaching users.

## Current state

### Web typecheck (`packages/web`)

`packages/web/tsconfig.json` (full current contents):
```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  }
}
```

Running `cd packages/web && bunx tsc --noEmit` produces ~143 errors. ~130 are in
`client.ts` (110) and `markdown.ts` (20) — all from missing DOM types
(`document`, `HTMLElement`, `RequestInfo`, `Range`, …). Adding `"DOM",
"DOM.Iterable"` to `lib` clears those. The remaining **13 are genuine** and must
be fixed individually (exact list, verified):

```
../gmaps-shared/src/index.ts(330,23): TS2532 Object is possibly 'undefined'.   // h[0]
../gmaps-shared/src/index.ts(330,30): TS2532 Object is possibly 'undefined'.   // h[4]
../gmaps-shared/src/index.ts(339,16): TS2532 Object is possibly 'undefined'.   // h[0]
../gmaps-shared/src/index.ts(339,23): TS2532 Object is possibly 'undefined'.   // h[4]
browser.ts(47,16):  TS2538 Type 'undefined' cannot be used as an index type.   // jar[m[1]]
gemini.ts(43,16):   TS18046 'data' is of type 'unknown'.                        // resp.json()
gemini.ts(44,30):   TS18046 'data' is of type 'unknown'.
gemini.ts(80,30):   TS2532 Object is possibly 'undefined'.                      // itemsMatch?.[1]
resolve.ts(50,45):  TS2532 Object is possibly 'undefined'.                      // placeMatch[1]
resolve.ts(53,43):  TS2532 Object is possibly 'undefined'.                      // qMatch[1]  (x2)
server.ts(310,19):  TS2339 Property 'url' does not exist on type 'unknown'.      // req.json()
server.ts(379,19):  TS2339 Property 'featureId' does not exist on type 'unknown'.// req.json()
```

The fixes (each matches an existing pattern in the same file):

- `server.ts:310` — `const { url } = await req.json();` → `const { url } = await req.json() as { url?: string };` then keep the existing `resolvePlace(url)` call (it already throws on a non-string). Several other routes already cast `req.json()` this way (e.g. `server.ts:344`, `:400`, `:439`).
- `server.ts:379` — `const { featureId } = await req.json();` → `const { featureId } = await req.json() as { featureId?: string };`
- `resolve.ts:49-53` — the capture groups always exist when the regex matched; assert them:
  ```ts
  const placeMatch = url.match(/\/place\/([^/@?]+)/);
  if (placeMatch?.[1]) name = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
  if (!name) {
    const qMatch = url.match(/[?&]q=([^&]+)/);
    if (qMatch?.[1]) name = decodeURIComponent(qMatch[1].split(',')[0]!.replace(/\+/g, ' '));
  }
  ```
  (Note the `[0]!` after `.split(',')` — `split` always returns ≥1 element, but `noUncheckedIndexedAccess` flags the index.)
- `browser.ts:45-47` — guard the regex groups:
  ```ts
  const m = c?.match(/^([^=]+)=([^;]*)/);
  if (m?.[1]) jar[m[1]] = m[2] ?? '';
  ```
- `gemini.ts:42-44` — type the response:
  ```ts
  const data = await resp.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data.error?.message || 'empty Gemini response');
  ```
- `gemini.ts:79-80` — guard the optional match:
  ```ts
  const itemsMatch = text.match(/"items"\s*:\s*\[([^\]]*)\]/);
  const items = cleanItems(itemsMatch?.[1]?.split(',').map((s) => s.replace(/^\s*"|"\s*$/g, '')));
  ```
- `packages/gmaps-shared/src/index.ts:327-341` — make the histogram math undefined-safe (also a correctness hardening: a malformed <5-bucket histogram now scores 0 instead of `NaN`):
  ```ts
  export const overallPctFromHistogram = (h: Histogram): number => {
    const total = h.reduce((a, b) => a + b, 0);
    if (!total) return 0;
    return Math.round((((h[0] ?? 0) - (h[4] ?? 0)) / total) * 100);
  };

  export const overallScoreFromHistogram = (h: Histogram): number => {
    const total = h.reduce((a, b) => a + b, 0);
    if (!total) return 0;
    const diff = (h[0] ?? 0) - (h[4] ?? 0);
    return Math.round((diff * Math.abs(diff)) / total);
  };
  ```

### Extension typecheck (`packages/extension`)

No `tsconfig.json` exists. `package.json` has `typescript` as a devDep but no
`@types/chrome`. Probing with `--strict --lib ESNext,DOM,DOM.Iterable` yields ~42
errors; **20 are `Cannot find name 'chrome'`** (fixed by `@types/chrome`), ~1 is
`process` not found (fixed by `@types/bun`), leaving ~20 genuine type errors spread
across `background.ts` (implicit-any params), `popup/popup.ts` (a few property /
redeclare issues), `amazon-search.ts`, `transfermarkt.ts`, `gmaps-bridge.ts`,
`booking-search.ts`, `gmaps.ts`, `gmaps-capture.ts`. These are small (add a type
annotation, a guard, an explicit cast). The extension already depends on
`@truescore/gmaps-shared` (`workspace:*`).

### Root + CI

`package.json` (root) scripts:
```json
"scripts": {
  "build:extension": "bun --cwd packages/extension run build",
  "deploy:web": "SERVER=root@65.108.153.112 ./deploy/sync.sh"
}
```
No `check`. `.github/workflows/deploy-web.yml` runs `Configure SSH` → `Sync to
Hetzner` (`./deploy/sync.sh`) → `Smoke test`. **No `bun test` / `tsc` step before
the sync.**

Conventions: `bun:test`, `bunx tsc --noEmit` per package. `gmaps-shared` already
has a passing minimal tsconfig (`packages/gmaps-shared/tsconfig.json`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (root, workspaces) | `bun install` | exit 0 |
| Typecheck web | `cd packages/web && bunx tsc --noEmit` | exit 0, no output |
| Typecheck shared | `cd packages/gmaps-shared && bunx tsc --noEmit` | exit 0, no output |
| Typecheck extension | `cd packages/extension && bunx tsc --noEmit` | exit 0, no output |
| Tests | `bun test` | all pass (37+ currently) |
| Full gate | `bun run check` (after Step 4) | exit 0 |

## Scope

**In scope**:
- `packages/web/tsconfig.json` — add DOM libs.
- `packages/web/server.ts`, `packages/web/gemini.ts`, `packages/web/resolve.ts`, `packages/web/browser.ts` — the ~13 genuine fixes above.
- `packages/gmaps-shared/src/index.ts` — the two histogram functions (lines 327-341).
- `packages/extension/tsconfig.json` — **create**.
- `packages/extension/package.json` — add `@types/chrome`, `@types/bun` devDeps + a `typecheck` script.
- The genuine extension type errors in the files listed above (annotations/guards only).
- `package.json` (root) — add the `check` script.
- `.github/workflows/deploy-web.yml` — add a pre-deploy check step.
- Lockfiles (`bun.lock`) — will update from `bun install`; commit them.

**Out of scope** (do NOT touch):
- Any runtime/behavioral change. This plan is types + config only. If a "fix" for
  a type error would change runtime behavior beyond the undefined-safety shown
  above, STOP and report.
- `plan 001`'s files if 001 hasn't merged — coordinate by rebasing, don't redo it.
- Reformatting unrelated code.

## Git workflow

- Branch: `advisor/002-verification-baseline`
- Commit per logical unit (web types; extension tsconfig+types; root+CI). Message
  style `web: …` / `extension: …` / `ci: …` to match `git log`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Make `packages/web` typecheck

1a. In `packages/web/tsconfig.json`, change `"lib": ["ESNext"]` to
`"lib": ["ESNext", "DOM", "DOM.Iterable"]`.

**Verify**: `cd packages/web && bunx tsc --noEmit` now prints ONLY the ~13 genuine
errors listed in "Current state" (no more `Cannot find name 'document'` etc.).
`bunx tsc --noEmit 2>&1 | grep -c 'error'` should drop to ~13.

1b. Apply the 13 fixes exactly as written in "Current state" (server.ts ×2,
resolve.ts, browser.ts, gemini.ts ×2, gmaps-shared/index.ts ×2 functions).

**Verify**: `cd packages/web && bunx tsc --noEmit` → exit 0, **no output**.
Also `cd packages/gmaps-shared && bunx tsc --noEmit` → still exit 0 (the
histogram edit must not break the shared package's own check).
Also `bun test` → still all pass (the histogram functions are covered indirectly;
do not change their behavior for valid 5-bucket inputs).

### Step 2: Give `packages/extension` a tsconfig and types

2a. Add `@types/chrome` and `@types/bun` to `packages/extension/package.json`
devDependencies and a `typecheck` script:
```json
"scripts": {
  "build": "bun build.ts",
  "watch": "bun build.ts --watch",
  "typecheck": "tsc --noEmit"
},
"devDependencies": {
  "@types/bun": "latest",
  "@types/chrome": "latest",
  "esbuild": "^0.25.0",
  "typescript": "^5.7.0"
}
```
Run `bun install` at the repo root.

2b. Create `packages/extension/tsconfig.json`. Mirror the web package's flags so
the strictness is consistent, with DOM + chrome + bun types:
```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "types": ["bun", "chrome"]
  },
  "include": ["src/**/*.ts", "build.ts"]
}
```

**Verify**: `cd packages/extension && bunx tsc --noEmit` now prints a bounded list
of genuine errors (expected ~20; the `Cannot find name 'chrome'` / `process`
errors should be gone). Count them: `bunx tsc --noEmit 2>&1 | grep -c 'error TS'`.

2c. Fix the genuine extension type errors (annotations, guards, casts — no
behavior change). They are concentrated in `background.ts`, `popup/popup.ts`,
`amazon-search.ts`, `transfermarkt.ts`, `gmaps-bridge.ts`, `booking-search.ts`,
`gmaps.ts`, `gmaps-capture.ts`. Work file by file; re-run `tsc --noEmit` after
each.

**Verify**: `cd packages/extension && bunx tsc --noEmit` → exit 0, no output.
Then rebuild to be sure nothing broke: `bun --cwd packages/extension run build`
→ logs `Build complete → ./truescore/`.

### Step 3: Confirm the shared package still checks

**Verify**: `cd packages/gmaps-shared && bunx tsc --noEmit` → exit 0. (No changes
needed beyond Step 1b's histogram edit; this is a guard.)

### Step 4: Add the root `check` script

In root `package.json`, add this `check` script. It points `tsc` at each package's
own `tsconfig.json` via `-p` (all three set `noEmit: true`, so no `--noEmit` flag
is needed and there is no `cd`):
```json
"check": "bun test && bunx tsc -p packages/gmaps-shared && bunx tsc -p packages/web && bunx tsc -p packages/extension"
```
The requirement: `bun run check` runs `bun test` and a typecheck for all three
packages and exits non-zero if any fails. (`packages/extension/tsconfig.json` must
already exist from Step 2 for the last segment to work.)

**Verify**: from repo root, `bun run check` → exit 0 (tests pass, all three
typechecks clean). Confirm it FAILS when something is broken: temporarily add a
type error to `packages/web/server.ts` (e.g. `const x: number = 'str';`), run
`bun run check`, confirm non-zero exit, then revert.

### Step 5: Gate the deploy on `check`

In `.github/workflows/deploy-web.yml`, add a step that installs Bun, installs
deps, and runs the gate **before** the `Sync to Hetzner` step. Add a Bun setup
(this repo's workflow currently only does SSH). Insert after `actions/checkout@v5`
and before `Configure SSH`:
```yaml
      - uses: oven-sh/setup-bun@v2

      - name: Install & check
        run: |
          bun install
          bun run check
```

**Verify**: `grep -n "bun run check" .github/workflows/deploy-web.yml` → matches,
and the step is positioned before `Sync to Hetzner` (read the file to confirm
order). You cannot run GitHub Actions locally; the local `bun run check` passing
in Step 4 is the proxy. Do NOT trigger a real deploy to test.

## Test plan

This plan adds no new unit tests; its gate is the typecheckers plus the existing
`bun test`. The only behavioral edit is the histogram undefined-safety in
`gmaps-shared/index.ts`, which is value-preserving for all valid 5-bucket inputs
(plan 003 adds explicit tests for these functions — if 003 has already landed,
re-run `bun test` and confirm its histogram tests still pass).

Verification: `bun run check` → exit 0.

## Done criteria

ALL must hold:

- [ ] `cd packages/web && bunx tsc --noEmit` → exit 0, no output.
- [ ] `cd packages/extension && bunx tsc --noEmit` → exit 0, no output.
- [ ] `cd packages/gmaps-shared && bunx tsc --noEmit` → exit 0, no output.
- [ ] `bun test` → all pass (≥37).
- [ ] `bun run check` exists in root `package.json` and exits 0.
- [ ] `bun --cwd packages/extension run build` still logs `Build complete → ./truescore/`.
- [ ] `.github/workflows/deploy-web.yml` runs `bun run check` before the Hetzner sync.
- [ ] Only types/config files changed — no runtime behavior change (`git diff` review).
- [ ] `plans/README.md` status row for 002 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- After adding the extension tsconfig and `@types/chrome`/`@types/bun`, more than
  **40** genuine (non-`chrome`, non-`process`) errors appear. That means the
  estimate was wrong; report the count and the top error categories so we can
  scope the extension typecheck as its own plan rather than fixing 40+ blind.
- Any "type fix" can only be made by changing runtime behavior (not just an
  annotation/guard/cast). Report the specific error and code.
- `bun --cwd packages/extension run build` fails after the type fixes (the tsconfig
  is for checking only; esbuild does the building — if the build breaks, a fix
  changed runtime semantics).
- The drift check shows the cited files moved since `4a3a843`.

## Maintenance notes

- New code in either package is now typechecked by `bun run check`; keep CI green.
- The web package now has DOM types on the **server** files too (`server.ts`,
  `browser.ts`). That slightly weakens server-side safety (a stray `document`
  reference in server code would no longer error). If that ever bites, the
  principled follow-up is a separate `tsconfig.client.json` with DOM and a
  server tsconfig without it; deferred here to keep the change minimal.
- `noUncheckedIndexedAccess` is on for the extension now — new array/object index
  access needs guarding. That is the intended ratchet.
- A reviewer should scrutinize the extension type fixes in Step 2c for any
  accidental behavior change (a guard that now early-returns where the old code
  fell through).
