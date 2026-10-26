import { netScore } from '@truescore/gmaps-shared';
import { z } from 'zod';
import { cacheGet, cacheSet } from '../shared/cache';
import { addCommas, el } from '../shared/utils';
import { adjust, ratioFromTally } from '../shared/recency';
import { type SearchReviewFields } from '../shared/review-search';
import { buildReviewPanel } from '../shared/review-panel';
import { renderVariationCard, type VarDim } from '../shared/variation-table';
import { createIslandShell } from '../shared/score-island';

const NUMBER_OF_PAGES_TO_PARSE = 10;

// The newest reviews the walk reads, at ten a page: the Sample.
const WALK_MAX = NUMBER_OF_PAGES_TO_PARSE * 10;

// 0 → red (hue 0), 1 → vivid green (hue 145)
const getColorForPercentage = function (pct: number) {
  pct = Math.max(0, Math.min(1, pct));
  var hue = pct * 145;

  return { backgroundColor: `hsl(${hue}, 85%, 40%)` };
};


const getRatingPercentages = (root: Document | HTMLElement = document) => {
  const nodes = root.querySelectorAll('[role="progressbar"][aria-valuenow]');

  const values = Array.from(nodes)
    .map((el) => parseInt(el.getAttribute('aria-valuenow')!.replace('%', ''), 10))
    .filter((n) => Number.isFinite(n));

  if (values.length < 2) return { fiveStars: 0, oneStars: 0 };

  return { fiveStars: values[0], oneStars: values[values.length - 1] };
};

// Amazon separates variation attributes with an <i class="a-icon-text-separator"> element
// (e.g. "Size: L | Colour: White / Black"). Serialize the strip to clean text, using a
// private delimiter between attributes so each "Dimension: value" pair stays whole.
const VAR_SEP = '•';

const cleanFormatStrip = (el: Element) => {
  let out = '';

  for (const node of el.childNodes) {
    out += node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : VAR_SEP;
  }

  return out
    .replaceAll(' Name:', ':')          // some locales label dimensions "Size Name:" etc.
    .replace(/\s*•\s*/g, VAR_SEP)  // drop whitespace hugging the delimiter
    .replace(/\s+/g, ' ')
    .trim();
};

// Fallback for strips without separator elements: "Color: Space Gray Size: 256 GB".
// Keys are single tokens; values run until the next key, so multi-word values survive.
const VAR_PAIR_RE = /([A-Za-z][\w./-]*):\s*([^:]*?)(?=\s+[A-Za-z][\w./-]*:|$)/g;

const parseVariation = (text: string): [string, string][] => {
  const pairs: [string, string][] = [];

  if (text.includes(VAR_SEP)) {
    for (const seg of text.split(VAR_SEP)) {
      const c = seg.indexOf(':');

      if (c <= 0) continue;
      const dim = seg.slice(0, c).trim();
      const val = seg.slice(c + 1).trim();

      if (dim && val) pairs.push([dim, val]);
    }

    return pairs;
  }

  for (const m of text.matchAll(VAR_PAIR_RE)) {
    const dim = m[1].trim();
    const val = m[2].trim();

    if (dim && val) pairs.push([dim, val]);
  }

  return pairs;
};

