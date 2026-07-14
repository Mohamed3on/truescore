import { cacheGet, cacheSet } from '../shared/cache';
import { addCommas, el, npsColor, npsStats } from '../shared/utils';
import { buildSummarizeWidget, PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';
import { queryTerms, buildReviewCard } from '../shared/review-search';
import { renderVariationCard, type VarDim } from '../shared/variation-table';
import { createIslandShell } from '../shared/score-island';

const NUMBER_OF_PAGES_TO_PARSE = 10;

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
const VAR_PAIR_RE = /([A-Za-z][\w.\/-]*):\s*([^:]*?)(?=\s+[A-Za-z][\w.\/-]*:|$)/g;
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
  const combos = Object.entries(formatRatings);
  if (!combos.length) return;

  // Re-aggregate the full-combination scores into per-dimension tallies so we can
  // surface the best-performing color, size, etc. on their own — not just the best
  // exact combination. Net sentiment per dimension value = sum over every combo it appears in.
  const dims = new Map<string, Map<string, number>>();
  let multiDim = false;
  const specificRows: [string, number][] = combos.map(([raw, score]) => {
    const pairs = parseVariation(raw);
    if (pairs.length > 1) multiDim = true;
    for (const [dim, val] of pairs) {
      let m = dims.get(dim);
      if (!m) dims.set(dim, (m = new Map()));
      m.set(val, (m.get(val) ?? 0) + score);
    }
    return [raw.replaceAll(VAR_SEP, ' | '), score];
  });

  // A dimension is worth its own tab only if it has ≥2 values to compare.
  const compareDims = [...dims.entries()]
    .filter(([, vals]) => vals.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));

  const showTabs = compareDims.length >= 2 || (compareDims.length === 1 && multiDim);

  const byScore = (a: [string, number], b: [string, number]) => b[1] - a[1];
  const toRows = (entries: [string, number][]) => entries.map(([label, score]) => ({ label, score }));
  const specific = toRows(specificRows.sort(byScore));

  // Specific (exact combination) leads; per-dimension breakdowns follow as extra tabs.
  const varDims: VarDim[] = showTabs
    ? [
        { label: 'Specific', rows: specific },
        ...compareDims.map(([dim, vals]) => ({ label: dim, rows: toRows([...vals.entries()].sort(byScore)) })),
      ]
    : [{ label: '', rows: specific }];

  const box = renderVariationCard(varDims, { animate: true });
  const buyBox = document.querySelector('#desktop_buybox');
  if (buyBox) buyBox.parentNode!.insertBefore(box, buyBox);
};

const setTotalRatingsScore = (totalRatingPercentages: { fiveStars: number; oneStars: number }, elementToReplace: HTMLElement, numOfRatings: any) => {
  const { fiveStars, oneStars } = totalRatingPercentages;

  const scorePercentage = fiveStars - oneStars;
  const scoreAbsolute = Math.round(parseInt(numOfRatings) * (scorePercentage / 100));

  const calculatedScore = Math.round(scoreAbsolute * (scorePercentage / 100));

  elementToReplace.textContent = ` ${addCommas(calculatedScore)} ratio: (${scorePercentage}%)`;

  return { calculatedScore, totalScorePercentage: scorePercentage / 100 };
};

const THREE_DAYS = 3 * 86400000;

// ---- Keyword review search helpers (pure; used by getRatingSummary) ----
type FilteredReview = { rating: number; title: string; body: string; verified: boolean; meta: string };

const pickText = (root: Element, sel: string) => {
  const node = root.querySelector(sel);
  // Prefer the original (untranslated) span when Amazon nests one; for local
  // reviews this also strips the star-rating alt text baked into the title.
  return (node?.querySelector('.cr-original-review-content')?.textContent ?? node?.textContent ?? '').trim();
};

