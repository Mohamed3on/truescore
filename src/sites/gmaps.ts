import { GEMINI_API_KEY, geminiEndpoint } from '../shared/config';

// Constants
const TIME_PERIODS = ['total', 'inPastYear', 'inPastMonth'];
const SORT_KEYS = ['relevant', 'newest'];
const PAGE_SIZE = 20;
const MIN_PAGES_BEFORE_STABILIZE = 2;
const getGeminiKey = () => document.documentElement.dataset.tsGeminiKey || GEMINI_API_KEY;
const getGeminiEndpoint = () => geminiEndpoint(getGeminiKey());

// State
let currentOption = 'total';
let lastPlaceName = '';
let lastUrl = '';
let abortControllers: any = { relevant: null, newest: null };
let summaryCache: any = { all: null, filtered: null };
let reviewLimit = 50;
let fullPctObserver: MutationObserver | null = null;

const getSummaryCacheKey = () => `rc_summary_${lastPlaceName || 'default'}`;
const loadSummaryCache = () => {
  try { summaryCache = JSON.parse(localStorage.getItem(getSummaryCacheKey()) as string) || { all: null, filtered: null }; }
  catch { summaryCache = { all: null, filtered: null }; }
};
const saveSummaryCache = () => { try { localStorage.setItem(getSummaryCacheKey(), JSON.stringify(summaryCache)); } catch {} };

const makeReviewData = () => ({
  reviewsScores: Object.fromEntries(TIME_PERIODS.map((p) => [p, 0])),
  trustedReviews: Object.fromEntries(TIME_PERIODS.map((p) => [p, 0])),
  totalReviews: Object.fromEntries(TIME_PERIODS.map((p) => [p, 0])),
});

const makeState = () => ({ reviewMap: {} as any, reviewData: makeReviewData(), isFetching: false, done: false, cursor: '', pageCount: 0 });
const scores: any = { relevant: makeState(), newest: makeState() };

// Helpers
const getReviewCount = (sortKey: string) => Object.keys(scores[sortKey].reviewMap).length;
const getRoundedPct = (sortKey: string) => Math.round(getScorePercentage(sortKey) * 100);
const getScorePercentage = (sortKey: string) => {
  const { reviewsScores, trustedReviews } = scores[sortKey].reviewData;
  return reviewsScores[currentOption] / trustedReviews[currentOption] || 0;
};

const getMergedScore = () => {
  let totalScore = 0, totalTrusted = 0;
  for (const key of SORT_KEYS) {
    totalScore += scores[key].reviewData.reviewsScores[currentOption];
    totalTrusted += scores[key].reviewData.trustedReviews[currentOption];
  }
  return totalTrusted ? totalScore / totalTrusted : 0;
};

const resetScores = () => {
  for (const key of SORT_KEYS) {
    scores[key] = makeState();
    if (abortControllers[key]) { abortControllers[key].abort(); abortControllers[key] = null; }
  }
  if (fullPctObserver) { fullPctObserver.disconnect(); fullPctObserver = null; }
};

const getScoreColor = (pct: number) => {
  const stops = [
    { at: 0, r: 248, g: 113, b: 113 },
    { at: 0.5, r: 251, g: 191, b: 36 },
    { at: 1, r: 74, g: 222, b: 128 },
  ];
  const p = Math.max(0, Math.min(1, pct));
  const i = stops.findIndex((s) => p <= s.at);
  const lo = stops[Math.max(0, i - 1)];
  const hi = stops[Math.min(stops.length - 1, i)];
  const t = hi.at === lo.at ? 0 : (p - lo.at) / (hi.at - lo.at);
  return `rgb(${Math.round(lo.r + (hi.r - lo.r) * t)},${Math.round(lo.g + (hi.g - lo.g) * t)},${Math.round(lo.b + (hi.b - lo.b) * t)})`;
};

const calculateFullPercentage = () => {
  const reviewRows = document.querySelectorAll('tr[role="img"]');
  if (reviewRows.length < 5) return null;
  const extractNumber = (str: string) => {
    const match = str.match(/(\d+(?:[.,]\d+)*)\s*(?:reviews?|$)/);
    return match ? parseInt(match[1].replace(/[.,]/g, ''), 10) : 0;
  };
  const counts = Array.from(reviewRows).map((r) => extractNumber(r.getAttribute('aria-label') || ''));
  const allReviews = counts.reduce((a, b) => a + b, 0);
  if (!allReviews) return null;
  return Math.round(((counts[0] - counts[4]) / allReviews) * 100);
};

