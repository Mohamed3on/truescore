import { GEMINI_API_KEY } from '../shared/config';
import { addCommas } from '../shared/utils';

const numberWithCommas = addCommas;

const NUMBER_OF_PAGES_TO_PARSE = 10;

function getColor(value: number) {
  //value from 0 to 1
  var hue = (value * 120).toString(10);
  return ['hsl(', hue, ',100%,50%)'].join('');
}

// 0 → red (hue 0), 1 → vivid green (hue 145)
var getColorForPercentage = function (pct: number) {
  pct = Math.max(0, Math.min(1, pct));
  var hue = pct * 145;
  return { backgroundColor: `hsl(${hue}, 85%, 40%)` };
};

const renderStructuredSummary = (container: HTMLElement, { complaints, praised, conclusion, betterAlternative }: any) => {
  container.textContent = '';
  const addSection = (title: string, items: string[], type: string) => {
    if (!items || !items.length) return;
    const section = document.createElement('div');
    section.className = `ars-section ars-section--${type}`;
    const heading = document.createElement('div');
    heading.className = 'ars-section-title';
    heading.innerHTML = `${type === 'praised' ? '&#x25B3;' : '&#x25BD;'} ${title}`;
    section.appendChild(heading);
    for (const item of items) {
      const bullet = document.createElement('div');
      bullet.className = 'ars-section-item';
      bullet.textContent = item;
      section.appendChild(bullet);
    }
    container.appendChild(section);
  };
  addSection('Universally praised', praised, 'praised');
  addSection('Common complaints', complaints, 'complaints');
  if (betterAlternative) {
    const section = document.createElement('div');
    section.className = 'ars-section ars-section--alt';
    const heading = document.createElement('div');
    heading.className = 'ars-section-title';
    heading.textContent = '\u21C4 Better alternative';
    section.appendChild(heading);
    const item = document.createElement('div');
    item.className = 'ars-section-item';
    item.textContent = betterAlternative;
    section.appendChild(item);
    container.appendChild(section);
  }
  if (conclusion) {
    const el = document.createElement('div');
    el.className = 'ars-conclusion';
    el.textContent = conclusion;
    container.appendChild(el);
  }
};

// Legacy renderer for old cached text summaries
const renderSummary = (container: HTMLElement, text: string) => {
  container.textContent = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const el = document.createElement('div');
    el.className = /^#{1,3}\s/.test(trimmed) ? 'ars-section-title' : 'ars-section-item';
    el.textContent = trimmed.replace(/^[#*]+\s*/, '');
    container.appendChild(el);
  }
};

const getRatingPercentages = (htmlText: string) => {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText || '', 'text/html');
    const nodes = doc.querySelectorAll('[role="progressbar"][aria-valuenow]');
    const values = Array.from(nodes)
      .map((el) => el.getAttribute('aria-valuenow'))
      .filter(Boolean)
      .map((v) => parseInt(String(v).replace('%', ''), 10))
      .filter((n) => Number.isFinite(n));

    if (values.length < 2) {
      return { fiveStars: 0, oneStars: 0 };
    }

    const fiveStars = values[0];
    const oneStars = values[values.length - 1];

    return { fiveStars, oneStars };
  } catch (_) {
    return { fiveStars: 0, oneStars: 0 };
  }
};

