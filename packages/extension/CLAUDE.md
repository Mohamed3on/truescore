# TrueScore

Browser extension that replaces inflated star ratings with scores that actually mean something across shopping, travel, and entertainment sites.

## Build

`bun build.ts` rebuilds into `./truescore/`. Always run after code changes.

## Layout

- `src/sites/` — one `.ts` per site (or page type); self-contained content scripts.
- `src/shared/` — cache, utils, config, review-summary helpers.
- `src/styles/` — CSS for Amazon product + Google Maps panels.
- `src/manifest.json` — content-script registration and host permissions.

## Design

The visual system is recorded in the root `DESIGN.md` (tokens in its frontmatter, rules and components in the body); product truth is in the root `PRODUCT.md`.
