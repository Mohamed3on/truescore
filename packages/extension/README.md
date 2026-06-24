# TrueScore

A browser extension that replaces useless 4.2-vs-4.3 star ratings with a score that actually means something.

## The problem

Every rating system on the internet is broken the same way. Everything sits between 4.0 and 4.8 stars. A 4.3 on Amazon could be a mass-produced disaster with 10,000 pity reviews or a genuinely great product with 200 honest ones. Stars don't tell you which.

## How TrueScore scores things

The core idea: **what matters is how many people loved it vs hated it, and how many people bothered to say so.**

```
score = (5-star ratings - 1-star ratings) × (that difference / total ratings)
```

This does two things at once:
- The **difference** filters out products where everyone is lukewarm
- Multiplying by the **ratio** rewards consistency — a product needs both volume and conviction to score high

A product with 500 five-stars and 10 one-stars out of 1,000 reviews scores **120**. A product with 50 five-stars and 1 one-star out of 100 reviews scores **12**. Same sentiment, but the first one has 10x more people backing it up.

Each site adapts this formula to what data is available (star histograms, like/dislike counts, review scores, etc).

## What it does on each site

**Shopping**
- **Amazon** — Sorts search results by score. On product pages: trending score from recent reviews, AI-powered review summary (via Gemini or OpenAI — keys set in the popup), and sentiment breakdown by product variation (color, size, etc).
- **Booking.com** — Sorts hotel results by score. On hotel pages: analyzes the last 100 reviews with filters by guest type and room type.
- **Decathlon / Uniqlo / IKEA / dm.de** — NPS-style score on product pages with attribute breakdowns (quality, fit, durability, etc). Product list pages auto-sort by score.

**Entertainment**
- **IMDB** — Score from the full 1-10 rating histogram, weighting 9-10 stars against 1-2 stars.
- **Letterboxd** — Merges Letterboxd and IMDB ratings into one score. Shows a trending score from the past week's reviews, and finds similar-length films from popular lists that score higher.
- **Goodreads** — Score from the rating distribution + a trending indicator from the past year's reviews.

**Places & Travel**
- **Airbnb** — Score on listing pages derived from the review histogram.
- **Google Maps** — Quick score on place details + a floating review analysis panel with time-based filtering, AI summaries, search within reviews, and custom questions about the place.

**Sports**
- **Transfermarkt** — Click any table header to sort. Shift+click fetches all pages and sorts globally. Adds a ranking column and a points-vs-expected column based on squad market value.

## Install & setup

### Install

Not on the Chrome Web Store — you load it unpacked. No build required:

1. Download the latest **[`truescore.zip`](https://github.com/Mohamed3on/truescore-monorepo/releases/latest)** from Releases and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the unzipped **`truescore/`** folder.

Pin the icon so the setup popup is one click away. Works in any Chromium browser (Chrome, Edge, Brave, Arc). To update, download the newer zip and click the refresh ↻ icon on the TrueScore card.

> Prefer to build it yourself? See [Develop](#develop).

### API key — optional, for AI summaries

Everything that's pure math works immediately: score sorting on Amazon/Booking, IMDB/Letterboxd/Goodreads scores, Transfermarkt sorting, NPS breakdowns — plus **Google Maps summaries**, which run on TrueScore's hosted server (no key needed).

The **on-device review summaries** (Amazon product pages, Letterboxd/Goodreads review Q&A) call an LLM straight from your browser, so they need your own key. Click the TrueScore icon and:

- Paste a **[free Gemini key](https://aistudio.google.com/apikey)** (recommended, no cost) — or use OpenAI / DeepSeek instead.
- Pick the **Model** used for summaries.

Keys are stored in `chrome.storage.sync` (synced to your Google account, never bundled into the extension). With no key, every score still works.

## Develop

```
src/
  shared/     cache, utils, config
  sites/      one .ts file per site (or page type)
  styles/     CSS for Amazon product + Google Maps
  background.ts
  popup/
  manifest.json

truescore/    ← build output, this is what Chrome loads
```

```sh
bun build.ts    # rebuild after changes
```

Each site is a self-contained content script. Adding a new site means adding a `.ts` file in `src/sites/`, an entry in `build.ts`, and a `content_scripts` block in `src/manifest.json`.

## Releases

Automated with [semantic-release](https://semantic-release.gitbook.io/). Every push to `main` that touches the extension runs [`release-extension.yml`](../../.github/workflows/release-extension.yml), which derives the next version from the commit history, stamps it into the manifest, builds `truescore.zip`, and publishes it to [Releases](https://github.com/Mohamed3on/truescore-monorepo/releases) with a generated changelog.

Versioning follows [Conventional Commits](https://www.conventionalcommits.org/): `feat:` → minor, `fix:` → patch, `feat!:` or a `BREAKING CHANGE:` footer → major. Other prefixes (`docs:`, `chore:`, `refactor:`, `ext:`) ship no release. Nothing to run by hand — just write a `feat:`/`fix:` commit and push.
