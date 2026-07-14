# TrueScore — domain & architecture context

TrueScore replaces inflated star averages with a score derived only from reviews
that look trustworthy. A browser **extension** injects scores onto Google Maps,
Letterboxd, Goodreads, Amazon, Booking, etc.; a **web** app (Bun on Hetzner)
does the same for a pasted Google Maps link. Three packages: `extension`, `web`,
and `gmaps-shared`.

## Domain vocabulary

- **Place** — a Google Maps location, identified by a **featureId** (`0x…:0x…` hex pair) parsed from the URL.
- **Review** — one Google review: `stars`, `reviewerReviewCount`, `timestamp`, `text`.
- **Trust filtering** — a review counts only if its author is **trusted**: `reviewerReviewCount >= TRUSTED_MIN_REVIEWS` (3). Filtering out drive-by/low-history reviewers is the whole premise.
- **Score / scorePct** — net polarity over *trusted* reviews: 5★ → +1, 1★ → −1, else 0, averaged and ×100 (`statsForReviews`).
- **Histogram** — the `[5★,4★,3★,2★,1★]` counts; `overallPct` and the integer `overallScore` are derived from it.
- **relevant / newest** — the two Google sort orders scored in parallel; pagination stops when `scorePct` **stabilizes** (within 1% after ≥2 pages).
- **Chip** (topic chip) — a Google Maps topic (e.g. "light show", "elevator") with a `token`; TrueScore re-scores the reviews under each chip. *(Formerly named `Highlight` — renamed to end the collision below.)*
- **Summary** — LLM output for a place (gemini, openai, or deepseek; see packages/web/llm.ts): a prose **verdict**, a list of **SummaryHighlight**s, **valueForMoney** (1–5), and **items** (praised dishes/menu terms).
- **SummaryHighlight** — one verdict bullet: `{ text, sentiment }`. Distinct from **Chip** — both used to be called "highlight".
- **items** (dish chips) — short praised dish/menu terms from the Summary, rendered as their own chips below the topic chips and auto-scored via a **Search** each; clicking one opens that search.
- **Search** — arbitrary review-text search within a place. A Gmail-style ` OR ` operator (`parseOrQuery`, any case) splits the query into terms; each is searched separately and the matches are unioned (dedup by `reviewId`).

## Architecture vocabulary

Uses the deepening glossary — *module, interface, seam, adapter, deep*.

- **`gmaps-shared`** — the deep module holding everything a Google-side or contract change should touch in one place: the RPC schema readers, the scoring math, the review-collection loop, and the wire contract. Storage, HTTP transport, DOM, and routing deliberately stay in `web`/`extension`.
- **Review-collection loop** (`gmaps-shared/collect.ts`) — `collectPaged`/`collectSort`/`collectToken`/`collectSearchTerms`: paginate a cursor URL → parse → dedup by `reviewId` → stop (no cursor / maxPages / `onPage` 'stop' / stabilized / aborted). The kernel both packages used to duplicate. `collectSearchTerms` layers the OR-search fan-out on top — one paged search per term, run in parallel and unioned by `reviewId` — so the web and extension search paths don't each re-derive it.
- **Transport** (the seam) — `(url, { signal? }) => Promise<string>`, injected into the loop. Two **adapters**: `googleFetch` (proxy + cookies + retry) on the server, a tab-session `fetch` in the extension. The extension layers abort/pause/resume, a page-1 live-head reconcile, and per-period bucketing on top via `onPage` — that orchestration stays per-package.
- **Wire contract** (`gmaps-shared/wire.ts`) — the single source of truth for every `/api/*` request body, JSON response, and NDJSON stream-event shape, plus the canonical `Provider` / `ReasoningEffort` enums and `LlmOverrides` (imported by `web/llm.ts` and the extension's `config.ts`, not re-declared). The server is the producer: JSON returns use `satisfies`, request handlers parse `as <Request>`. The web client and the extension both build bodies `satisfies <Request>`, gate-checked by `tsc` on every package via `check` (the extension gained a `tsconfig` + `@types/chrome`; it holds `strict` but not `noUncheckedIndexedAccess` — its scripts are DOM scrapers where a bad index is a visible failure, not a silent wrong score; see `packages/extension/tsconfig.json`).
- **summary-parse** (`web/summary-parse.ts`) — pure salvage + cleanup of structured-summary LLM text (truncated-JSON recovery, item hygiene), split from `llm.ts` so its fragile bits are tested through fixture strings (`summary-parse.test.ts`) instead of a live model.
- **Score grid** (`extension/src/shared/score-grid.ts`) — `setupScoreGrid`: the shared PLP behaviour the six product-grid scrapers used to each hand-roll — badge every card with its net score, then re-rank the container by `data-nps` (scored desc, unscored last), progressively as scores land. Owns the reentrancy guard, rAF coalescing, and the debounced `MutationObserver`; the per-site parts are injected slots (`scoreForCard`, `placeBadge`, `discover`, `applyOrder`) with batteries-included helpers (`structuralContainers` / `containersBySelector`; `orderByAppend` / `orderByCssBand`).
- **Score badge** — `renderScoreBadge` (in `score-grid.ts`): the compact `score (nps%)` span placed beside a host rating on a product card, shared across the score grids.
- **Score island** (`extension/src/shared/score-island.ts`) — the dark-glass `.ars-wrapper` PDP panel. `createIslandShell` (the "Review Intelligence" header shell) is shared by all eight retail PDPs; `buildGauge` (the **gauge** — a `% positive on this item` bar + truescore/reviews stats) is the byte-identical headline used by `etsy-pdp` + `aliexpress-pdp` (which also move to `setupSpaInjector`). Sites compose their own sections into the shell — a variation card, topics, the summarize widget, or a bespoke gauge (dm/amazon keep their async "recent-positive" gauge, bjjfanatics its clickable one, decathlon/uniqlo their light insight panels).
- **variation dims** — `tallyVariationDims` (in `variation-table.ts`, beside `renderVariationCard`) folds a product's reviews into ranked `VarDim[]` per variation dimension (Colour, Size…) using the shared `starScore`; the per-site part is only how each review's `[dim, value]` pairs and rating are read (index-aligned for AliExpress, `transactionId`-keyed for Etsy).

## Deployment

Web is `truescore.mohamed3on.com` (Cloudflare → Hetzner). Pushes to `packages/web/**` or `packages/gmaps-shared/**` auto-deploy via `.github/workflows/deploy-web.yml`. The extension builds locally (`bun build.ts`) and ships separately. See `packages/web/deploy/HETZNER.md`.