const getPlaceInfo = () => {
  const name = document.querySelector('h1.DUwDvf')?.textContent?.trim() || '';
  const category = (document.querySelector('button.DkEaL') as HTMLElement)?.textContent?.trim() || '';
  return { name, category };
};

// Simple score display (from Show-GMaps-score)
const addCommas = (x: string) => {
  return x.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

const injectSimpleScore = (placeDetailsElement: HTMLElement) => {
  const fiveStars = document
    .querySelectorAll('tr[role="img"]')[0]
    ?.ariaLabel?.match(/(?<=stars,\s)(\d*),*(\d*)/g)?.[0];
  if (!fiveStars) return;

  const fiveStarsAsNumber = Number(fiveStars.split(',').join(''));
  const oneStars = document
    .querySelectorAll('tr[role="img"]')[4]
    ?.ariaLabel?.match(/(?<=stars,\s)(\d*),*(\d*)/g)?.[0];
  if (!oneStars) return;

  const oneStarsAsNumber = Number(oneStars.split(',').join(''));

  const score = fiveStarsAsNumber - oneStarsAsNumber;

  const allReviewsText = (document.querySelector(
    '[jsaction="pane.reviewChart.moreReviews"] button'
  ) as HTMLElement)?.innerText;

  const allReviewsMatch = allReviewsText?.match(/\d+/g)?.join('');

  const allReviewsAsNumber = Number(allReviewsMatch || 0);

  const ratio = allReviewsAsNumber ? score / allReviewsAsNumber : 0;

  const calculatedScore = Math.round(score * ratio);

  const scorePercentage = Math.round(ratio * 100);

  const newElement = document.createElement('div');
  newElement.innerHTML = `score: ${addCommas(String(calculatedScore))} &mdash; ${scorePercentage}%`;
  placeDetailsElement.appendChild(newElement);
};

// URL & API
const getFeatureId = () => {
  const matches = [...location.href.matchAll(/!3m\d+!1s(0x[a-f0-9]+(?:%3A|:)0x[a-f0-9]+)/gi)];
  return matches.length ? decodeURIComponent(matches[matches.length - 1][1]) : null;
};

const buildUrl = (featureId: string, sort: string, cursor = '') => {
  const hl = document.documentElement.lang || 'en';
  const gl = location.href.match(/gl=([a-zA-Z]{2})/)?.[1] || '';
  const sortVal = sort === 'newest' ? 2 : 1;
  const pb = [
    `!1m6!1s${featureId}!6m4!4m1!1e1!4m1!1e3`,
    `!2m2!1i${PAGE_SIZE}!2s${encodeURIComponent(cursor)}`,
    `!5m2!1s!7e81`,
    `!8m9!2b1!3b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1`,
    `!11m4!1e3!2e1!6m1!1i2`,
    `!13m1!1e${sortVal}`,
  ].join('');
  return `https://www.google.com/maps/rpc/listugcposts?authuser=0&hl=${hl}&gl=${gl}&pb=${pb}`;
};

// Review parsing
const findReviewText = (obj: any, depth = 0): string => {
  if (depth > 6) return '';
  if (typeof obj === 'string' && obj.length > 20 && !obj.startsWith('http') && !obj.startsWith('0x')) return obj;
  if (Array.isArray(obj)) {
    let best = '';
    for (const item of obj) {
      const found = findReviewText(item, depth + 1);
      if (found.length > best.length) best = found;
    }
    return best;
  }
  return '';
};

const parseReviewsResponse = (text: string) => {
  try {
    const cleaned = text.replace(/^\)\]\}'/, '');
    const data = JSON.parse(cleaned);
    const arr = data[2];
    if (!arr?.length) return { reviews: [] as any[], nextCursor: null };
    const reviews: any[] = [];
    for (const wrapper of arr) {
      if (!wrapper?.[0]) continue;
      const r = wrapper[0];
      const reviewId = r[0];
      const stars = r[2]?.[0]?.[0];
      const reviewerReviewCount = r[1]?.[4]?.[5]?.[5] || 1;
      const timestamp = r[1]?.[2];
      const reviewText = findReviewText(r);
      if (reviewId && stars) reviews.push({ reviewId, stars, reviewerReviewCount, timestamp, text: reviewText });
    }
    return { reviews, nextCursor: data[1] || null };
  } catch (e) {
    console.error('[Reviews] Parse error:', e);
    return { reviews: [] as any[], nextCursor: null };
  }
};

