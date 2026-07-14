# 1. Site-script lifecycle: `setupSpaInjector` fits PDPs only

Date: 2026-06-06
Status: Accepted

## Context

The ~20 per-site content scripts in `packages/extension/src/sites/` each detect
a page, fetch/extract data, and inject a score island, surviving SPA navigation.
14 of them hand-roll a `MutationObserver` lifecycle. `setupSpaInjector`
(`shared/spa-injector.ts`) already abstracts that lifecycle —
`{ match, load, inject, cleanup }` plus generation-guarded re-injection and
Navigation-API URL handling — but only 2 sites used it.

An architecture review proposed promoting it to a `runSiteScript` adopted by all
14 hand-rollers. On inspection the hand-rollers are **not** one lifecycle:

- **Single-entity PDPs that derive their id from the URL** (e.g. `ikea-pdp`):
  `load` needs no page DOM, so a once-per-nav load + an idempotent
  inject-on-mutation fits `setupSpaInjector` exactly.
- **PDPs that derive their id from the DOM** (e.g. `dm-pdp`): `load` must wait
  for product DOM to appear; they debounce and re-trigger `load` on
  DOM-appearance, not just on URL change. `setupSpaInjector` runs `load` once
  per nav and would miss the late-DOM case.
- **PLPs / grids** (e.g. `uniqlo-plp`, `*-plp`, `*-search`): process N cards per
  mutation, not one entity — a different shape (the only shared part is
  `process(); new MutationObserver(process)`, ~2 lines).
- **One-shot DOM-compute** (e.g. `airbnb`): no async load at all.
- **Complex bespoke** (`amazon-product`, `booking-hotel`, `goodreads`,
  `letterboxd`, `transfermarkt`): interleaved load/inject, non-`body` observe
  targets, variant logic.

## Decision

Adopt `setupSpaInjector` for **URL-id single-entity PDPs only**
(`ikea-pdp`, alongside the existing `decathlon-pdp`, `uniqlo-pdp`). Leave the
other categories on their own lifecycle. Do not introduce a grid abstraction —
its shared surface (~2 lines) fails the deletion test.

## Consequences

- The duplicated lifecycle is removed where it is genuinely the same; the rest
  stays per-package, matching the "deliberately self-contained" note in
  `CONTEXT.md`.
- A future architecture review should not re-suggest a blanket
  `runSiteScript` migration — the hand-rollers are heterogeneous by need, not by
  neglect. Per-site lifecycle differences (grids, bespoke injection) are
  correctly divergent.

## Update (2026-06-22)

The DOM-id timing case is no longer divergent. `setupSpaInjector` gained an opt-in
`retryUntilLoaded` flag that retries `load()` — debounced on body mutations —
until it returns non-null, instead of calling it once per navigation. This closes
the "PDPs that derive their id from the DOM" gap above, and `dm-pdp` now adopts
`setupSpaInjector` (its candidate resolution lives in `load`, returning null until
the product DOM is present). The blanket-migration caution still holds for
PLPs/grids, one-shot DOM-compute, and the complex-bespoke sites.

## Update (2026-07-14)

The grid picture changed again, and this time it argues *for* a scoped abstraction —
of the *ranking*, not the lifecycle. The "~2 lines shared" premise above held for the
2026-06 grids, but the retail PLP scrapers since then (`etsy`, `aliexpress`, plus the
`dm`/`ikea`/`decathlon`/`uniqlo` grids) now share ~60 byte-identical lines: mark
`data-nps-done` → fetch → set `data-nps` → inject a badge → re-rank the container by
score (scored desc, unscored last), guarded by a reentrancy flag and a debounced
`MutationObserver`. `etsy` and `aliexpress` are near-verbatim twins, and `aliexpress`
is even *missing* the reentrancy guard the others carry — duplication actively shedding
correctness.

Decision: extract that spine into `setupScoreGrid` (`shared/score-grid.ts`), with the
genuinely-varying parts as injected slots — `scoreForCard`, `placeBadge`, container
`discover`, `applyOrder` — plus batteries-included helpers. This is the *ranking behind*
the observer, not a grid *lifecycle* abstraction: the deletion test that failed at
~2 lines passes emphatically at ~60. The heterogeneity caveat is preserved — genuinely
per-site concerns stay per-site (decathlon's dup-hiding `dedupGrid`, ikea's
grid+carousel `discover`), injected or kept in the site script rather than absorbed.

Separately, `etsy-pdp` and `aliexpress-pdp` — single-entity PDPs whose buy-box hydrates
late — now adopt `setupSpaInjector`, extending the URL-id-PDP list. Their island is built
once in `load`; the injector's re-inject-on-mutation handles the late anchor, replacing
each script's hand-rolled anchor observer and `.ars-wrapper` idempotency guard. The
island *content* (`shared/score-island.ts`) is separate from this lifecycle decision, and
the other retail PDPs adopt it incrementally.