const injectBestFormats = (formatRatings: Record<string, number>) => {
  const combos = Object.entries(formatRatings).map(([raw, score]) => ({
    pairs: parseVariation(raw),
    label: raw.replaceAll(VAR_SEP, ' | '),
    score,
  }));

  if (!combos.length) return;

  // Re-aggregate the full-combination scores into per-dimension tallies so we can
  // surface the best-performing color, size, etc. on their own — not just the best
  // exact combination. Net sentiment per dimension value = sum over every combo it appears in.
  const dims = new Map<string, Map<string, number>>();
  const seenIn = new Map<string, number>();
  let multiDim = false;

  for (const { pairs, score } of combos) {
    if (pairs.length > 1) multiDim = true;

    for (const [dim, val] of pairs) {
      let m = dims.get(dim);

      if (!m) dims.set(dim, (m = new Map()));
      m.set(val, (m.get(val) ?? 0) + score);
    }

    for (const dim of new Set(pairs.map(([d]) => d))) seenIn.set(dim, (seenIn.get(dim) ?? 0) + 1);
  }

  // A dimension every combination shares has nothing to rank — it's the fixed
  // context the whole card sits in. The card names it once above the tabs, and we
  // strip it from the row labels so each row reads as only what actually differs.
  // (When nothing varies, the lone row already says it: leave it whole.)
  const constant = [...dims.entries()].filter(([dim, vals]) => vals.size === 1 && seenIn.get(dim) === combos.length);
  const fixed = constant.length < dims.size ? constant : [];
  const fixedDims = new Set(fixed.map(([dim]) => dim));

  // A dimension is worth its own tab only if it has ≥2 values to compare.
  const compareDims = [...dims.entries()]
    .filter(([, vals]) => vals.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));

  const showTabs = compareDims.length >= 2 || (compareDims.length === 1 && multiDim);

  const byScore = (a: [string, number], b: [string, number]) => b[1] - a[1];
  const toRows = (entries: [string, number][]) => entries.map(([label, score]) => ({ label, score }));

  // Amazon's buy-box column is ~240px, where a spelled-out combination wraps to
  // three lines. The dimension you actually choose from — the one with the most
  // values, already first in compareDims — leads the row under its own tab name;
  // the rest drop to the sub-line, where they read as qualifiers instead of noise.
  const lead = showTabs ? compareDims[0]?.[0] : undefined;

  const specific = combos
    .map(({ pairs, label, score }) => {
      const varying = pairs.filter(([dim]) => !fixedDims.has(dim));
      const head = lead && varying.find(([dim]) => dim === lead);

      if (!head) return { label: varying.length ? varying.map(([d, v]) => `${d}: ${v}`).join(' | ') : label, score };
      const rest = varying.filter(([dim]) => dim !== lead);

      return { label: head[1], score, meta: rest.map(([d, v]) => `${d} ${v}`).join(' \u00B7 ') || undefined };
    })
    .sort((a, b) => b.score - a.score);

  // Specific (exact combination) leads; per-dimension breakdowns follow as extra tabs.
  const varDims: VarDim[] = showTabs
    ? [
        { label: 'Specific', rows: specific },
        ...compareDims.map(([dim, vals]) => ({ label: dim, rows: toRows([...vals.entries()].sort(byScore)) })),
      ]
    : [{ label: '', rows: specific }];

  const box = renderVariationCard(varDims, {
    animate: true,
    constants: fixed.map(([dim, vals]): [string, string] => [dim, [...vals.keys()][0]]),
  });

  const buyBox = document.querySelector('#desktop_buybox');

  if (buyBox) buyBox.parentNode!.insertBefore(box, buyBox);
};

const setTotalRatingsScore = (totalRatingPercentages: { fiveStars: number; oneStars: number }, elementToReplace: HTMLElement, numOfRatings: any) => {
  const { fiveStars, oneStars } = totalRatingPercentages;

  const scorePercentage = fiveStars - oneStars;
  const total = parseInt(numOfRatings);
  const calculatedScore = netScore(Math.round(total * (scorePercentage / 100)), total);

  elementToReplace.textContent = ` ${addCommas(calculatedScore)} ratio: (${scorePercentage}%)`;

  return { calculatedScore, totalScorePercentage: scorePercentage / 100 };
};

const THREE_DAYS = 3 * 86400000;

// ---- Keyword review search helpers (pure; used by getRatingSummary) ----
// A review's text in the shopper's language, when Amazon translated it.
type Shown = { title: string; body: string };

type FilteredReview = { id: string; rating: number; title: string; body: string; verified: boolean; meta: string; shown?: Shown };

const pickText = (root: Element, sel: string) => {
  const node = root.querySelector(sel);
  // Prefer the original (untranslated) span when Amazon nests one. Without it
  // (a local review), a title also holds its star rating's alt text, dropped.
  const original = node?.querySelector('.cr-original-review-content');

  if (original) return original.textContent!.trim();

  return (node?.textContent ?? '').replace(node?.querySelector('.a-icon-alt')?.textContent ?? '', '').trim();
};

// A review's id, or the start of its text where it has none.
const reviewId = (review: Element) => review.id || review.querySelector('[data-hook="review-body"]')?.textContent?.trim().slice(0, 80);

const parseFilteredReview = (review: Element): FilteredReview => {
  const ratingEl = review.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]');

  return {
    id: review.id,
    rating: parseInt(ratingEl?.textContent?.match(/(\d)(?:\.\d)?/)?.[1] ?? '0', 10),
    title: pickText(review, '[data-hook="review-title"]'),
    body: pickText(review, '[data-hook="review-body"]'),
    verified: !!review.querySelector('[data-hook="avp-badge"]'),
    meta: review.querySelector('[data-hook="review-date"]')?.textContent?.trim() ?? '',
  };
};