const classifyTimePeriod = (timestamp: any) => {
  if (!timestamp) return { inPastYear: false, inPastMonth: false };
  const d = new Date(timestamp / 1000);
  const now = new Date();
  const yearAgo = new Date(now); yearAgo.setFullYear(now.getFullYear() - 1);
  const monthAgo = new Date(now); monthAgo.setMonth(now.getMonth() - 1);
  return { inPastYear: d >= yearAgo, inPastMonth: d >= monthAgo };
};

const processReview = (review: any, sortKey: string) => {
  const rd = scores[sortKey].reviewData;
  const isTrusted = review.reviewerReviewCount > 2;
  const periods = classifyTimePeriod(review.timestamp);
  TIME_PERIODS.forEach((period) => {
    if (period === 'total' || (periods as any)[period]) {
      rd.totalReviews[period]++;
      if (isTrusted) {
        rd.trustedReviews[period]++;
        rd.reviewsScores[period] += review.stars === 5 ? 1 : review.stars === 1 ? -1 : 0;
      }
    }
  });
};

// Summarize
const summarizeReviews = async (reviewTexts: string[], filterQuery: string | null, customQuestion: string | null) => {
  const { name, category } = getPlaceInfo();
  const placeLabel = [name, category].filter(Boolean).join(' — ') || 'this place';

  // Static part first (reviews) — benefits from API caching
  const reviewBlock = reviewTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');

  let instructions;
  if (customQuestion) {
    instructions = `You are a local expert helping a tourist decide about ${placeLabel}. Answer their question using only evidence from the reviews above.

Question: ${customQuestion}

For each highlight, quote or paraphrase the most vivid, concrete detail from the reviews — names, numbers, comparisons, warnings, tips. If reviewers disagree, surface the tension. Write the verdict as if advising a friend: direct, opinionated, practical.`;
  } else if (filterQuery) {
    instructions = `You are analyzing what visitors to ${placeLabel} say specifically about "${filterQuery}".

Surface the most concrete, useful details: what exactly people praise, complain about, compare it to, or warn about regarding "${filterQuery}". Quote memorable phrasing when reviewers say it better than you could. If opinions are split, show both sides. The verdict should tell someone whether "${filterQuery}" is a reason to visit or avoid this place.`;
  } else {
    instructions = `You are a brutally honest local expert writing a mini-guide to ${placeLabel} for a tourist deciding whether to visit.

What to extract:
- The specific things that make this place worth visiting (or not) — name exact dishes, exhibits, views, features, staff behaviors, quirks
- Practical intel: timing, crowds, pricing surprises, what to skip, what's overrated vs underrated
- Recurring complaints that would actually affect someone's visit
- Things only regulars or repeat visitors would know

Don't be generic. "Great atmosphere" tells me nothing. "Rooftop terrace gets packed after 8pm but the ground floor bar is underrated" tells me everything.

Be concise. Keep the entire response under 200 words.

For the verdict: write 2-3 sentences as if texting a friend who asked "should I go?" — be direct, opinionated, and include who this place is and isn't for. Rate value for money 1-5.`;
  }

  const prompt = `${reviewBlock}\n\n---\n\n${instructions}`;
  const resp = await fetch(getGeminiEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            highlights: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
              text: { type: 'STRING' }, count: { type: 'INTEGER' }, sentiment: { type: 'STRING' }
            }}},
            verdict: { type: 'STRING' },
            valueForMoney: { type: 'INTEGER' }
          }
        },
        thinkingConfig: { thinkingBudget: 1024 }
      }
    })
  });
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data.error?.message || 'Empty response from Gemini');
  return JSON.parse(text);
};

