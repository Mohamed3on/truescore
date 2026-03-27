import { cacheGet, cacheSet } from '../shared/cache';
import { addCommas } from '../shared/utils';
import { buildSummarizeWidget } from '../shared/review-summary';

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

const injectBestFormats = (formatRatings: Record<string, number>) => {
  const sortedFormats = Object.entries(formatRatings)
    .sort((a, b) => b[1] - a[1]);

  if (!sortedFormats.length) return;

  const table = document.createElement('table');
  table.className = 'format-table';
  const header = table.createTHead();
  const row = header.insertRow(0);
  row.insertCell(0).textContent = 'Variation';
  row.insertCell(1).textContent = 'Sentiment';
  const body = table.createTBody();
  sortedFormats.forEach(([name, score]) => {
    const tr = body.insertRow();
    tr.insertCell().innerHTML = name;
    const scoreCell = tr.insertCell();
    scoreCell.textContent = (score > 0 ? '+' : '') + score;
    scoreCell.className = score > 0 ? 'ars-fmt-pos' : score < 0 ? 'ars-fmt-neg' : '';
  });

  const buyBox = document.querySelector('#desktop_buybox');
  if (buyBox) buyBox.parentNode!.insertBefore(table, buyBox);
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

const getRatingSummary = async (productSIN: string, numOfRatingsElement: HTMLElement, numOfRatings: any, cacheASIN: string) => {
  const recentRatingsURL = `/product-reviews/${productSIN}/?sortBy=recent`;
  let numberOfParsedReviews = 0;
  const scores = {
    recent: { absolute: 0, percentage: 0 as any },
    total: { calculated: 0, percentage: 0 },
  };
  const formatRatings: Record<string, number> = {};

  const scoresCacheKey = `ars-scores-${cacheASIN}`;
  const cachedScores = cacheGet(scoresCacheKey, THREE_DAYS);
  let usedCache = false;

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

  const extractReviewTexts = (html: string, parser: DOMParser, seen: Set<string>) => {
    const doc = parser.parseFromString(html, 'text/html');
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

    const parser = new DOMParser();
    const seen = new Set<string>();
    const texts: string[] = [];
    let nextToken: string | null = null;

    for (let page = 1; page <= NUMBER_OF_PAGES_TO_PARSE; page++) {
      // Try /portal/ AJAX with cursor
      const params: Record<string, string> = {
        sortBy: 'recent', pageNumber: String(page), pageSize: '10',
        asin: productSIN, scope: `reviewsAjax${page}`,
        deviceType: 'desktop', reftag: 'cm_cr_getr_d_paging_btm',
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

      // Fallback to HTML scrape
      if (!html) {
        try {
          const res = await fetch(`/product-reviews/${productSIN}/?sortBy=recent&pageNumber=${page}`, { credentials: 'include' });
          if (res.ok) html = await res.text();
        } catch (_) {}
      }
      if (!html) break;

      const { total, texts: newTexts } = extractReviewTexts(html, parser, seen);
      texts.push(...newTexts);
      if (total > 0 && newTexts.length === 0) {
        console.warn(`[ARS] Page ${page}: all ${total} reviews were duplicates — pagination broken, stopping`);
        break;
      }

      const tokenMatch = html.match(/nextPageToken[^:]*?:\s*(?:&quot;|")([^"&]+)/);
      nextToken = tokenMatch?.[1] ?? null;
      if (!nextToken) break;
    }

    if (texts.length) cacheSet(reviewsCacheKey, texts);
    return texts;
  };

  if (!usedCache) {
    const starRatingsToLikeDislikeMapping: Record<number, number> = { 5: 1, 1: -1 };
    let totalRatingPercentages: { fiveStars: number; oneStars: number } | undefined;
    const parser = new DOMParser();

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

    const loadingEl = document.createElement('div');
    loadingEl.className = 'ars-wrapper';
    loadingEl.innerHTML = '<div class="ars-header"><span class="ars-header-accent">&#x25C8;</span> Review Intelligence</div><div class="ars-loading">Analyzing recent reviews\u2026</div>';
    document.querySelector('#averageCustomerReviews')?.appendChild(loadingEl);

    const seenReviewIds = new Set<string>();
    const collectedReviewTexts: string[] = [];
    const reviewTextsSeen = new Set<string>();
    let nextToken: string | null = null;
    for (let page = 1; page <= NUMBER_OF_PAGES_TO_PARSE; page++) {
      let html = '';
      const portalParams: Record<string, string> = {
        sortBy: 'recent', pageNumber: String(page), pageSize: '10',
        asin: productSIN, scope: `reviewsAjax${page}`,
        deviceType: 'desktop', reftag: 'cm_cr_getr_d_paging_btm',
      };
      if (nextToken) portalParams.nextPageToken = nextToken;
      try {
        const res = await fetch(portalUrl, {
          method: 'POST', credentials: 'include', headers: portalHeaders,
          body: new URLSearchParams(portalParams),
        });
        if (res.ok) html = parseAjaxChunks(await res.text());
      } catch (_) {}

      if (!html) {
        try {
          const res = await fetch(`/product-reviews/${productSIN}/?sortBy=recent&pageNumber=${page}`, { credentials: 'include' });
          if (res.ok) html = await res.text();
        } catch (_) {}
      }
      if (!html) break;

      const syntheticDocument = parser.parseFromString(html, 'text/html');

      if (!totalRatingPercentages) {
        totalRatingPercentages = getRatingPercentages(syntheticDocument);
        const { calculatedScore, totalScorePercentage } = setTotalRatingsScore(
          totalRatingPercentages, numOfRatingsElement, numOfRatings
        );
        scores.total = { calculated: calculatedScore, percentage: totalScorePercentage };
      }

      const reviews = syntheticDocument.querySelectorAll('[data-hook="review"]');
      if (!reviews.length) break;

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
            const cleanedFormat = format.innerHTML.replaceAll(' Name:', ':');
            formatRatings[cleanedFormat] = (formatRatings[cleanedFormat] ?? 0) + starRatingsToLikeDislikeMapping[rating];
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
        break;
      }

      const tokenMatch = html.match(/nextPageToken[^:]*?:\s*(?:&quot;|")([^"&]+)/);
      nextToken = tokenMatch?.[1] ?? null;
      if (!nextToken) break;
    }

    if (numberOfParsedReviews > 0) {
      cacheSet(scoresCacheKey, { numberOfParsedReviews, scores, formatRatings });
    }
    if (collectedReviewTexts.length) {
      cacheSet(`ars-reviews-${cacheASIN}`, collectedReviewTexts);
    }
    loadingEl.remove();
  }

  const elementToAppendTo = document.querySelector('#averageCustomerReviews');

  const wrapper = document.createElement('div');
  wrapper.className = 'ars-wrapper';

  const header = document.createElement('div');
  header.className = 'ars-header';
  header.innerHTML = '<span class="ars-header-accent">&#x25C8;</span> Review Intelligence';
  wrapper.appendChild(header);

  if (numberOfParsedReviews > 0) {
    scores.recent.percentage = (scores.recent.absolute / numberOfParsedReviews).toFixed(2);
    const trendingScore = Math.round(scores.total.calculated * scores.recent.percentage);
    let { backgroundColor } = getColorForPercentage(scores.recent.percentage);
    const pct = Math.round(scores.recent.percentage * 100);

    const gauge = document.createElement('a');
    gauge.className = 'ars-gauge';
    gauge.href = recentRatingsURL;
    gauge.innerHTML = `
      <div class="ars-gauge-label"><span class="ars-gauge-pct" style="color:${backgroundColor}">${pct}%</span> recent positive</div>
      <div class="ars-gauge-track"><div class="ars-gauge-fill" style="width:${pct}%;background:${backgroundColor}"></div></div>
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

  if (numberOfParsedReviews > 0) {
    const SUMMARY_PROMPT = `Analyze these Amazon product reviews. Ignore anything about shipping, delivery, packaging, or seller issues \u2014 focus ONLY on the product itself. Skip generic praise like "great product".

ONLY include points mentioned by 3+ reviewers. Rank by frequency (most mentioned first). Each bullet should start with the count, e.g. "(12) Too sweet for some tastes".

If 2+ reviewers mention a specific better alternative product, note it and explain how reviewers compare it to this product (e.g. what's better/worse about the alternative).

Check for signs of review manipulation: repetitive phrasing across reviews, suspiciously similar wording or sentence structure, lack of specific/unique details, generic praise that reads like astroturfing, or signs of incentivized reviews. If detected, warn about it. If reviews appear genuine, leave suspiciousPatterns empty.

End with a 2-3 sentence verdict: who this product is ideal for, who should avoid it, and whether it's worth the price based on what reviewers say.`;

    buildSummarizeWidget({
      wrapper,
      cacheKey: `review-summary-${cacheASIN}`,
      summaryPrompt: SUMMARY_PROMPT,
      fetchReviews: fetchFreshReviewTexts,
    });
  }

  elementToAppendTo!.appendChild(wrapper);
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
  const formatTable = document.querySelector('.format-table');
  if (!wrapper) return;

  const observer = new MutationObserver(() => {
    if (!document.contains(wrapper)) {
      const target = document.getElementById('averageCustomerReviews');
      if (target) target.appendChild(wrapper);
      if (formatTable) {
        const buyBox = document.querySelector('#desktop_buybox');
        if (buyBox) buyBox.parentNode!.insertBefore(formatTable, buyBox);
      }
    }
  });
  observer.observe(document.getElementById('dp') || document.body, { childList: true, subtree: true });
})();