const injectBestFormats = (formatRatings: Record<string, number>) => {
  if (!Object.keys(formatRatings).length) return;

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

  elementToReplace.innerHTML = ` ${numberWithCommas(calculatedScore)} ratio: (${scorePercentage}%)`;

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

  // Check scores cache
  const scoresCacheKey = `ars-scores-${cacheASIN}`;
  const rawScoresCache = localStorage.getItem(scoresCacheKey);
  let usedCache = false;

  if (rawScoresCache) {
    try {
      const cached = JSON.parse(rawScoresCache);
      if (Date.now() - cached.ts < THREE_DAYS) {
        numberOfParsedReviews = cached.numberOfParsedReviews;
        scores.recent = cached.scores.recent;
        scores.total = cached.scores.total;
        Object.assign(formatRatings, cached.formatRatings);
        numOfRatingsElement.innerHTML = ` ${numberWithCommas(scores.total.calculated)} ratio: (${Math.round(scores.total.percentage * 100)}%)`;
        usedCache = true;
      } else {
        localStorage.removeItem(scoresCacheKey);
      }
    } catch (_) {}
  }

  const numberOfReviewsPerPage = 10;

  const extractReviewListHTMLFromAjaxResponse = (raw: string) => {
    if (!raw) return '';
    const chunks = raw.split('&&&');
    let html = '';
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      try {
        const payload = JSON.parse(trimmed);
        if (
          Array.isArray(payload) &&
          payload.length >= 3 &&
          payload[0] === 'append' &&
          payload[1] === '#cm_cr-review_list' &&
          typeof payload[2] === 'string'
        ) {
          html += payload[2];
        }
      } catch (_) {}
    }
    return html;
  };

  const getAntiCsrfToken = () => {
    const stateElement = document.querySelector('#cr-state-object') as HTMLElement | null;
    if (stateElement && stateElement.dataset.state) {
      try {
        const stateData = JSON.parse(stateElement.dataset.state);
        return stateData.reviewsCsrfToken;
      } catch (_) {}
    }
    return undefined;
  };

  const getReviewsAjaxScopeFromDOM = () => {
    try {
      const html = document.documentElement.innerHTML;
      const matches = [...html.matchAll(/reviewsAjax(\d+)/g)];
      if (matches.length) {
        const maxIdx = matches
          .map((m) => parseInt(m[1], 10))
          .filter((n) => Number.isFinite(n))
          .reduce((a, b) => Math.max(a, b), 0);
        return `reviewsAjax${maxIdx}`;
      }
    } catch (_) {}
    return 'reviewsAjax0';
  };

  const scope = getReviewsAjaxScopeFromDOM();
  const antiCsrf = getAntiCsrfToken();

  const fetchReviewPage = async (pageNumber: number) => {
    const endpoint = `/hz/reviews-render/ajax/reviews/get/ref=cm_cr_getr_d_paging_btm_next_${pageNumber}`;
    const form = new URLSearchParams({
      sortBy: 'recent',
      pageNumber: String(pageNumber),
      pageSize: String(numberOfReviewsPerPage),
      asin: productSIN,
      scope,
      reftag: `cm_cr_getr_d_paging_btm_next_${pageNumber}`
    });

    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        ...(antiCsrf ? { 'anti-csrftoken-a2z': antiCsrf } : {}),
      },
      body: form,
    });
    const raw = await res.text();
    return extractReviewListHTMLFromAjaxResponse(raw);
  };

  const ONE_DAY = 86400000;
  const fetchFreshReviewTexts = async () => {
    const reviewsCacheKey = `ars-reviews-${cacheASIN}`;
    try {
      const cached = JSON.parse(localStorage.getItem(reviewsCacheKey)!);
      if (cached && Date.now() - cached.ts < ONE_DAY) return cached.texts;
    } catch (_) {}

    const pagePromises = Array.from({ length: NUMBER_OF_PAGES_TO_PARSE }, (_, i) =>
      fetchReviewPage(i + 1)
    );
    const results = await Promise.allSettled(pagePromises);
    const parser = new DOMParser();
    const texts: string[] = [];
    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const doc = parser.parseFromString(result.value, 'text/html');
      for (const review of doc.querySelectorAll('[data-hook="review"]')) {
        const bodyEl = review.querySelector('[data-hook="review-body"]');
        if (bodyEl) {
          const txt = bodyEl.textContent!.trim();
          if (txt) texts.push(txt);
        }
      }
    }
    try { localStorage.setItem(reviewsCacheKey, JSON.stringify({ ts: Date.now(), texts })); } catch (_) {}
    return texts;
  };

  if (!usedCache) {
    const starRatingsToLikeDislikeMapping: Record<number, number> = { 5: 1, 1: -1 };
    let totalRatingPercentages: { fiveStars: number; oneStars: number } | undefined;
    const parser = new DOMParser();

    try {
      const pageHTML = document.documentElement.innerHTML;
      const totals = getRatingPercentages(pageHTML);
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

    const pagePromises = Array.from({ length: NUMBER_OF_PAGES_TO_PARSE }, (_, i) =>
      fetchReviewPage(i + 1)
    );

    const results = await Promise.allSettled(pagePromises);
    const reviewPages = results
      .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
      .map(result => result.value);

    for (const recentRatingsHTML of reviewPages) {
      if (!recentRatingsHTML) continue;

      if (!totalRatingPercentages) {
        totalRatingPercentages = getRatingPercentages(recentRatingsHTML);
        const { calculatedScore, totalScorePercentage } = setTotalRatingsScore(
          totalRatingPercentages, numOfRatingsElement, numOfRatings
        );
        scores.total = { calculated: calculatedScore, percentage: totalScorePercentage };
      }

      const syntheticDocument = parser.parseFromString(recentRatingsHTML, 'text/html');
      const reviews = syntheticDocument.querySelectorAll('[data-hook="review"]');

      for (const review of reviews) {
        const ratingElement = review.querySelector('[data-hook="review-star-rating"]');
        if (!ratingElement) break;

        numberOfParsedReviews++;
        const format = review.querySelector('a[data-hook="format-strip"]');

        const ratingText = (ratingElement as HTMLElement).innerText;
        const rating = parseInt(ratingText.match(/\d(?=\.)/g)![0]);

        if (rating === 5 || rating === 1) {
          if (format) {
            const cleanedFormat = format.innerHTML.replaceAll(' Name:', ':');
            formatRatings[cleanedFormat] = formatRatings[cleanedFormat]
              ? formatRatings[cleanedFormat] + starRatingsToLikeDislikeMapping[rating]
              : starRatingsToLikeDislikeMapping[rating];
          }
          scores.recent.absolute += starRatingsToLikeDislikeMapping[rating];
        }
      }
    }

    if (numberOfParsedReviews > 0) {
      try {
        localStorage.setItem(scoresCacheKey, JSON.stringify({
          ts: Date.now(),
          numberOfParsedReviews,
          scores,
          formatRatings,
        }));
      } catch (_) {}
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
      <div class="ars-stat"><span class="ars-stat-val">${numberWithCommas(trendingScore)}</span><span class="ars-stat-lbl">trending</span></div>
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
    const cacheKey = `review-summary-${cacheASIN}`;
    const THIRTY_DAYS = 30 * 86400000;
    const rlKey = 'ars-gemini-rate-limit';
    const summaryPanel = document.createElement('div');
    summaryPanel.className = 'ars-summary-panel';
    summaryPanel.style.display = 'none';

    const checkRateLimit = () => {
      let rl = JSON.parse(localStorage.getItem(rlKey) || '{"count":0,"resetAt":0}');
      if (Date.now() > rl.resetAt) rl = { count: 0, resetAt: Date.now() + 86400000 };
      return rl;
    };

    const runSummarize = async (btn: HTMLButtonElement) => {
      btn.disabled = true;
      btn.textContent = '⏳ Summarizing…';
      const t0 = performance.now();
      try {
        btn.textContent = '⏳ Fetching reviews…';
        const freshReviews = await fetchFreshReviewTexts();
        if (!freshReviews.length) throw new Error('No reviews found');
        freshReviews.sort((a: string, b: string) => b.length - a.length);
        btn.textContent = '⏳ Summarizing…';
        const prompt = `Analyze these Amazon product reviews. Ignore anything about shipping, delivery, packaging, or seller issues — focus ONLY on the product itself. Skip generic praise like "great product".

ONLY include points mentioned by 3+ reviewers. Rank by frequency (most mentioned first). Each bullet should start with the count, e.g. "(12) Too sweet for some tastes".

If 2+ reviewers mention a specific better alternative product, note it and explain how reviewers compare it to this product (e.g. what's better/worse about the alternative).

End with a 2-3 sentence verdict: who this product is ideal for, who should avoid it, and whether it's worth the price based on what reviewers say.

Reviews:\n\n${freshReviews.join('\n---\n')}`;
        const promptBytes = new Blob([prompt]).size;
        console.log(`[ARS] Gemini request: ${freshReviews.length} reviews, prompt ${(promptBytes / 1024).toFixed(1)} KB`);

        const tFetch = performance.now();
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0,
                thinkingConfig: { thinkingLevel: 'MINIMAL' },
                maxOutputTokens: 2048,
                responseMimeType: 'application/json',
                responseSchema: {
                  type: 'object',
                  properties: {
                    complaints: {
                      type: 'array',
                      description: 'Specific product issues multiple reviewers agree on, ranked by frequency',
                      items: { type: 'string' }
                    },
                    praised: {
                      type: 'array',
                      description: 'Things nearly everyone loved about the product',
                      items: { type: 'string' }
                    },
                    conclusion: {
                      type: 'string',
                      description: '2-3 sentences: who it is ideal for, who should avoid it, and whether it is worth the price'
                    },
                    betterAlternative: {
                      type: 'string',
                      description: 'A specific alternative product 2+ reviewers say is better, including how they compare it to this product (what is better/worse about it). Empty string if none.',
                      nullable: true
                    }
                  },
                  required: ['complaints', 'praised', 'conclusion']
                }
              }
            }),
          }
        );
        const tResponse = performance.now();
        console.log(`[ARS] Gemini HTTP status: ${res.status} — network wait: ${((tResponse - tFetch) / 1000).toFixed(2)}s`);

        const tParseStart = performance.now();
        const data = await res.json();
        const tParseEnd = performance.now();
        console.log(`[ARS] Response JSON parse: ${((tParseEnd - tParseStart) / 1000).toFixed(2)}s`);

        const parts = data?.candidates?.[0]?.content?.parts || [];
        const raw = parts.filter((p: any) => !p.thought).pop()?.text;
        if (!raw) {
          console.warn('[ARS] Gemini returned no text. Full response:', JSON.stringify(data).slice(0, 500));
        }
        const parsed = JSON.parse(raw);
        const ts = Date.now();

        const rl = checkRateLimit();
        rl.count++;
        localStorage.setItem(rlKey, JSON.stringify(rl));
        localStorage.setItem(cacheKey, JSON.stringify({ parsed, ts }));

        renderStructuredSummary(summaryPanel, parsed);
        summaryPanel.style.display = 'block';
        console.log(`[ARS] Summarize total: ${((performance.now() - t0) / 1000).toFixed(2)}s`);
        return ts;
      } catch (e: any) {
        console.error(`[ARS] Summarize failed after ${((performance.now() - t0) / 1000).toFixed(2)}s:`, e);
        summaryPanel.textContent = `Error: ${e.message}`;
        summaryPanel.style.display = 'block';
        btn.disabled = false;
        btn.textContent = '✦ Summarize Reviews';
        return null;
      }
    };

    const showDateRow = (ts: number) => {
      const row = document.createElement('div');
      row.className = 'ars-summary-meta';
      const dateLabel = document.createElement('div');
      dateLabel.className = 'ars-summary-date';
      dateLabel.textContent = `Summarized on ${new Date(ts).toLocaleDateString()}`;
      row.appendChild(dateLabel);

      if (checkRateLimit().count < 20) {
        const reBtn = document.createElement('button');
        reBtn.className = 'ars-resummarize-btn';
        reBtn.textContent = '↻ Re-summarize';
        reBtn.addEventListener('click', async () => {
          const newTs = await runSummarize(reBtn);
          if (newTs) row.replaceWith(showDateRow(newTs));
        });
        row.appendChild(reBtn);
      }
      wrapper.appendChild(row);
      return row;
    };

    // Check cache (valid for 30 days)
    const rawCache = localStorage.getItem(cacheKey);
    let cached: any = null;
    if (rawCache) {
      try { cached = JSON.parse(rawCache); } catch (_) {}
      if (cached && Date.now() - cached.ts > THIRTY_DAYS) {
        localStorage.removeItem(cacheKey);
        cached = null;
      }
    }

    if (cached) {
      showDateRow(cached.ts);
      if (cached.parsed) {
        renderStructuredSummary(summaryPanel, cached.parsed);
      } else {
        renderSummary(summaryPanel, cached.text);
      }
      summaryPanel.style.display = 'block';
    } else if (checkRateLimit().count < 20) {
      const summarizeBtn = document.createElement('button');
      summarizeBtn.className = 'ars-summarize-btn';
      summarizeBtn.textContent = '✦ Summarize Reviews';
      summarizeBtn.addEventListener('click', async () => {
        const ts = await runSummarize(summarizeBtn);
        if (ts) summarizeBtn.replaceWith(showDateRow(ts));
      });
      wrapper.appendChild(summarizeBtn);
    }
    wrapper.appendChild(summaryPanel);
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