// Fetch
const fetchAllReviews = async (sortKey: string) => {
  const featureId = getFeatureId();
  if (!featureId || scores[sortKey].isFetching) return;

  const state = scores[sortKey];
  state.isFetching = true;
  state.done = false;
  const controller = new AbortController();
  abortControllers[sortKey] = controller;

  let lastPct: number | null = null;
  try {
    while (state.isFetching) {
      const url = buildUrl(featureId, sortKey, state.cursor);
      const resp = await fetch(url, { signal: controller.signal });
      const { reviews, nextCursor } = parseReviewsResponse(await resp.text());

      if (!reviews.length) break;
      for (const r of reviews) {
        if (!state.reviewMap[r.reviewId]) { state.reviewMap[r.reviewId] = r; processReview(r, sortKey); }
      }
      state.pageCount++;
      updateUI();

      if (state.pageCount >= MIN_PAGES_BEFORE_STABILIZE) {
        const pct = getRoundedPct(sortKey);
        if (lastPct !== null && Math.abs(pct - lastPct) <= 1) break;
        lastPct = pct;
      }
      if (!nextCursor) break;
      state.cursor = nextCursor;
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') console.error(`[Reviews] ${sortKey} error:`, e);
  }
  state.isFetching = false;
  state.done = true;
  abortControllers[sortKey] = null;
  updateUI();
};

const startFetching = () => {
  if (!getFeatureId()) return;
  SORT_KEYS.forEach(fetchAllReviews);
};

// UI
const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const cardEls: any = {};

const createUIElements = () => {
  const c = el('div'); c.id = 'reviews-container';

  // Header
  const header = el('div', 'rc-header');
  const title = el('span', 'rc-title');
  title.appendChild(el('span', 'rc-dot'));
  title.appendChild(document.createTextNode('Review Analysis'));
  header.appendChild(title);
  const headerRight = el('div', 'rc-header-right');
  const select = document.createElement('select'); select.id = 'rc-period';
  ([['total', 'Total'], ['inPastYear', 'Past Year'], ['inPastMonth', 'Past Month']] as const).forEach(([v, t]) => {
    const opt = document.createElement('option'); opt.value = v; opt.textContent = t; select.appendChild(opt);
  });
  select.onchange = (e: any) => { currentOption = e.target.value; updateUI(); };
  headerRight.appendChild(select);
  const collapseBtn = el('button', 'rc-collapse');
  collapseBtn.textContent = '▾';
  collapseBtn.onclick = () => {
    const collapsed = c.classList.toggle('collapsed');
    collapseBtn.textContent = collapsed ? '▸' : '▾';
  };
  headerRight.appendChild(collapseBtn);
  header.appendChild(headerRight);
  c.appendChild(header);

  // Score card
  const card = el('div', 'rc-card');
  const head = el('div', 'rc-card-head');
  head.appendChild(el('span', 'rc-card-label', 'Review Score'));
  const countEl = el('span', 'rc-card-count');
  head.appendChild(countEl);
  card.appendChild(head);
  const pctEl = el('div', 'rc-card-pct', '—');
  card.appendChild(pctEl);
  const tooltip = el('div', 'rc-tooltip');
  pctEl.appendChild(tooltip);
  const bar = el('div', 'rc-card-bar');
  const barFill = el('div', 'rc-card-bar-fill');
  bar.appendChild(barFill);
  card.appendChild(bar);
  const diffEl = el('div', 'rc-card-diff');
  card.appendChild(diffEl);
  const detailEl = el('div', 'rc-card-detail');
  card.appendChild(detailEl);
  c.appendChild(card);
  cardEls.merged = { card, pctEl, barFill, countEl, diffEl, detailEl, tooltip };

  // Summarize row
  const sumRow = el('div', 'rc-sum-row');
  const sumBtn = el('button', 'rc-summarize-btn', 'Summarize');
  sumBtn.onclick = () => triggerSummarize(false);
  sumRow.appendChild(sumBtn);
  const limitToggle = el('div', 'rc-limit-toggle');
  for (const n of [50, 100]) {
    const pill = el('button', `rc-limit-pill${n === reviewLimit ? ' active' : ''}`, String(n));
    pill.onclick = () => {
      reviewLimit = n;
      limitToggle.querySelectorAll('.rc-limit-pill').forEach((p: any) => p.classList.toggle('active', p.textContent === String(n)));
    };
    limitToggle.appendChild(pill);
  }
  sumRow.appendChild(limitToggle);
  c.appendChild(sumRow);
  cardEls.sumBtn = sumBtn;

  // Custom question input
  const questionInput = document.createElement('input');
  questionInput.type = 'text';
  questionInput.placeholder = 'Ask about this place… (Enter to ask)';
  questionInput.className = 'rc-question-input';
  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') triggerSummarize(false);
  });
  questionInput.addEventListener('input', () => {
    sumBtn.textContent = questionInput.value.trim() ? 'Ask' : 'Summarize';
  });
  c.appendChild(questionInput);
  cardEls.questionInput = questionInput;

  // Summary panel
  const sumPanel = el('div', 'rc-summary-panel');
  (sumPanel as HTMLElement).style.display = 'none';
  c.appendChild(sumPanel);
  cardEls.sumPanel = sumPanel;
  if (summaryCache.all) renderSummary(sumPanel as HTMLElement, summaryCache.all);

  // Search filter
  const searchSec = el('div', 'rc-search-section');
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Filter reviews…';
  searchInput.className = 'rc-search-input';
  searchInput.addEventListener('input', updateSearchSection);
  searchSec.appendChild(searchInput);
  cardEls.searchInput = searchInput;
  const searchResults = el('div', 'rc-search-results');
  (searchResults as HTMLElement).style.display = 'none';
  searchSec.appendChild(searchResults);
  const filteredSumPanel = el('div', 'rc-summary-panel');
  (filteredSumPanel as HTMLElement).style.display = 'none';
  searchSec.appendChild(filteredSumPanel);
  c.appendChild(searchSec);
  cardEls.searchResults = searchResults;
  cardEls.filteredSumPanel = filteredSumPanel;

  document.body.appendChild(c);
};