// A review as the search lists it, and as a summary point's reviews show it:
// stars, date and title, in the shopper's language when Amazon translated it.
const cardFields = (r: FilteredReview): SearchReviewFields => ({
  rating: r.rating,
  title: r.shown?.title || r.title,
  body: r.shown?.body || r.body,
  meta: [r.verified ? '\u2713 Verified' : '', r.meta].filter(Boolean).join(' \u00b7 '),
});

// The page title goes along as context, so the model knows which product the
// searched term is a lens on (see keywordSummaryPrompt).
const productContext = () => {
  const title = document.getElementById('productTitle')?.textContent?.trim();

  return title ? `The product on this page: ${title}` : undefined;
};

// recent.percentage stays 0 until the walk sets it to the ratio's toFixed(2) string.
type RatingScores = {
  recent: { absolute: number; percentage: number | string };
  total: { calculated: number; percentage: number };
};

// Amazon's review AJAX headers: the CSRF token goes along when the page has one.
type PortalHeaders = { 'x-requested-with': string; 'content-type': string; 'anti-csrftoken-a2z'?: string };

// One chunk of Amazon's review AJAX: [action, selector, html, …].
const AjaxChunk = z.tuple([z.unknown(), z.unknown(), z.string()], z.unknown());

const getRatingSummary = async (productSIN: string, numOfRatingsElement: HTMLElement, numOfRatings: any, cacheASIN: string) => {
  const recentRatingsURL = `/product-reviews/${productSIN}/?sortBy=recent`;
  let numberOfParsedReviews = 0;

  const scores: RatingScores = {
    recent: { absolute: 0, percentage: 0 },
    total: { calculated: 0, percentage: 0 },
  };

  const formatRatings: Record<string, number> = {};

  // v4: v3 cached the total score before it kept its sign.
  const scoresCacheKey = `ars-scores-v4-${cacheASIN}`;
  const cachedScores = cacheGet(scoresCacheKey, THREE_DAYS);
  let usedCache = false;

  const elementToAppendTo = document.querySelector('#averageCustomerReviews');
  const wrapper = createIslandShell();

  if (cachedScores) {
    numberOfParsedReviews = cachedScores.numberOfParsedReviews;
    scores.recent = cachedScores.scores.recent;
    scores.total = cachedScores.scores.total;
    Object.assign(formatRatings, cachedScores.formatRatings);
    numOfRatingsElement.textContent = ` ${addCommas(scores.total.calculated)} ratio: (${Math.round(scores.total.percentage * 100)}%)`;
    usedCache = true;
  }

  const getCrState = () => {
    const state = document.querySelector('#cr-state-object')?.getAttribute('data-state');

    if (state) {
      try { return JSON.parse(state); } catch {}
    }

    return null;
  };

  const crState = getCrState();
  const antiCsrf = crState?.reviewsCsrfToken;

  const parseAjaxChunks = (raw: string) => {
    let html = '';

    for (const chunk of raw.split('&&&')) {
      try {
        const parsed = AjaxChunk.safeParse(JSON.parse(chunk.trim()));

        if (parsed.success) html += parsed.data[2];
      } catch {}
    }

    return html;
  };

  const portalUrl = '/portal/customer-reviews/ajax/reviews/get/ref=cm_cr_getr_d_paging_btm';

  const portalHeaders: PortalHeaders = {
    'x-requested-with': 'XMLHttpRequest',
    'content-type': 'application/x-www-form-urlencoded',
  };

  if (antiCsrf) portalHeaders['anti-csrftoken-a2z'] = antiCsrf;

  // Once the POST has failed, every later page goes straight to the fallback GET
  // instead of paying for a doomed POST first.
  let portalFailed = false;

  // The one paginated review fetch all three callers share: POST the review AJAX
  // (cursor via nextPageToken), fall back to the plain product-reviews page, parse,
  // and hand each page to onPage. extraParams (e.g. filterByKeyword) flow into both
  // the POST body and the fallback URL so filtered searches stay filtered; onPage
  // returns 'stop' to end pagination early. Resolves whether the walk ran its
  // course — out of pages or out of budget — rather than stopping early on a
  // failed fetch or a 'stop': only a whole sample is worth caching.
  const fetchReviewPages = async (
    onPage: (doc: Document, page: number) => 'stop' | void,
    extraParams: Record<string, string> = {},
  ): Promise<boolean> => {
    const parser = new DOMParser();
    let nextToken: string | null = null;

    for (let page = 1; page <= NUMBER_OF_PAGES_TO_PARSE; page++) {
      const params = new URLSearchParams({
        sortBy: 'recent', pageNumber: String(page), pageSize: '10',
        asin: productSIN, scope: `reviewsAjax${page}`,
        deviceType: 'desktop', reftag: 'cm_cr_getr_d_paging_btm', ...extraParams,
      });

      if (nextToken) params.set('nextPageToken', nextToken);

      let html = '';

      if (!portalFailed) {
        try {
          const res = await fetch(portalUrl, {
            method: 'POST', credentials: 'include', headers: portalHeaders,
            body: params,
          });

          if (res.ok) html = parseAjaxChunks(await res.text());
        } catch {}

        portalFailed = !html;
      }

      if (!html) {
        const qs = new URLSearchParams({ sortBy: 'recent', pageNumber: String(page), ...extraParams });

        if (nextToken) qs.set('nextPageToken', nextToken);

        try {
          const res = await fetch(`/product-reviews/${productSIN}/?${qs}`, { credentials: 'include' });

          if (res.ok) html = await res.text();
        } catch {}
      }

      if (!html) return false;

      if (onPage(parser.parseFromString(html, 'text/html'), page) === 'stop') return false;

      const tokenMatch = html.match(/nextPageToken[^:]*?:\s*(?:&quot;|")([^"&]+)/);
      nextToken = tokenMatch?.[1] ?? null;

      if (!nextToken) return true;
    }

    return true;
  };

  // Amazon translates a page's foreign-language reviews into the shopper's
  // language with one more POST — its "Translate all reviews" button's, signed
  // for exactly that page's list. Scores and the model read the originals; only
  // reviews on show (search results, a summary point's reviews) wear the
  // translation. By review id.
  const translatePage = async (doc: Document): Promise<[string, Shown][]> => {
    const offer = doc.querySelector('.cr-translate-these-reviews-section [data-action="reviews:ajax-post"]')?.getAttribute('data-reviews:ajax-post');

    if (!offer) return [];
    const parser = new DOMParser();
    const byId = new Map<string, Shown>();

    try {
      const { url, params } = JSON.parse(offer);
      const res = await fetch(url, { method: 'POST', credentials: 'include', headers: portalHeaders, body: new URLSearchParams(params) });

      if (!res.ok) return [];

      for (const chunk of (await res.text()).split('&&&')) {
        try {
          const [action, selector, html] = JSON.parse(chunk);
          const m = action === 'update' && selector.match(/^#(\w+) \.review-(title|text)-content \.cr-translated-review-content$/);

          if (!m) continue;
          const shown = byId.get(m[1]) ?? { title: '', body: '' };
          shown[m[2] === 'text' ? 'body' : 'title'] = parser.parseFromString(html, 'text/html').body.textContent!.trim();
          byId.set(m[1], shown);
        } catch {}
      }
    } catch {}

    return [...byId];
  };

  // The walk's reviews: the Sample, and a summary point's cards. Its pages are
  // translated once it's done — neither the score nor the summary waits on them —
  // and the reviews kept as long as the scores the same walk produced: a shorter
  // life made a Summarize on days 2–3 walk all ten pages again before the model
  // could start.
  const reviewsKey = `ars-reviews-v2-${cacheASIN}`;

  const readReviews = (doc: Document, seen: Set<string>, into: FilteredReview[]) => {
    const found = doc.querySelectorAll('[data-hook="review"]');

    for (const review of found) {
      const id = reviewId(review);

      if (!id || seen.has(id)) continue;
      seen.add(id);
      const r = parseFilteredReview(review);

      if (r.body) into.push(r);
    }

    return found.length;
  };

  // The walk's own, which its translations land on — none, when it found none.
  let kept: FilteredReview[] | undefined;

  const keepReviews = async (reviews: FilteredReview[], pages: Document[]) => {
    kept = reviews;

    if (!reviews.length) return;
    // Kept before the translations too, which may never come.
    cacheSet(reviewsKey, reviews);
    const byId = new Map(reviews.map((r) => [r.id, r]));

    for (const [id, shown] of (await Promise.all(pages.map(translatePage))).flat()) {
      const r = byId.get(id);

      if (r) r.shown = shown;
    }

    cacheSet(reviewsKey, reviews);
  };

  const fetchFreshReviews = async (): Promise<FilteredReview[]> => {
    const cached = kept ?? cacheGet(reviewsKey, THREE_DAYS);

    if (cached) return cached;

    const seen = new Set<string>();
    const reviews: FilteredReview[] = [];
    const pages: Document[] = [];
    await fetchReviewPages((doc, page) => {
      pages.push(doc);
      const before = seen.size;
      const total = readReviews(doc, seen, reviews);

      if (total > 0 && seen.size === before) {
        console.warn(`[ARS] Page ${page}: all ${total} reviews were duplicates — pagination broken, stopping`);

        return 'stop';
      }
    });
    void keepReviews(reviews, pages);

    return reviews;
  };

  // The scoring walk: ten cursor-chained pages, so inherently one after another.
  let walked: Promise<void> = Promise.resolve();

  if (!usedCache) {
    const starRatingsToLikeDislikeMapping = { 5: 1, 1: -1 };
    let totalRatingPercentages: { fiveStars: number; oneStars: number } | undefined;

    try {
      const totals = getRatingPercentages();

      if (totals.fiveStars || totals.oneStars) {
        totalRatingPercentages = totals;

        const { calculatedScore, totalScorePercentage } = setTotalRatingsScore(
          totalRatingPercentages, numOfRatingsElement, numOfRatings
        );

        scores.total = { calculated: calculatedScore, percentage: totalScorePercentage };
      }
    } catch {}

    // Build live gauge + stats so counts update in real-time
    const gauge = document.createElement('a');
    gauge.className = 'ars-gauge';
    gauge.href = recentRatingsURL;
    gauge.innerHTML = `
      <div class="ars-gauge-label"><span class="ars-gauge-pct">\u2014</span> recent positive</div>
      <div class="ars-gauge-track"><div class="ars-gauge-fill"></div></div>
    `;  // safe: no user content in template
    wrapper.appendChild(gauge);

    const stats = document.createElement('div');
    stats.className = 'ars-stats';
    stats.innerHTML = `
      <div class="ars-stat"><span class="ars-stat-val" data-ars="adjusted">\u2014</span><span class="ars-stat-lbl">adjusted</span></div>
      <div class="ars-stat-div"></div>
      <div class="ars-stat"><span class="ars-stat-val" data-ars="analyzed">0</span><span class="ars-stat-lbl">analyzed<span class="ars-scan-spinner" data-ars="scanning"></span></span></div>
    `;  // safe: no user content in template
    wrapper.appendChild(stats);

    elementToAppendTo!.appendChild(wrapper);

    // SAFETY: each selector matches an HTML element of the gauge and stats markup set just above.
    const pctEl = gauge.querySelector('.ars-gauge-pct') as HTMLElement,
      fillEl = gauge.querySelector('.ars-gauge-fill') as HTMLElement,
      adjustedEl = wrapper.querySelector('[data-ars="adjusted"]') as HTMLElement,
      analyzedEl = wrapper.querySelector('[data-ars="analyzed"]') as HTMLElement;

    const bumpEl = (el: Element) => {
      el.classList.remove('ars-bump');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('ars-bump')));
    };

    const updateLiveStats = () => {
      const pctRaw = ratioFromTally(scores.recent.absolute, numberOfParsedReviews);

      if (pctRaw == null) return;
      const pct = Math.round(pctRaw * 100);
      const { backgroundColor } = getColorForPercentage(pctRaw);
      const adjustedScore = adjust(scores.total.calculated, pctRaw);

      pctEl.textContent = `${pct}%`;
      pctEl.style.color = backgroundColor;
      fillEl.style.transform = `scaleX(${pctRaw})`;
      fillEl.style.background = backgroundColor;

      adjustedEl.textContent = addCommas(adjustedScore);
      bumpEl(adjustedEl);

      analyzedEl.textContent = String(numberOfParsedReviews);
      bumpEl(analyzedEl);
    };

    const seenReviewIds = new Set<string>();
    const walkedReviews: FilteredReview[] = [];
    const pages: Document[] = [];
    walked = fetchReviewPages((syntheticDocument, page) => {
      pages.push(syntheticDocument);

      if (!totalRatingPercentages) {
        totalRatingPercentages = getRatingPercentages(syntheticDocument);

        const { calculatedScore, totalScorePercentage } = setTotalRatingsScore(
          totalRatingPercentages, numOfRatingsElement, numOfRatings
        );

        scores.total = { calculated: calculatedScore, percentage: totalScorePercentage };
      }

      const reviews = syntheticDocument.querySelectorAll('[data-hook="review"]');

      if (!reviews.length) return 'stop';

      const prevSeen = seenReviewIds.size;

      for (const review of reviews) {
        const id = reviewId(review);

        if (!id || seenReviewIds.has(id)) continue;
        seenReviewIds.add(id);
        const parsed = parseFilteredReview(review);

        if (parsed.body) walkedReviews.push(parsed);

        const ratingElement = review.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]');

        if (!ratingElement) continue;

        numberOfParsedReviews++;
        const format = review.querySelector('a[data-hook="format-strip"]');

        const ratingText = ratingElement.textContent || '';
        const ratingMatch = ratingText.match(/(\d)(?:\.\d)?/);

        if (!ratingMatch) continue;
        const rating = parseInt(ratingMatch[1]);

        if (rating === 5 || rating === 1) {
          if (format) {
            const cleanedFormat = cleanFormatStrip(format);

            if (cleanedFormat) formatRatings[cleanedFormat] = (formatRatings[cleanedFormat] ?? 0) + starRatingsToLikeDislikeMapping[rating];
          }

          scores.recent.absolute += starRatingsToLikeDislikeMapping[rating];
        }
      }

      if (seenReviewIds.size === prevSeen) {
        console.warn(`[ARS] Score page ${page}: all ${reviews.length} reviews were duplicates — pagination is broken, stopping`);

        return 'stop';
      }

      updateLiveStats();
    }).then((complete) => {
      // A walk cut short still shows what it read, but isn't pinned for days.
      if (complete && numberOfParsedReviews > 0) {
        cacheSet(scoresCacheKey, { numberOfParsedReviews, scores, formatRatings });
      }

      void keepReviews(walkedReviews, pages);

      // Fade out scanning indicator
      const spinner = wrapper.querySelector('[data-ars="scanning"]');

      if (spinner) {
        spinner.classList.add('ars-scan-done');
        spinner.addEventListener('animationend', () => spinner.remove(), { once: true });
      }

      if (numberOfParsedReviews === 0) {
        gauge.remove();
        stats.remove();
        const noReviews = document.createElement('div');
        noReviews.className = 'ars-empty';
        noReviews.textContent = 'No local reviews available for analysis';
        wrapper.appendChild(noReviews);
      }
    });
  } else {
    // Cached path: build final widget immediately
    const pctRaw = ratioFromTally(scores.recent.absolute, numberOfParsedReviews);

    if (pctRaw != null) {
      scores.recent.percentage = pctRaw.toFixed(2);
      const pct = Math.round(pctRaw * 100);
      const { backgroundColor } = getColorForPercentage(pctRaw);
      const adjustedScore = adjust(scores.total.calculated, pctRaw);

      const gauge = document.createElement('a');
      gauge.className = 'ars-gauge';
      gauge.href = recentRatingsURL;
      gauge.innerHTML = `
        <div class="ars-gauge-label"><span class="ars-gauge-pct" style="color:${backgroundColor}">${pct}%</span> recent positive</div>
        <div class="ars-gauge-track"><div class="ars-gauge-fill" style="transform:scaleX(${pctRaw});background:${backgroundColor}"></div></div>
      `;
      wrapper.appendChild(gauge);

      const stats = document.createElement('div');
      stats.className = 'ars-stats';
      stats.innerHTML = `
        <div class="ars-stat"><span class="ars-stat-val">${addCommas(adjustedScore)}</span><span class="ars-stat-lbl">adjusted</span></div>
        <div class="ars-stat-div"></div>
        <div class="ars-stat"><span class="ars-stat-val">${numberOfParsedReviews}</span><span class="ars-stat-lbl">analyzed</span></div>
      `;
      wrapper.appendChild(stats);
    } else {
      const noReviews = document.createElement('div');
      noReviews.className = 'ars-empty';
      noReviews.textContent = 'No local reviews available for analysis';
      wrapper.appendChild(noReviews);
    }
  }

  // ---- Keyword review search (server-side filterByKeyword) ----
  // Amazon's review AJAX accepts filterByKeyword, so a Search spans EVERY review —
  // not just the pages we scored. Each page is translated as it lands, for display.
  const searchTerm = async (term: string) => {
    const seen = new Set<string>();
    const reviews: FilteredReview[] = [];
    const translating: Promise<[string, Shown][]>[] = [];
    await fetchReviewPages((doc) => {
      const before = seen.size;

      if (!readReviews(doc, seen, reviews) || seen.size === before) return 'stop';
      translating.push(translatePage(doc));
    }, { filterByKeyword: term });
    const translated = new Map((await Promise.all(translating)).flat());

    for (const r of reviews) r.shown = translated.get(r.id);

    return { reviews, total: reviews.length };
  };

  // The search, Summary and Ask need nothing from the scoring walk but its
  // reviews, so they mount at once rather than after it — gone again if the walk
  // finds no reviews to analyze. `display: contents` keeps them in the island's
  // own flow.
  if (usedCache ? numberOfParsedReviews > 0 : numOfRatings > 0) {
    const tools = el('div');
    tools.style.display = 'contents';
    wrapper.appendChild(tools);
    buildReviewPanel(tools, {
      key: `review-summary-${cacheASIN}`,
      total: numOfRatings || numberOfParsedReviews,
      // After the walk its reviews are cached, so this reads them, not a second walk.
      all: () => walked.then(fetchFreshReviews),
      allMax: WALK_MAX,
      text: (r) => [r.title, r.body].filter(Boolean).join(': '),
      card: cardFields,
      searchTerm,
      exampleQuery: 'battery OR strap',
      context: productContext(),
    });
    walked.then(() => { if (!numberOfParsedReviews) tools.remove(); });
  }

  if (!wrapper.parentNode) elementToAppendTo!.appendChild(wrapper);
  await walked;

  if (numberOfParsedReviews > 0) {
    scores.recent.percentage = scores.recent.percentage || (scores.recent.absolute / numberOfParsedReviews).toFixed(2);
  }

  injectBestFormats(formatRatings);
};

