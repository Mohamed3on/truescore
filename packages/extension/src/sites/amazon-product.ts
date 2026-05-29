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
  // Specific (exact combination) leads; per-dimension breakdowns follow as extra tabs.
  const tabs: { label: string; rows: [string, number][] }[] = showTabs
    ? [
        { label: 'Specific', rows: specificRows.slice().sort(byScore) },
        ...compareDims.map(([dim, vals]) => ({ label: dim, rows: [...vals.entries()].sort(byScore) })),
      ]
    : [{ label: '', rows: specificRows.slice().sort(byScore) }];

  const box = document.createElement('div');
  box.className = 'ars-variations';

  const head = document.createElement('div');
  head.className = 'ars-var-head';
  const title = document.createElement('span');
  title.className = 'ars-var-title';
  title.textContent = 'Best by variation';
  head.appendChild(title);
  box.appendChild(head);

  const panel = document.createElement('div');
  panel.className = 'ars-var-panel';

  const renderPanel = (rows: [string, number][]) => {
    panel.replaceChildren();
    const maxAbs = rows.reduce((m, [, s]) => Math.max(m, Math.abs(s)), 0) || 1;
    rows.forEach(([name, score], i) => {
      const sign = score > 0 ? 'ars-fmt-pos' : score < 0 ? 'ars-fmt-neg' : '';
      const row = document.createElement('div');
      row.className = 'ars-var-row' + (i === 0 && score > 0 ? ' ars-var-best' : '');
      row.style.animationDelay = `${Math.min(i, 12) * 30}ms`;

      const nameEl = document.createElement('span');
      nameEl.className = 'ars-var-name';
      nameEl.textContent = name;

      const track = document.createElement('span');
      track.className = 'ars-var-track';
      const fill = document.createElement('i');
      fill.className = `ars-var-fill ${sign}`;
      fill.style.width = `${(Math.abs(score) / maxAbs) * 100}%`;
      track.appendChild(fill);

      const scoreEl = document.createElement('span');
      scoreEl.className = `ars-var-score ${sign}`;
      scoreEl.textContent = (score > 0 ? '+' : '') + score;

      row.append(nameEl, track, scoreEl);
      panel.appendChild(row);
    });
  };

  if (showTabs) {
    const tabBar = document.createElement('div');
    tabBar.className = 'ars-var-tabs';
    tabBar.setAttribute('role', 'tablist');
    tabs.forEach((tab, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ars-var-tab' + (i === 0 ? ' is-active' : '');
      btn.setAttribute('role', 'tab');
      btn.textContent = tab.label;
      btn.addEventListener('click', () => {
        tabBar.querySelectorAll('.ars-var-tab').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        renderPanel(tab.rows);
      });
      tabBar.appendChild(btn);
    });
    head.appendChild(tabBar);
  }

  box.appendChild(panel);
  renderPanel(tabs[0].rows);

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
  const wrapper = document.createElement('div');
  wrapper.className = 'ars-wrapper';

  const headerEl = document.createElement('div');
  headerEl.className = 'ars-header';
  headerEl.innerHTML = '<span class="ars-header-accent">&#x25C8;</span> Review Intelligence';
  wrapper.appendChild(headerEl);

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
          const fallbackUrl = `/product-reviews/${productSIN}/?sortBy=recent&pageNumber=${page}${nextToken ? `&nextPageToken=${encodeURIComponent(nextToken)}` : ''}`;
          const res = await fetch(fallbackUrl, { credentials: 'include' });
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
          const fallbackUrl = `/product-reviews/${productSIN}/?sortBy=recent&pageNumber=${page}${nextToken ? `&nextPageToken=${encodeURIComponent(nextToken)}` : ''}`;
          const res = await fetch(fallbackUrl, { credentials: 'include' });
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
        break;
      }

      updateLiveStats();

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

  if (numberOfParsedReviews > 0) {
    scores.recent.percentage = scores.recent.percentage || (scores.recent.absolute / numberOfParsedReviews).toFixed(2);
    const SUMMARY_PROMPT = `Analyze these Amazon product reviews. Ignore anything about shipping, delivery, packaging, or seller issues \u2014 focus ONLY on the product itself. Skip generic praise like "great product".

ONLY include points mentioned by 3+ reviewers. Rank by frequency (most mentioned first). Each bullet should be one concrete point, e.g. "Too sweet for some tastes".

If 2+ reviewers mention a specific better alternative product, note it and explain how reviewers compare it to this product (e.g. what's better/worse about the alternative).

Check for signs of review manipulation: repetitive phrasing across reviews, suspiciously similar wording or sentence structure, lack of specific/unique details, generic praise that reads like astroturfing, or signs of incentivized reviews. If detected, warn about it. If reviews appear genuine, leave suspiciousPatterns empty.

End with a short summary: the gist of what owners say, anything to watch out for, any better alternatives mentioned, and whether this is the best you can get for the price.`;

    buildSummarizeWidget({
      wrapper,
      cacheKey: `review-summary-${cacheASIN}`,
      summaryPrompt: SUMMARY_PROMPT,
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
  const variations = document.querySelector('.ars-variations');
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
