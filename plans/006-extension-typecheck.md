# Plan 006: Give `packages/extension` a working typecheck and gate it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat <current main SHA> -- packages/extension package.json`
> This plan was split out of plan 002 and is written against the post-002 main
> (commit `b17ca10` or later). `packages/web`/`gmaps-shared` already typecheck and
> the root `check` script already gates them; this plan only adds the extension.

## Status

- **Priority**: P2
- **Effort**: M–L
- **Risk**: MED (each `!`/guard must not mask a real undefined; the TS2322 cluster may surface real bugs)
- **Depends on**: 002 (DONE — root `check` script + CI gate already exist)
- **Category**: dx
- **Planned at**: split from 002 on 2026-06-11; write against current `main`.

## Why this matters

`packages/extension` is never typechecked — it has no `tsconfig.json` and no
`@types/chrome`; esbuild strips types without checking them. Plan 002 established
the web/shared typecheck and the root `bun run check` gate, but **deliberately
deferred the extension** because adding a strict tsconfig surfaces **~96 genuine
type errors** — far past the point where fixing them inline under 002 was safe.
This plan does that work on its own, then wires the extension into the gate so the
whole repo is type-safe.

## Current state

- No `packages/extension/tsconfig.json`. `packages/extension/package.json` has
  `typescript` as a devDep but no `@types/chrome` and no `@types/bun`.
- Root `package.json` `check` script (added by plan 002) is:
  `"check": "bun test && bunx tsc -p packages/gmaps-shared && bunx tsc -p packages/web"`
  — note it does **not** yet include the extension.
- Adding a strict tsconfig (`lib` DOM, `strict`, `noUncheckedIndexedAccess`,
  `types: ["bun","chrome"]`) plus the `@types` produces **~96 errors** (measured).
  After `@types/chrome` + `@types/bun`, **zero** are `Cannot find name 'chrome'` /
  `process`. Breakdown (from a real run):
  - By rule: `TS2532` (possibly undefined) ×34, `TS2345` (arg not assignable) ×30,
    `TS18048` (possibly undefined) ×20, `TS2322` (type not assignable) ×8,
    `TS2538/TS2556/TS2363/TS18047` ×4.
  - By file: `sites/gmaps.ts` 22, `shared/utils.ts` 16, `sites/amazon-product.ts` 9,
    `sites/letterboxd.ts` 7, `sites/gmaps-capture.ts` 6, `shared/score-store.ts` 6,
    `sites/imdb.ts` 4, `sites/amazon-search.ts` 4, plus ~12 files with 1–3 each.
  - ~84/96 are `noUncheckedIndexedAccess` "possibly undefined" — mechanically
    fixable with a bounds-aware `!` assertion, a guard, or a `?? fallback`, exactly
    like the web fixes in plan 002.
  - The **8 `TS2322`** need real attention (a few may be genuine bugs, not just
    annotations): ~3 are `Type '{}' is not assignable to type 'string'` from env-var
    reads, 2 are `number | undefined` not assignable to `number` in
    `amazon-product.ts`, 1 is `string | undefined` vs `string | null` in
    `gmaps-capture.ts`, plus `TS2556` (spread on non-rest param) and `TS2363/TS18047`
    (arithmetic on possibly-null) in `transfermarkt.ts`/`gmaps-capture.ts`.

Conventions: mirror `packages/web/tsconfig.json` (already DOM-enabled, strict,
`noUncheckedIndexedAccess`). `bun:test`. The extension builds with
`bun --cwd packages/extension run build` (esbuild) — that must keep working.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck extension | `cd packages/extension && bunx tsc --noEmit` | exit 0 when done |
| Count errors | `cd packages/extension && bunx tsc --noEmit 2>&1 \| grep -c 'error TS'` | drops to 0 |
| Build extension | `bun --cwd packages/extension run build` | `Build complete → ./truescore/` |
| Full gate | `bun run check` (after Step 4) | exit 0 |

## Scope