const updateUI = () => {
  const totalCount = SORT_KEYS.reduce((s, k) => s + getReviewCount(k), 0);
  if (!totalCount || !document.querySelector('.F7nice')) return;
  if (!document.querySelector('#reviews-container')) createUIElements();

  const els = cardEls.merged;
  if (!els) return;

  const fullPct = calculateFullPercentage();
  const mergedPct = getMergedScore();
  const mergedRound = Math.round(mergedPct * 100);
  const totalTrusted = SORT_KEYS.reduce((s, k) => s + scores[k].reviewData.trustedReviews[currentOption], 0);
  const totalAll = SORT_KEYS.reduce((s, k) => s + scores[k].reviewData.totalReviews[currentOption], 0);
  const anyFetching = SORT_KEYS.some((k: string) => scores[k].isFetching);
  const allDone = SORT_KEYS.every((k: string) => scores[k].done);

  els.pctEl.childNodes[0].textContent = `${mergedRound}%`;
  els.tooltip.textContent = `Relevant: ${getRoundedPct('relevant')}% · Newest: ${getRoundedPct('newest')}%`;

  if (fullPct !== null) {
    const diff = mergedRound - fullPct;
    const diffNorm = Math.max(0, Math.min(1, (diff + 10) / 20));
    const color = getScoreColor(diffNorm);
    els.pctEl.style.color = color;
    els.pctEl.style.textShadow = `0 0 24px ${color}40`;
    const sign = diff > 0 ? '+' : '';
    els.diffEl.textContent = `${sign}${diff}% vs overall`;
    els.diffEl.style.color = color;
    els.diffEl.style.display = '';
  } else {
    const color = getScoreColor(Math.max(0, mergedPct));
    els.pctEl.style.color = color;
    els.pctEl.style.textShadow = `0 0 24px ${color}40`;
    els.diffEl.style.display = 'none';
    // Watch for star distribution rows to appear
    if (!fullPctObserver) {
      fullPctObserver = new MutationObserver(() => {
        if (calculateFullPercentage() !== null) {
          fullPctObserver!.disconnect();
          fullPctObserver = null;
          updateUI();
        }
      });
      fullPctObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  els.barFill.style.width = `${Math.max(2, Math.min(100, (mergedPct + 1) / 2 * 100))}%`;
  els.countEl.textContent = totalCount;
  els.detailEl.textContent = totalAll > 0 ? `${totalTrusted} trusted of ${totalAll}` : '';
  els.card.classList.toggle('loading', anyFetching);
  els.card.classList.toggle('done', allDone);
};

// Render summary
const renderSummary = (panel: HTMLElement, result: any) => {
  panel.textContent = '';
  panel.className = 'rc-summary-panel';
  panel.style.display = 'block';
  if (result.highlights?.length) {
    for (const h of result.highlights) {
      const row = el('div', `rc-highlight ${h.sentiment}`);
      const badge = el('span', 'rc-h-count', `${h.count}x`);
      row.appendChild(badge);
      row.appendChild(document.createTextNode(` ${h.text}`));
      panel.appendChild(row);
    }
  }
  if (result.valueForMoney) {
    const v = Math.max(1, Math.min(5, result.valueForMoney));
    panel.appendChild(el('div', 'rc-value', `Value for money: ${'★'.repeat(v)}${'☆'.repeat(5 - v)}`));
  }
  if (result.verdict) {
    panel.appendChild(el('div', 'rc-verdict', result.verdict));
  }
  if (!result.highlights?.length && !result.verdict) {
    panel.textContent = 'No highlights found';
  }
};

const triggerSummarize = async (filtered: boolean) => {
  const panel = filtered ? cardEls.filteredSumPanel : cardEls.sumPanel;
  if (!panel) return;
  panel.style.display = 'block';
  panel.textContent = 'Summarizing…';
  panel.className = 'rc-summary-panel loading';

  const combined = { ...scores.relevant.reviewMap, ...scores.newest.reviewMap };
  let reviews = Object.values(combined).filter((r: any) => r.text);

  const query = filtered ? cardEls.searchInput?.value?.trim() : null;
  if (query) reviews = reviews.filter((r: any) => r.text.toLowerCase().includes(query.toLowerCase()));

  const texts = [...new Set(reviews.map((r: any) => r.text))].sort((a: any, b: any) => b.length - a.length).slice(0, reviewLimit);
  if (!texts.length) { panel.textContent = 'No review text available'; panel.className = 'rc-summary-panel'; return; }

  const customQuestion = !filtered ? cardEls.questionInput?.value?.trim() : null;
  try {
    const result = await summarizeReviews(texts, query, customQuestion);
    if (!customQuestion) {
      summaryCache[filtered ? 'filtered' : 'all'] = result;
      saveSummaryCache();
    }
    renderSummary(panel, result);
  } catch (e) {
    console.error('[Reviews] Summarize error:', e);
    panel.textContent = 'Summarization failed';
    panel.className = 'rc-summary-panel';
  }
};

// Search filter
const updateSearchSection = () => {
  const res = cardEls.searchResults;
  if (!res) return;
  const query = cardEls.searchInput?.value?.trim();
  if (!query) { res.style.display = 'none'; if (cardEls.filteredSumPanel) cardEls.filteredSumPanel.style.display = 'none'; return; }

  const combined = { ...scores.relevant.reviewMap, ...scores.newest.reviewMap };
  const allReviews: any[] = Object.values(combined);
  const filtered = allReviews.filter((r: any) => r.text && r.text.toLowerCase().includes(query.toLowerCase()));

  if (!filtered.length) {
    res.style.display = 'block';
    res.textContent = `No reviews mention "${query}" (in ${allReviews.length} sampled)`;
    return;
  }

  const trusted = filtered.filter((r: any) => r.reviewerReviewCount > 2);
  const score = trusted.reduce((s: number, r: any) => s + (r.stars === 5 ? 1 : r.stars === 1 ? -1 : 0), 0);
  const pct = trusted.length ? Math.round((score / trusted.length) * 100) : 0;
  const color = getScoreColor(Math.max(0, score / (trusted.length || 1)));

  res.style.display = 'block';
  res.textContent = '';
  const header = el('div', 'rc-search-header');
  const scoreEl = el('span', 'rc-search-score', `${pct}%`);
  scoreEl.style.color = color;
  header.appendChild(scoreEl);
  header.appendChild(el('span', 'rc-search-count', `${filtered.length} of ${allReviews.length} mention "${query}"`));
  res.appendChild(header);

  const sumBtn = el('button', 'rc-summarize-btn', `Summarize "${query}"`);
  sumBtn.onclick = () => triggerSummarize(true);
  res.appendChild(sumBtn);
};

// Page observer — merges both extensions' observers
const observer = new MutationObserver(() => {
  const url = location.href;

  // Simple score display (from Show-GMaps-score)
  const placeDetails = document.querySelector('.dmRWX') as HTMLElement;
  if (placeDetails && !placeDetails.innerHTML.includes('score:')) {
    injectSimpleScore(placeDetails);
  }

  if (url === lastUrl) return;
  lastUrl = url;

  const isPlace = /\/place\//.test(url);
  if (!isPlace) { document.querySelector('#reviews-container')?.remove(); return; }

  const placeName = url.match(/(?:place\/)([^\/]+)/)?.[1];
  if (placeName !== lastPlaceName) {
    lastPlaceName = placeName || '';
    resetScores();
    loadSummaryCache();
    document.querySelector('#reviews-container')?.remove();
    startFetching();
  }
  if (!document.querySelector('#reviews-container') && getFeatureId()) {
    updateUI();
    if (!scores.relevant.isFetching && !scores.relevant.done) startFetching();
  }
});

observer.observe(document.body, { childList: true, subtree: true });