const getProductSIN = () => {
  let productSINMatches = window.location.toString().match(/(?<=\/(dp|product)\/)([A-Z0-9]+)/g);

  return productSINMatches && productSINMatches[0];
};

const getParentASIN = () => {
  for (const s of document.querySelectorAll('script[type="text/javascript"]')) {
    const m = s.textContent!.match(/"parentAsin"\s*:\s*"([A-Z0-9]+)"/);

    if (m) return m[1];
  }

  return null;
};

(async function main() {
  const productSIN = getProductSIN();

  if (!productSIN) return;
  const numOfRatingsElement = document.getElementById('acrCustomerReviewLink');

  if (!numOfRatingsElement) return;
  // Grouping separator varies by locale (en "2,370", de "2.370", fr "2 370"),
  // so strip everything non-digit; only K-abbreviated counts carry a decimal.
  const countText = numOfRatingsElement.textContent!.match(/\d[\d.,\u00A0\u202F ]*[Kk]?/)?.[0]?.trim();

  if (!countText) return;

  const numOfRatings = /[Kk]$/.test(countText)
    ? Math.round(parseFloat(countText.slice(0, -1).replace(',', '.')) * 1000)
    : parseInt(countText.replace(/\D/g, ''), 10);

  const cacheASIN = getParentASIN() || productSIN;
  await getRatingSummary(productSIN, numOfRatingsElement, numOfRatings, cacheASIN);

  // Re-attach when variant switch removes our widget
  const wrapper = document.querySelector('.ars-wrapper');
  const variations = document.querySelector('.ts-var');

  if (!wrapper) return;
  // Variant switches replace #acrCustomerReviewLink, so the score written into
  // the captured node detaches with it — keep the text to re-apply on re-attach.
  const scoreText = numOfRatingsElement.textContent!;
  const scoreApplied = scoreText.includes('ratio:');

  const observer = new MutationObserver(() => {
    if (!document.contains(wrapper)) {
      const target = document.getElementById('averageCustomerReviews');

      if (target) target.appendChild(wrapper);

      if (scoreApplied) {
        const link = document.getElementById('acrCustomerReviewLink');

        if (link && link.textContent !== scoreText) link.textContent = scoreText;
      }

      if (variations && !document.contains(variations)) {
        const buyBox = document.querySelector('#desktop_buybox');

        if (buyBox) buyBox.parentNode!.insertBefore(variations, buyBox);
      }
    }
  });

  observer.observe(document.getElementById('dp') || document.body, { childList: true, subtree: true });
})();