**In scope**:
- `packages/extension/tsconfig.json` — **create**.
- `packages/extension/package.json` — add `@types/chrome`, `@types/bun` devDeps + a `typecheck` script.
- The ~96 type errors across `packages/extension/src/**` (annotations / guards / casts; the `TS2322`/`TS2556`/`TS2363` cluster may need a real fix — see STOP conditions).
- Root `package.json` — append ` && bunx tsc -p packages/extension` to the `check` script.
- `bun.lock` — from `bun install`.

**Out of scope**:
- Any runtime/behavior change beyond what a genuine bug fix in the `TS2322` cluster strictly requires (and those must be called out in the report).
- `packages/web`, `packages/gmaps-shared`, the CI workflow (already gated via `bun run check`).

## Git workflow

- Branch: `advisor/006-extension-typecheck`
- Commit per cluster (tsconfig+types; mechanical undefined-safety fixes; the TS2322 fixes; gate). Messages `extension: …` / `dx: …`.

## Steps

### Step 1: Add types + tsconfig
- `packages/extension/package.json`: add to devDependencies `"@types/bun": "latest"`, `"@types/chrome": "latest"`; add script `"typecheck": "tsc --noEmit"`. Run `bun install`.
- Create `packages/extension/tsconfig.json`:
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
**Verify**: `cd packages/extension && bunx tsc --noEmit 2>&1 | grep -c 'error TS'` ≈ 96, and `grep -c "Cannot find name 'chrome'"` is 0.

### Step 2: Fix the mechanical `noUncheckedIndexedAccess` errors (~84)
Work file by file (start with the densest: `sites/gmaps.ts`, `shared/utils.ts`,
`sites/amazon-product.ts`). For each "possibly undefined" at an index access that is
already bounds-checked or provably present, use `arr[i]!`; for an optional value use
`?? fallback`; for a guarded branch use `if (x?.foo)`. **No runtime behavior change.**
Re-run `bunx tsc --noEmit` after each file.

**Verify (checkpoint)**: error count falls to ~12 (only the `TS2322`/`TS2556`/`TS2363` cluster left).

### Step 3: Fix the `TS2322` / `TS2556` / `TS2363` cluster (~8–12) — these may be real
For each: read the surrounding code and decide whether it is a *type* gap (annotate)
or a *real* possibly-wrong-value bug (e.g. `number | undefined` flowing where a
`number` is required, an env var typed `{}`). Prefer the minimal correct fix. If a
fix would change runtime behavior in a way that looks like fixing an actual bug,
that is allowed **but must be described in the report** (do not silently change
behavior). If you cannot tell whether it is a bug, STOP and report that location.

**Verify**: `cd packages/extension && bunx tsc --noEmit` → exit 0, no output.
`bun --cwd packages/extension run build` → `Build complete → ./truescore/`.

### Step 4: Add the extension to the gate
Root `package.json`: change `check` to
`"check": "bun test && bunx tsc -p packages/gmaps-shared && bunx tsc -p packages/web && bunx tsc -p packages/extension"`.
**Verify**: `bun run check` → exit 0.

## Done criteria (ALL must hold)
- [ ] `cd packages/extension && bunx tsc --noEmit` → exit 0, no output.
- [ ] `bun --cwd packages/extension run build` → `Build complete → ./truescore/`.
- [ ] Root `check` includes `bunx tsc -p packages/extension` and `bun run check` exits 0.
- [ ] `bun test` → all pass.
- [ ] Every behavior-changing fix (if any) from Step 3 is listed in the report.
- [ ] `plans/README.md` status row for 006 updated.

## STOP conditions
- A `TS2322`/`TS2556`/`TS2363` location appears to be a real bug whose correct fix
  changes behavior in a way you are not confident about — STOP, report the
  `file:line`, the types involved, and your read of it.
- After Step 2 the residual (non-`noUncheckedIndexedAccess`) error count is far more
  than ~12 — report the categories; the plan's estimate was off.
- The esbuild build breaks after a fix (means a fix changed runtime semantics).

## Maintenance notes
- After this lands, all three packages are gated by `bun run check` and CI.
  `noUncheckedIndexedAccess` is on for the extension — new index access needs guarding.
- A reviewer should scrutinize the Step-3 cluster fixes for any behavior change, and
  any `!` assertion in Step 2 where the "provably present" claim is actually fragile.
