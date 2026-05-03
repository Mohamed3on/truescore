# TrueScore

A browser extension that replaces useless 4.2-vs-4.3 star ratings with a score that actually means something.

## The problem

Every rating system on the internet is broken the same way. Everything sits between 4.0 and 4.8 stars. A 4.3 on Amazon could be a mass-produced disaster with 10,000 pity reviews or a genuinely great product with 200 honest ones. Stars don't tell you which.

## How CreamCrop scores things

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
- **Amazon** — Sorts search results by score. On product pages: trending score from recent reviews, AI-powered review summary (via Gemini), and sentiment breakdown by product variation (color, size, etc).
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

## Install

```sh
bun install
bun build.ts
```

In Chrome: **chrome://extensions** → Developer Mode → Load unpacked → select the `truescore/` folder.

## Develop

```
src/
  shared/     cache, utils, config
  sites/      one .ts file per site (or page type)
  styles/     CSS for Amazon product + Google Maps
  background.ts
  popup/
  manifest.json

creamcrop/    ← build output, this is what Chrome loads
```

```sh
bun build.ts    # rebuild after changes
```

Each site is a self-contained content script. Adding a new site means adding a `.ts` file in `src/sites/`, an entry in `build.ts`, and a `content_scripts` block in `src/manifest.json`.
