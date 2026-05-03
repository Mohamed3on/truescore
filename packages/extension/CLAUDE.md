# TrueScore

Browser extension that replaces inflated star ratings with scores that actually mean something across shopping, travel, and entertainment sites.

## Build

`bun build.ts` rebuilds into `./truescore/`. Always run after code changes.

## Layout

- `src/sites/` — one `.ts` per site (or page type); self-contained content scripts.
- `src/shared/` — cache, utils, config, review-summary helpers.
- `src/styles/` — CSS for Amazon product + Google Maps panels.
- `src/manifest.json` — content-script registration and host permissions.

## Design Context

### Users
Savvy consumers who don't trust star averages. They're on Amazon / Booking / Google Maps / Letterboxd / Goodreads in a decision-making moment — about to buy, book, watch, or visit — and want the truth behind the rating in seconds. Skeptical, analytical, will notice if a number looks decorative instead of earned.

### Brand Personality
Analytical, editorial, confident. Three words: **precise, discerning, quiet**. Feels like a Bloomberg terminal crossed with a well-designed magazine sidebar — numbers as the protagonist, typography as the craft, decoration nowhere. Trust through restraint.

### Aesthetic Direction
Dark glass islands embedded into host sites. TrueScore never pretends to be part of the site it's augmenting.

- **Type**: `IBM Plex Mono` 500/600 for all numerals. `Sora` 300–600 for UI text. Micro-labels in 9–10px, uppercase, 0.08–0.12em tracking.
- **Surface**: `rgba(14, 16, 24, 0.9)` with `backdrop-filter: blur(24px) saturate(180%)`, hairline `rgba(255,255,255,0.07)` border, 12–16px radius. Never pure black.
- **Accent**: warm gold `#E8B86D` → cool teal `#6DD3CE` gradient, used once per panel as a signature (top hairline, primary bar). Do not overuse.
- **Sentiment**: `#4ADE80` positive, `#F87171` negative, amber `#E8B86D` middle. Tint, don't saturate.
- **Neutrals ladder**: `rgba(255,255,255, 0.88 / 0.7 / 0.5 / 0.3 / 0.06)` — strict, every step must mean something.
- **Motion**: `cubic-bezier(0.16, 1, 0.3, 1)`; width 400–600ms; subtle opacity pulses. No bounce, no elastic.
- **Layout**: asymmetric, left-aligned, generous negative space. Numerics right-aligned, tabular-nums. Numbers are always the biggest thing on screen.

**Anti-references**: glassmorphism-for-decoration, purple-to-blue AI gradients, icon-above-heading cards, rounded-with-colored-border accents, sparklines, bounce easing, gray-on-colored text.

### Design Principles
1. **Numbers lead, chrome follows.** The metric is the hero.
2. **Tabular is non-negotiable.** Monospaced, right-aligned, tabular-nums on every count and percent.
3. **Micro-label grammar.** 9–10px, uppercase, `0.08–0.12em` letter-spacing, 40–50% white — never a heading.
4. **One gold-teal signature per panel.** The gradient is a signature, not a style.
5. **Earned hierarchy.** Every opacity step in the neutral ladder encodes meaning.
6. **Restraint over decoration.** Any detail that doesn't encode information is removed.
