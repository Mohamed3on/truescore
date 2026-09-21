# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user: the author, a data-savvy shopper who distrusts star averages, at the moment of deciding on a host site. About to buy (Amazon, Etsy, AliExpress, Decathlon, Uniqlo, IKEA, dm.de, BJJ Fanatics), book (Booking.com, Airbnb), visit (Google Maps), watch (IMDb, Letterboxd), read (Goodreads), or read a football table (Transfermarkt). They want the truth behind a rating in seconds without leaving the page, and they notice a number that looks decorative rather than earned.

Secondary: friends and public installers who found the GitHub repo. Same job, less patience for setup. Confirmed 2026-09-21: "me first, public second".

Web app users: anyone handed a Google Maps link, with or without the extension.

## Product Purpose

TrueScore replaces inflated 4.2-vs-4.3 star averages with a score that separates conviction from lukewarm volume, injected in place on the sites where the decision happens. Success is the author being saved from bad buys, bookings, and outings. Public adoption is welcome, not the goal.

## Positioning

Ratings sit between 4.0 and 4.8 everywhere, so they cannot tell a mass-produced disaster with 10,000 pity reviews from a great product with 200 honest ones. TrueScore scores what the average hides:

- Net conviction: how many people loved it versus hated it, scaled by how many bothered to say so. `score = (5★ − 1★) × ((5★ − 1★) / total)`. Each site adapts this to the data it exposes (star histograms, 1–10 histograms, like/dislike counts).
- Trust filtering on Google Maps: only reviews from reviewers with 3 or more reviews count. Excluding drive-by and low-history reviewers is the premise, not a feature.
- Recency: an adjusted score scaled by how positive the newest reviews are (Amazon, dm, Letterboxd, Goodreads).
- Ranking, not just labelling: search results and product grids are re-sorted by score, and a result whose hit rate clearly beats everything ranked above it is tinted as a best-ratio pick.

A neighbouring product could show a number; it cannot truthfully claim the number was computed from the reviews the user can read on that page, on every one of these sites, with no account and no server for the math.

## Operating Context

- Chromium extension loaded unpacked (Chrome, Edge, Brave, Arc). Not on the Chrome Web Store. Installers download `truescore.zip` from GitHub Releases; updates are manual (new zip, refresh in `chrome://extensions`).
- Runs inside third-party pages whose DOM and private APIs TrueScore does not control. Every site script is a scraper that can break when the host changes. One self-contained script per site or page type in `packages/extension/src/sites/`.
- Host coverage (from `packages/extension/src/manifest.json`): Amazon storefronts .com, .de, .co.uk, .fr, .it, .es, .ca, .com.au, .com.br, .com.mx, .co.jp, .cn, .in, .eg; Decathlon across 25 European country domains; Booking.com; Airbnb rooms; Google Maps; Uniqlo; IKEA; dm.de; Etsy; AliExpress .com and .us; BJJ Fanatics; IMDb titles; Letterboxd films; Goodreads books; Transfermarkt .com and .de. Number parsing is locale-aware (grouping separators differ per storefront).
- Scores are pure math and work with no setup. AI summaries and Ask are optional: on Amazon, Goodreads, and Letterboxd they call an LLM from the browser with the user's own key (free Gemini tier recommended; OpenAI and DeepSeek supported), set in the popup and stored in `chrome.storage.sync`, never bundled. Google Maps summaries run on the hosted server with no key.
- Web app at truescore.mohamed3on.com: paste a Google Maps link, get the trusted-review score, topic chips, search within reviews, an AI summary, and Ask. Cloudflare in front of a Hetzner box; the origin accepts CDN traffic only.
- Read in a decision moment on a busy host page, mostly on desktop. The extension has no mobile surface; the web app is opened on phones from shared links.
- The author is the developer and the primary user. The repo is public; extension releases are cut automatically from conventional commits, web pushes auto-deploy.

## Capabilities and Constraints

- Scoring math, review collection, and the wire contract live in `packages/gmaps-shared` and are shared by the extension and the web app. Domain and architecture vocabulary is recorded in `CONTEXT.md`.
- Extension, list pages: a score badge on every result card, the list re-ranked by score progressively as scores land, best-ratio picks tinted, `]` and `[` cycle through them.
- Extension, product pages: a "Review Intelligence" island with a gauge (% positive), recent-positive adjustment, variation breakdowns (colour, size), topic chips, review search with OR terms (Cmd/Ctrl+Shift+F), a per-search summary and Ask, a structured summary (praised, complaints, better alternative, conclusion), and Ask with cached recent questions.
- Google Maps: a floating review-analysis panel with time filtering, topic chips, search, summaries, and Ask; scores paginate until the trusted-review score stabilises.
- Media sites: IMDb scores from the full 1–10 histogram and re-ranks the "More like this" strip; Letterboxd merges Letterboxd and IMDb ratings and finds higher-scoring similar-length films; Goodreads adds a recent-positive % from the past year.
- Constraints: no build step for installers; no account; LLM keys never bundled; Google Maps sessions expire and are re-minted server-side; host bot walls (Cloudflare, DataDome) and rate limits bound what can be fetched; AI features are rate-limited per day in the extension; a keyword search renders at most 50 matches.
- Undecided: Chrome Web Store distribution (not pursued; unpacked install is the path today). Firefox and Safari (not pursued).

## Brand Commitments

- Name: TrueScore. Popup tagline: "The real score, everywhere." Web hero: "Stop trusting 4.7★."
- Voice: plain, direct, numbers first. The README explains the formula with worked examples and invites checking the math.
- Icon set: `packages/extension/src/icons/` (SVG source plus 16, 32, 48, 128 px PNGs).
- Visual authority: the shipped code (confirmed 2026-09-21). The "Design Context" sections in `packages/extension/.impeccable.md` and `packages/extension/CLAUDE.md` describe a dark-glass direction that the light retail panels do not follow; they are historical, not binding. No DESIGN.md exists yet.

## Evidence on Hand

- The scoring formula and worked examples in `packages/extension/README.md`.
- Public repo with automated releases and a generated changelog: github.com/Mohamed3on/truescore.
- Unit tests for scoring math, Google RPC parsers, review search, summary parsing, and the summarize widget (`bun test` at the repo root).
- No testimonials, user counts, press, case studies, or install metrics exist. Future work must not invent them.

## Product Principles

1. Earned numbers only. A score is shown when it was computed from reviews the user could read themselves; nothing decorative, nothing estimated.
2. In place, at the decision. Value lands on the host page at the moment of choosing, without a tab switch, an account, or setup.
3. Math works without keys. Every optional AI feature degrades silently to the pure-math experience.
4. Rank, don't just label. When there is a list, re-order it; a score that leaves the user to sort is half the job.
5. Add to the host, never fight it. Scripts layer onto the page; ranking is CSS-order by default so host re-renders never undo it, and one site's breakage stays in that site's script.

## Accessibility & Inclusion

No product-specific requirement established. Keyboard shortcuts exist for best-ratio picks and review search; no standard has been adopted. Open decision.