const parseFilteredReview = (review: Element): FilteredReview => {
  const ratingEl = review.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]');
  return {
    rating: parseInt(ratingEl?.textContent?.match(/(\d)(?:\.\d)?/)?.[1] ?? '0', 10),
    title: pickText(review, '[data-hook="review-title"]'),
    body: pickText(review, '[data-hook="review-body"]'),
    verified: !!review.querySelector('[data-hook="avp-badge"]'),
    meta: review.querySelector('[data-hook="review-date"]')?.textContent?.trim() ?? '',
  };
};

const keywordSummaryPrompt = (kw: string) =>
  `These are Amazon reviews that mention "${kw}". Focus ONLY on what reviewers say about ${kw} for this product — ignore shipping, delivery, packaging, and seller issues. List what reviewers praise and complain about regarding ${kw}, most-mentioned first; include a point only if 2+ reviewers make it. If reviewers disagree, surface the tension. End with a short verdict on ${kw}.`;

const getRatingSummary = async (productSIN: string, numOfRatingsElement: HTMLElement, numOfRatings: any, cacheASIN: string) => {
  const recentRatingsURL = `/product-reviews/${productSIN}/?sortBy=recent`;
  let numberOfParsedReviews = 0;
  const scores = {
    recent: { absolute: 0, percentage: 0 as any },
    total: { calculated: 0, percentage: 0 },
  };
  const formatRatings: Record<string, number> = {};

  const scoresCacheKey = `ars-scores-v2-${cacheASIN}`;
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
    const el = document.querySelector('#cr-state-object') as HTMLElement | null;
    if (el?.dataset?.state) {
      try { return JSON.parse(el.dataset.state); } catch (_) {}
    }
    return null;
  };

  const crState = getCrState();
  const antiCsrf = crState?.reviewsCsrfToken;

  const parseAjaxChunks = (raw: string) => {
    let html = '';
    for (const chunk of raw.split('&&&')) {
      try {
        const arr = JSON.parse(chunk.trim());
        if (Array.isArray(arr) && typeof arr[2] === 'string') html += arr[2];
      } catch (_) {}
    }
    return html;
  };

  const portalUrl = '/portal/customer-reviews/ajax/reviews/get/ref=cm_cr_getr_d_paging_btm';
  const portalHeaders = {
    'x-requested-with': 'XMLHttpRequest',
    'content-type': 'application/x-www-form-urlencoded',
    ...(antiCsrf ? { 'anti-csrftoken-a2z': antiCsrf } : {}),
  };

  // The one paginated review fetch all three callers share: POST the review AJAX
  // (cursor via nextPageToken), fall back to the plain product-reviews page, parse,
  // and hand each page to onPage. extraParams (e.g. filterByKeyword) flow into both
  // the POST body and the fallback URL so filtered searches stay filtered; onPage
  // returns 'stop' to end pagination early.
  const fetchReviewPages = async (
    onPage: (doc: Document, page: number) => 'stop' | void,
    extraParams: Record<string, string> = {},
  ) => {
    const parser = new DOMParser();
    let nextToken: string | null = null;
    for (let page = 1; page <= NUMBER_OF_PAGES_TO_PARSE; page++) {
      const params: Record<string, string> = {
        sortBy: 'recent', pageNumber: String(page), pageSize: '10',
        asin: productSIN, scope: `reviewsAjax${page}`,
        deviceType: 'desktop', reftag: 'cm_cr_getr_d_paging_btm', ...extraParams,
      };
      if (nextToken) params.nextPageToken = nextToken;

      let html = '';
      try {
        const res = await fetch(portalUrl, {
          method: 'POST', credentials: 'include', headers: portalHeaders,
          body: new URLSearchParams(params),
        });
        if (res.ok) html = parseAjaxChunks(await res.text());
      } catch (_) {}

      if (!html) {
        const qs = new URLSearchParams({ sortBy: 'recent', pageNumber: String(page), ...extraParams });
        if (nextToken) qs.set('nextPageToken', nextToken);
        try {
          const res = await fetch(`/product-reviews/${productSIN}/?${qs}`, { credentials: 'include' });
          if (res.ok) html = await res.text();
        } catch (_) {}
      }
      if (!html) break;

      if (onPage(parser.parseFromString(html, 'text/html'), page) === 'stop') break;

      const tokenMatch = html.match(/nextPageToken[^:]*?:\s*(?:&quot;|")([^"&]+)/);
      nextToken = tokenMatch?.[1] ?? null;
      if (!nextToken) break;
    }
  };

  const extractReviewTexts = (doc: Document, seen: Set<string>) => {
    const reviews = doc.querySelectorAll('[data-hook="review"]');
    const texts: string[] = [];
    for (const review of reviews) {
      const bodyEl = review.querySelector('[data-hook="review-body"]');
      if (bodyEl) {
        const txt = bodyEl.textContent!.trim();
        if (txt && !seen.has(txt)) { seen.add(txt); texts.push(txt); }
      }
    }
    return { total: reviews.length, texts };
  };

  const ONE_DAY = 86400000;
  const fetchFreshReviewTexts = async () => {
    const reviewsCacheKey = `ars-reviews-${cacheASIN}`;
    const cachedTexts = cacheGet(reviewsCacheKey, ONE_DAY);
    if (cachedTexts) return cachedTexts;

    const seen = new Set<string>();
    const texts: string[] = [];
    await fetchReviewPages((doc, page) => {
      const { total, texts: newTexts } = extractReviewTexts(doc, seen);
      texts.push(...newTexts);
      if (total > 0 && newTexts.length === 0) {
        console.warn(`[ARS] Page ${page}: all ${total} reviews were duplicates — pagination broken, stopping`);
        return 'stop';
      }
    });

    if (texts.length) cacheSet(reviewsCacheKey, texts);
    return texts;
  };

  if (!usedCache) {
    const starRatingsToLikeDislikeMapping: Record<number, number> = { 5: 1, 1: -1 };
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
    } catch (_) {}

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
      <div class="ars-stat"><span class="ars-stat-val" data-ars="trending">\u2014</span><span class="ars-stat-lbl">trending</span></div>
      <div class="ars-stat-div"></div>
      <div class="ars-stat"><span class="ars-stat-val" data-ars="analyzed">0</span><span class="ars-stat-lbl">analyzed<span class="ars-scan-spinner" data-ars="scanning"></span></span></div>
    `;  // safe: no user content in template
    wrapper.appendChild(stats);

    elementToAppendTo!.appendChild(wrapper);

    const pctEl = gauge.querySelector('.ars-gauge-pct') as HTMLElement;
    const fillEl = gauge.querySelector('.ars-gauge-fill') as HTMLElement;
    const trendEl = wrapper.querySelector('[data-ars="trending"]') as HTMLElement;
    const analyzedEl = wrapper.querySelector('[data-ars="analyzed"]') as HTMLElement;

    const bumpEl = (el: Element) => {
      el.classList.remove('ars-bump');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('ars-bump')));
    };

    const updateLiveStats = () => {
      if (numberOfParsedReviews === 0) return;
      const pctRaw = scores.recent.absolute / numberOfParsedReviews;
      const pct = Math.round(pctRaw * 100);
      const { backgroundColor } = getColorForPercentage(pctRaw);
      const trendingScore = Math.round(scores.total.calculated * pctRaw);

      pctEl.textContent = `${pct}%`;
      pctEl.style.color = backgroundColor;
      fillEl.style.transform = `scaleX(${pctRaw})`;
      fillEl.style.background = backgroundColor;

      trendEl.textContent = addCommas(trendingScore);
      bumpEl(trendEl);

      analyzedEl.textContent = String(numberOfParsedReviews);
      bumpEl(analyzedEl);
    };

    const seenReviewIds = new Set<string>();
    const collectedReviewTexts: string[] = [];
    const reviewTextsSeen = new Set<string>();
    await fetchReviewPages((syntheticDocument, page) => {
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
        const reviewId = review.id || review.querySelector('[data-hook="review-body"]')?.textContent?.trim().slice(0, 80);
        if (!reviewId || seenReviewIds.has(reviewId)) continue;
        seenReviewIds.add(reviewId);

        const ratingElement = review.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]');
        if (!ratingElement) continue;

        numberOfParsedReviews++;
        const format = review.querySelector('a[data-hook="format-strip"]');

        const ratingText = (ratingElement as HTMLElement).textContent || '';
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

      // Collect review texts for summarize (avoids double-fetching)
      for (const review of reviews) {
        const bodyEl = review.querySelector('[data-hook="review-body"]');
        if (bodyEl) {
          const txt = bodyEl.textContent!.trim();
          if (txt && !reviewTextsSeen.has(txt)) { reviewTextsSeen.add(txt); collectedReviewTexts.push(txt); }
        }
      }

      if (seenReviewIds.size === prevSeen) {
        console.warn(`[ARS] Score page ${page}: all ${reviews.length} reviews were duplicates — pagination is broken, stopping`);
        return 'stop';
      }

      updateLiveStats();
    });

    if (numberOfParsedReviews > 0) {
      cacheSet(scoresCacheKey, { numberOfParsedReviews, scores, formatRatings });
    }
    if (collectedReviewTexts.length) {
      cacheSet(`ars-reviews-${cacheASIN}`, collectedReviewTexts);
    }

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
  } else {
    // Cached path: build final widget immediately
    if (numberOfParsedReviews > 0) {
      scores.recent.percentage = (scores.recent.absolute / numberOfParsedReviews).toFixed(2);
      const pctRaw = parseFloat(scores.recent.percentage);
      const pct = Math.round(pctRaw * 100);
      const { backgroundColor } = getColorForPercentage(pctRaw);
      const trendingScore = Math.round(scores.total.calculated * pctRaw);

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
        <div class="ars-stat"><span class="ars-stat-val">${addCommas(trendingScore)}</span><span class="ars-stat-lbl">trending</span></div>
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
  // Amazon's review AJAX accepts filterByKeyword, so this spans EVERY review —
  // not just the pages we scored — mirroring the Google Maps label search. One
  // paged fetch per OR-term, unioned by review id (sharing one DOMParser).
  const fetchKeywordTerm = async (term: string, seen: Set<string>): Promise<FilteredReview[]> => {
    const out: FilteredReview[] = [];
    await fetchReviewPages((doc) => {
      const reviews = doc.querySelectorAll('[data-hook="review"]');
      if (!reviews.length) return 'stop';
      let added = 0;
      for (const review of reviews) {
        const id = review.id || review.querySelector('[data-hook="review-body"]')?.textContent?.trim().slice(0, 80) || '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        added++;
        out.push(parseFilteredReview(review));
      }
      if (!added) return 'stop';
    }, { filterByKeyword: term });
    return out;
  };

  const fetchReviewsByKeyword = async (terms: string[]): Promise<FilteredReview[]> => {
    const seen = new Set<string>();
    const groups = await Promise.all(terms.map((t) => fetchKeywordTerm(t, seen)));
    return groups.flat();
  };

  const buildKeywordSearch = () => {
    const section = el('div', 'ars-search-section');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ars-search-input';
    input.placeholder = 'Search all reviews… e.g. "battery OR strap" (Enter)';
    section.appendChild(input);

    const header = el('div', 'ars-search-header');
    header.style.display = 'none';
    const scoreChip = el('span', 'ars-search-score');
    const summary = el('span', 'ars-search-summary');
    header.append(scoreChip, summary);
    section.appendChild(header);

    const list = el('div', 'ars-search-list');
    list.style.display = 'none';
    section.appendChild(list);

    // Re-filled with a fresh summarize/ask widget (scoped + cached per keyword)
    // on every successful search.
    const sumHost = el('div');
    section.appendChild(sumHost);

    let seq = 0;
    const reset = () => {
      seq++; // invalidate any in-flight search so it can't render after a clear
      header.style.display = 'none';
      list.style.display = 'none';
      list.textContent = '';
      sumHost.textContent = '';
    };

    const run = async () => {
      const query = input.value.trim();
      if (!query) { reset(); return; }
      const mySeq = ++seq;
      const terms = queryTerms(query);
      header.style.display = '';
      list.style.display = 'none';
      scoreChip.style.display = 'none';
      summary.textContent = `Searching “${query}”…`;
      sumHost.textContent = '';

      let reviews: FilteredReview[];
      try {
        reviews = await fetchReviewsByKeyword(terms);
      } catch (e) {
        if (mySeq === seq) summary.textContent = 'Search failed';
        console.error('[ARS] keyword search failed', e);
        return;
      }
      if (mySeq !== seq) return;

      let five = 0, one = 0;
      for (const r of reviews) { if (r.rating === 5) five++; else if (r.rating === 1) one++; }

      summary.textContent = '';
      summary.append(
        el('span', 'ars-search-count', addCommas(reviews.length)),
        document.createTextNode(` review${reviews.length === 1 ? '' : 's'} mention “${query}”`),
      );

      if (reviews.length) {
        const { nps } = npsStats(five, one, reviews.length);
        scoreChip.textContent = `${Math.round(nps)}%`;
        scoreChip.style.color = npsColor(nps);
        scoreChip.style.display = '';
      }

      list.style.display = '';
      list.textContent = '';
      if (!reviews.length) {
        list.appendChild(el('div', 'ars-search-empty', 'No reviews mention this'));
        return;
      }
      for (const r of reviews) {
        const meta = [r.verified ? '✓ Verified' : '', r.meta].filter(Boolean).join(' · ');
        list.appendChild(buildReviewCard({ rating: r.rating, title: r.title, body: r.body, meta }, terms));
      }

      const texts = reviews
        .map((r) => [r.title, r.body].filter(Boolean).join('. '))
        .filter((t) => t.length >= 20);
      if (texts.length) {
        buildSummarizeWidget({
          wrapper: sumHost,
          cacheKey: `review-summary-${cacheASIN}-kw-${query.toLowerCase()}`,
          summaryPrompt: keywordSummaryPrompt(query),
          fetchReviews: async () => texts,
          questionPlaceholder: `Ask about “${query}” reviews…`,
        });
      }
    };

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    input.addEventListener('input', () => { if (!input.value.trim()) reset(); });

    wrapper.appendChild(section);
  };

  if (numberOfParsedReviews > 0) {
    scores.recent.percentage = scores.recent.percentage || (scores.recent.absolute / numberOfParsedReviews).toFixed(2);
    buildKeywordSearch();

    buildSummarizeWidget({
      wrapper,
      cacheKey: `review-summary-${cacheASIN}`,
      summaryPrompt: PRODUCT_SUMMARY_PROMPT,
      fetchReviews: fetchFreshReviewTexts,
    });
  }

  if (!wrapper.parentNode) elementToAppendTo!.appendChild(wrapper);
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
  const ratingText = numOfRatingsElement.textContent!
    .match(/(\d{1,3}(,\d{3})*(\.\d+)?|\d+(\.\d+)?)[K]?/)![0]
    .replace(',', '');

  const numOfRatings = ratingText.endsWith('K')
    ? Math.round(parseFloat(ratingText.replace('K', '')) * 1000)
    : ratingText;

  const cacheASIN = getParentASIN() || productSIN;
  await getRatingSummary(productSIN, numOfRatingsElement, numOfRatings, cacheASIN);

  // Re-attach when variant switch removes our widget
  const wrapper = document.querySelector('.ars-wrapper');
  const variations = document.querySelector('.ts-var');
  if (!wrapper) return;

  const observer = new MutationObserver(() => {
    if (!document.contains(wrapper)) {
      const target = document.getElementById('averageCustomerReviews');
      if (target) target.appendChild(wrapper);
      if (variations) {
        const buyBox = document.querySelector('#desktop_buybox');
        if (buyBox) buyBox.parentNode!.insertBefore(variations, buyBox);
      }
    }
  });
  observer.observe(document.getElementById('dp') || document.body, { childList: true, subtree: true });
})();
