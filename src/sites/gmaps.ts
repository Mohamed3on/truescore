import { GEMINI_API_KEY, geminiEndpoint } from '../shared/config';
import { addCommas, el, renderMarkdown, renderMarkdownInline } from '../shared/utils';

const TIME_PERIODS = ['total', 'inPastYear', 'inPastMonth'] as const;
const SORT_KEYS = ['relevant', 'newest'] as const;
const PAGE_SIZE = 20;
const MIN_PAGES_BEFORE_STABILIZE = 2;
const TRUSTED_MIN_REVIEWS = 3;

type Period = (typeof TIME_PERIODS)[number];
type SortKey = (typeof SORT_KEYS)[number];
type ReviewData = {
  reviewsScores: Record<Period, number>;
  trustedReviews: Record<Period, number>;
  totalReviews: Record<Period, number>;
};
type Review = { reviewId: string; stars: number; reviewerReviewCount: number; timestamp: number | null; text: string };
type SortState = { reviewMap: Record<string, Review>; reviewData: ReviewData; isFetching: boolean; done: boolean; cursor: string; pageCount: number };
type SummaryResult = { highlights?: { text: string; count: number; sentiment: string }[]; verdict?: string; valueForMoney?: number };
type MergedEls = { card: HTMLElement; pctEl: HTMLElement; barFill: HTMLElement; countEl: HTMLElement; diffEl: HTMLElement; detailEl: HTMLElement; tooltip: HTMLElement };
type VisibleEls = { row: HTMLElement; pctEl: HTMLElement; detailEl: HTMLElement };
type CardEls = {
  merged?: MergedEls;
  visible?: VisibleEls;
  sumBtn?: HTMLButtonElement;
  questionInput?: HTMLInputElement;
  sumPanel?: HTMLElement;
  searchInput?: HTMLInputElement;
  searchResults?: HTMLElement;
  filteredSumPanel?: HTMLElement;
};

const getGeminiKey = () => document.documentElement.dataset.tsGeminiKey || GEMINI_API_KEY;
const getGeminiEndpoint = () => geminiEndpoint(getGeminiKey());

let currentOption: Period = 'total';
let lastFeatureId = '';
let lastUrl = '';
let reviewLimit = 100;
let fullPctObserver: MutationObserver | null = null;
let lastVisibleKey = '';
let fullPctCache: number | null = null;

const abortControllers: Record<SortKey, AbortController | null> = { relevant: null, newest: null };
let summaryCache: { all: SummaryResult | null; filtered: SummaryResult | null } = { all: null, filtered: null };

const getSummaryCacheKey = () => `rc_summary_${lastFeatureId || 'default'}`;
const loadSummaryCache = () => {
  try { summaryCache = JSON.parse(localStorage.getItem(getSummaryCacheKey()) as string) || { all: null, filtered: null }; }
  catch { summaryCache = { all: null, filtered: null }; }
};
const saveSummaryCache = () => { try { localStorage.setItem(getSummaryCacheKey(), JSON.stringify(summaryCache)); } catch {} };

const makeReviewData = (): ReviewData => ({
  reviewsScores: { total: 0, inPastYear: 0, inPastMonth: 0 },
  trustedReviews: { total: 0, inPastYear: 0, inPastMonth: 0 },
  totalReviews: { total: 0, inPastYear: 0, inPastMonth: 0 },
});

const makeState = (): SortState => ({ reviewMap: {}, reviewData: makeReviewData(), isFetching: false, done: false, cursor: '', pageCount: 0 });
const scores: Record<SortKey, SortState> = { relevant: makeState(), newest: makeState() };

const isTrusted = (reviewerReviewCount: number) => reviewerReviewCount >= TRUSTED_MIN_REVIEWS;
const starScore = (stars: number) => stars === 5 ? 1 : stars === 1 ? -1 : 0;
const toPct = (ratio: number) => Math.round(ratio * 100);
const getScorePercentage = (sortKey: SortKey) => {
  const { reviewsScores, trustedReviews } = scores[sortKey].reviewData;
  return reviewsScores[currentOption] / trustedReviews[currentOption] || 0;
};
const getRoundedPct = (sortKey: SortKey) => toPct(getScorePercentage(sortKey));

const getMergedStats = () => {
  const merged: Record<string, Review> = {};
  for (const key of SORT_KEYS) {
    for (const id in scores[key].reviewMap) {
      if (!merged[id]) merged[id] = scores[key].reviewMap[id];
    }
  }
  let totalAll = 0, totalTrusted = 0, totalScore = 0;
  for (const id in merged) {
    const r = merged[id];
    if (!classifyTimePeriod(r.timestamp)[currentOption]) continue;
    totalAll++;
    if (isTrusted(r.reviewerReviewCount)) {
      totalTrusted++;
      totalScore += starScore(r.stars);
    }
  }
  return {
    totalCount: Object.keys(merged).length,
    totalAll,
    totalTrusted,
    mergedPct: totalTrusted ? totalScore / totalTrusted : 0,
  };
};

const resetScores = () => {
  for (const key of SORT_KEYS) {
    scores[key] = makeState();
    if (abortControllers[key]) { abortControllers[key]!.abort(); abortControllers[key] = null; }
  }
  if (fullPctObserver) { fullPctObserver.disconnect(); fullPctObserver = null; }
  lastVisibleKey = '';
  fullPctCache = null;
  stopAutoScroll();
};

let autoScroll: { active: boolean; abort: AbortController | null } = { active: false, abort: null };

const findReviewsScrollContainer = (): HTMLElement | null => {
  const first = document.querySelector<HTMLElement>('.jftiEf[data-review-id]');
  if (!first) return null;
  let el: HTMLElement | null = first.parentElement;
  while (el) {
    const style = getComputedStyle(el);
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
};

const stopAutoScroll = () => {
  if (!autoScroll.active) return;
  autoScroll.active = false;
  autoScroll.abort?.abort();
  autoScroll.abort = null;
};

const startAutoScroll = async () => {
  const container = findReviewsScrollContainer();
  if (!container) return;
  const ctrl = new AbortController();
  autoScroll = { active: true, abort: ctrl };
  container.addEventListener('wheel', (e) => { if ((e as WheelEvent).deltaY < 0) stopAutoScroll(); }, { signal: ctrl.signal });

  let stagnant = 0;
  while (autoScroll.active) {
    const beforeCount = container.querySelectorAll('.jftiEf[data-review-id]').length;
    const beforeHeight = container.scrollHeight;
    container.scrollTo({ top: container.scrollHeight });
    await new Promise((r) => setTimeout(r, 350));
    if (!autoScroll.active) return;
    const afterCount = container.querySelectorAll('.jftiEf[data-review-id]').length;
    if (afterCount === beforeCount && container.scrollHeight === beforeHeight) {
      if (++stagnant >= 2) break;
    } else stagnant = 0;
  }
  stopAutoScroll();
};

const isTypingTarget = (el: EventTarget | null) => {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
};

if (!(window as any).__rcGmapsKeybound) {
  (window as any).__rcGmapsKeybound = true;
  document.addEventListener('keydown', (e) => {
    if (e.repeat || isTypingTarget(e.target)) return;
    if (e.key === 'Escape' && autoScroll.active) { stopAutoScroll(); return; }
    if (e.key !== 'Alt' || e.ctrlKey || e.metaKey) return;
    const container = findReviewsScrollContainer();
    if (!container) return;
    e.preventDefault();
    if (e.shiftKey) {
      stopAutoScroll();
      container.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (autoScroll.active) stopAutoScroll();
    else startAutoScroll();
  });
}

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
  if (fullPctCache !== null) return fullPctCache;
  const reviewRows = document.querySelectorAll('tr[role="img"]');
  if (reviewRows.length < 5) return null;
  const extractNumber = (str: string) => {
    const match = str.match(/(\d+(?:[.,]\d+)*)\s*(?:reviews?|$)/);
    return match ? parseInt(match[1].replace(/[.,]/g, ''), 10) : 0;
  };
  const counts: number[] = [];
  for (const r of reviewRows) counts.push(extractNumber(r.getAttribute('aria-label') || ''));
  const allReviews = counts.reduce((a, b) => a + b, 0);
  if (!allReviews) return null;
  fullPctCache = toPct((counts[0] - counts[4]) / allReviews);
  return fullPctCache;
};

const visibleReviewStats = new WeakMap<Element, { stars: number; count: number }>();
const readVisibleStats = (el: Element) => {
  const cached = visibleReviewStats.get(el);
  if (cached) return cached;
  const starLabel = el.querySelector('span[role="img"][aria-label*="star"]')?.getAttribute('aria-label') || '';
  const stars = parseInt(starLabel.match(/(\d+)\s*star/)?.[1] || '0', 10);
  const reviewerText = el.querySelector('.RfnDt')?.textContent?.replace(/,/g, '') || '';
  const count = parseInt(reviewerText.match(/(\d+)\s*review/)?.[1] || '1', 10);
  const stats = { stars, count };
  if (stars) visibleReviewStats.set(el, stats);
  return stats;
};

const getVisibleScore = () => {
  const reviewEls = document.querySelectorAll('.jftiEf[data-review-id]');
  if (!reviewEls.length) return null;
  let total = 0, trusted = 0, score = 0;
  for (const el of reviewEls) {
    const { stars, count } = readVisibleStats(el);
    if (!stars) continue;
    total++;
    if (isTrusted(count)) {
      trusted++;
      score += starScore(stars);
    }
  }
  return { total, trusted, pct: trusted ? toPct(score / trusted) : 0, raw: trusted ? score / trusted : 0 };
};

const getPlaceInfo = () => {
  const name = document.querySelector('h1.DUwDvf')?.textContent?.trim() || '';
  const category = (document.querySelector('button.DkEaL') as HTMLElement)?.textContent?.trim() || '';
  return { name, category };
};

const injectSimpleScore = (placeDetailsElement: HTMLElement) => {
  const rows = document.querySelectorAll('tr[role="img"]');
  const fiveStars = rows[0]?.ariaLabel?.match(/(?<=stars,\s)(\d*),*(\d*)/g)?.[0];
  const oneStars = rows[4]?.ariaLabel?.match(/(?<=stars,\s)(\d*),*(\d*)/g)?.[0];
  if (!fiveStars || !oneStars) return;

  const score = Number(fiveStars.split(',').join('')) - Number(oneStars.split(',').join(''));
  const allReviewsText = (document.querySelector('[jsaction="pane.reviewChart.moreReviews"] button') as HTMLElement)?.innerText;
  const allReviewsAsNumber = Number(allReviewsText?.match(/\d+/g)?.join('') || 0);
  const ratio = allReviewsAsNumber ? score / allReviewsAsNumber : 0;
  const calculatedScore = Math.round(score * ratio);
  const scorePercentage = toPct(ratio);

  const newElement = document.createElement('div');
  newElement.className = 'truescore-simple-score';
  newElement.innerHTML = `score: ${addCommas(calculatedScore)} &mdash; ${scorePercentage}%`;
  placeDetailsElement.appendChild(newElement);
};

const getFeatureId = () => {
  const matches = [...location.href.matchAll(/!3m\d+!1s(0x[a-f0-9]+(?:%3A|:)0x[a-f0-9]+)/gi)];
  return matches.length ? decodeURIComponent(matches[matches.length - 1][1]) : null;
};

const buildUrl = (featureId: string, sort: SortKey, cursor = '') => {
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

const parseReviewsResponse = (text: string): { reviews: Review[]; nextCursor: string | null } => {
  try {
    const cleaned = text.replace(/^\)\]\}'/, '');
    const data = JSON.parse(cleaned);
    const arr = data[2];
    if (!arr?.length) return { reviews: [], nextCursor: null };
    const reviews: Review[] = [];
    for (const wrapper of arr) {
      if (!wrapper?.[0]) continue;
      const r = wrapper[0];
      const reviewId = r[0];
      const stars = r[2]?.[0]?.[0];
      const reviewerReviewCount = r[1]?.[4]?.[5]?.[5] || 1;
      const timestamp = r[1]?.[2] ?? null;
      const reviewText = findReviewText(r);
      if (reviewId && stars) reviews.push({ reviewId, stars, reviewerReviewCount, timestamp, text: reviewText });
    }
    return { reviews, nextCursor: data[1] || null };
  } catch (e) {
    console.error('[Reviews] Parse error:', e);
    return { reviews: [], nextCursor: null };
  }
};

const classifyTimePeriod = (timestamp: number | null): Record<Period, boolean> => {
  if (!timestamp) return { total: true, inPastYear: false, inPastMonth: false };
  const t = timestamp / 1000;
  const now = Date.now();
  return { total: true, inPastYear: t >= now - 365 * 86400000, inPastMonth: t >= now - 30 * 86400000 };
};

const processReview = (review: Review, sortKey: SortKey) => {
  const rd = scores[sortKey].reviewData;
  const trusted = isTrusted(review.reviewerReviewCount);
  const periods = classifyTimePeriod(review.timestamp);
  const contribution = starScore(review.stars);
  for (const period of TIME_PERIODS) {
    if (!periods[period]) continue;
    rd.totalReviews[period]++;
    if (trusted) {
      rd.trustedReviews[period]++;
      rd.reviewsScores[period] += contribution;
    }
  }
};

const summarizeReviews = async (reviewTexts: string[], filterQuery: string | null, customQuestion: string | null): Promise<SummaryResult | string> => {
  const { name, category } = getPlaceInfo();
  const placeLabel = [name, category].filter(Boolean).join(' — ') || 'this place';

  const reviewBlock = reviewTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');

  const isFreeForm = !!customQuestion;
  let instructions;
  if (customQuestion) {
    instructions = `You are a local expert helping a tourist decide about ${placeLabel}. Answer their question using only evidence from the reviews above.

Question: ${customQuestion}

Quote or paraphrase the most vivid, concrete detail from the reviews — names, numbers, comparisons, warnings, tips. If reviewers disagree, surface the tension. Be direct, opinionated, practical. Keep it concise.`;
  } else if (filterQuery) {
    instructions = `You are analyzing what visitors to ${placeLabel} say specifically about "${filterQuery}".

Surface the most concrete, useful details: what exactly people praise, complain about, compare it to, or warn about regarding "${filterQuery}". Quote memorable phrasing when reviewers say it better than you could. If opinions are split, show both sides. The verdict should tell someone whether "${filterQuery}" is a reason to visit or avoid this place.`;
  } else {
    instructions = `You are a brutally honest local expert writing a mini-guide to ${placeLabel} for a tourist deciding whether to visit.

What to extract:
- The specific things that make this place worth visiting (or not) — name exact dishes, exhibits, views, features, staff behaviors, quirks
- Standout menu items: which specific dishes/drinks do reviewers rave about or warn against by name? (If this is a restaurant, café, bar, or anywhere with a menu, this is required.)
- Practical intel: timing, crowds, pricing surprises, what to skip, what's overrated vs underrated
- Recurring complaints that would actually affect someone's visit
- Things only regulars or repeat visitors would know

Don't be generic. "Great atmosphere" tells me nothing. "Rooftop terrace gets packed after 8pm but the ground floor bar is underrated" tells me everything.

Be concise. Keep the entire response under 200 words.

For the verdict: write 2-3 sentences as if texting a friend who asked "should I go?" — be direct, opinionated, and include who this place is and isn't for. Rate value for money 1-5.`;
  }

  const prompt = `${reviewBlock}\n\n---\n\n${instructions}`;
  const generationConfig: any = {
    maxOutputTokens: 16384,
    thinkingConfig: { thinkingLevel: 'medium' },
  };
  if (!isFreeForm) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = {
      type: 'OBJECT',
      properties: {
        highlights: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
          text: { type: 'STRING' }, count: { type: 'INTEGER' }, sentiment: { type: 'STRING' }
        }}},
        verdict: { type: 'STRING' },
        valueForMoney: { type: 'INTEGER' }
      }
    };
  }
  const resp = await fetch(getGeminiEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    })
  });
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data.error?.message || 'Empty response from Gemini');
  return isFreeForm ? text : JSON.parse(text);
};

const fetchAllReviews = async (sortKey: SortKey) => {
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
  for (const key of SORT_KEYS) fetchAllReviews(key);
};

const cardEls: CardEls = {};
const clearCardEls = () => { for (const k of Object.keys(cardEls) as (keyof CardEls)[]) delete cardEls[k]; };

const createUIElements = () => {
  const c = el('div'); c.id = 'reviews-container';

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
  select.onchange = (e) => { currentOption = (e.target as HTMLSelectElement).value as Period; updateUI(); };
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

  const visRow = el('div', 'rc-visible');
  const visLabel = el('span', 'rc-visible-label', 'Visible');
  const visPctEl = el('span', 'rc-visible-pct', '—');
  const visDetailEl = el('span', 'rc-visible-detail', '');
  visRow.appendChild(visLabel);
  visRow.appendChild(visPctEl);
  visRow.appendChild(visDetailEl);
  visRow.style.display = 'none';
  c.appendChild(visRow);
  cardEls.visible = { row: visRow, pctEl: visPctEl, detailEl: visDetailEl };

  const sumRow = el('div', 'rc-sum-row');
  const sumBtn = el('button', 'rc-summarize-btn', 'Summarize') as HTMLButtonElement;
  sumBtn.onclick = () => triggerSummarize(false);
  sumRow.appendChild(sumBtn);
  const limitToggle = el('div', 'rc-limit-toggle');
  for (const n of [50, 100]) {
    const pill = el('button', `rc-limit-pill${n === reviewLimit ? ' active' : ''}`, String(n));
    pill.dataset.limit = String(n);
    pill.onclick = () => {
      reviewLimit = n;
      limitToggle.querySelectorAll<HTMLElement>('.rc-limit-pill').forEach((p) => p.classList.toggle('active', Number(p.dataset.limit) === n));
    };
    limitToggle.appendChild(pill);
  }
  sumRow.appendChild(limitToggle);
  c.appendChild(sumRow);
  cardEls.sumBtn = sumBtn;

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

  const sumPanel = el('div', 'rc-summary-panel');
  sumPanel.style.display = 'none';
  c.appendChild(sumPanel);
  cardEls.sumPanel = sumPanel;
  if (summaryCache.all) renderSummary(sumPanel, summaryCache.all);

  const searchSec = el('div', 'rc-search-section');
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Filter reviews…';
  searchInput.className = 'rc-search-input';
  searchInput.addEventListener('input', updateSearchSection);
  searchSec.appendChild(searchInput);
  cardEls.searchInput = searchInput;
  const searchResults = el('div', 'rc-search-results');
  searchResults.style.display = 'none';
  searchSec.appendChild(searchResults);
  const filteredSumPanel = el('div', 'rc-summary-panel');
  filteredSumPanel.style.display = 'none';
  searchSec.appendChild(filteredSumPanel);
  c.appendChild(searchSec);
  cardEls.searchResults = searchResults;
  cardEls.filteredSumPanel = filteredSumPanel;

  document.body.appendChild(c);
};

const updateUI = () => {
  const { totalCount, totalAll, totalTrusted, mergedPct } = getMergedStats();
  let anyFetching = false, allDone = true;
  for (const k of SORT_KEYS) {
    if (scores[k].isFetching) anyFetching = true;
    if (!scores[k].done) allDone = false;
  }
  if (!totalCount || !document.querySelector('.F7nice')) return;
  if (!document.querySelector('#reviews-container')) createUIElements();

  const els = cardEls.merged;
  if (!els) return;

  const fullPct = calculateFullPercentage();
  const noData = totalAll === 0 && currentOption !== 'total';

  if (noData) {
    els.pctEl.childNodes[0].textContent = '—';
    els.pctEl.style.color = '#888';
    els.pctEl.style.textShadow = 'none';
    els.tooltip.textContent = 'No reviews in this period';
    els.barFill.style.width = '0%';
    els.diffEl.style.display = 'none';
  } else {
    const mergedRound = toPct(mergedPct);
    els.pctEl.childNodes[0].textContent = `${mergedRound}%`;
    const relLabel = scores.relevant.reviewData.totalReviews[currentOption] ? `${getRoundedPct('relevant')}%` : '—';
    const newLabel = scores.newest.reviewData.totalReviews[currentOption] ? `${getRoundedPct('newest')}%` : '—';
    els.tooltip.textContent = `Relevant: ${relLabel} · Newest: ${newLabel}`;

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
      if (!fullPctObserver) {
        fullPctObserver = new MutationObserver(() => {
          fullPctCache = null;
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
  }

  els.countEl.textContent = String(totalCount);
  els.detailEl.textContent = totalAll > 0 ? `${totalTrusted} trusted of ${totalAll}` : '';
  els.card.classList.toggle('loading', anyFetching);
  els.card.classList.toggle('done', allDone);

  updateVisibleScore();
};

const updateVisibleScore = () => {
  const v = cardEls.visible;
  if (!v) return;
  const s = getVisibleScore();
  const key = s && s.total ? `${s.total}|${s.trusted}|${s.pct}` : '';
  if (key === lastVisibleKey) return;
  lastVisibleKey = key;
  if (!key || !s) { v.row.style.display = 'none'; return; }
  v.row.style.display = '';
  if (s.trusted) {
    v.pctEl.textContent = `${s.pct}%`;
    v.pctEl.style.color = getScoreColor(Math.max(0, s.raw));
  } else {
    v.pctEl.textContent = '—';
    v.pctEl.style.color = '#888';
  }
  v.detailEl.textContent = `${s.trusted} trusted of ${s.total}`;
};

const renderSummary = (panel: HTMLElement, result: SummaryResult | string) => {
  panel.textContent = '';
  panel.className = 'rc-summary-panel';
  panel.style.display = 'block';
  if (typeof result === 'string') {
    const answer = el('div', 'rc-answer');
    renderMarkdown(answer, result);
    panel.appendChild(answer);
    return;
  }
  if (result.highlights?.length) {
    for (const h of result.highlights) {
      const row = el('div', `rc-highlight ${h.sentiment}`);
      const badge = el('span', 'rc-h-count', `${h.count}x`);
      row.appendChild(badge);
      const text = el('span', 'rc-h-text');
      renderMarkdownInline(text, ` ${h.text}`);
      row.appendChild(text);
      panel.appendChild(row);
    }
  }
  if (result.valueForMoney) {
    const v = Math.max(1, Math.min(5, result.valueForMoney));
    panel.appendChild(el('div', 'rc-value', `Value for money: ${'★'.repeat(v)}${'☆'.repeat(5 - v)}`));
  }
  if (result.verdict) {
    const verdict = el('div', 'rc-verdict');
    renderMarkdown(verdict, result.verdict);
    panel.appendChild(verdict);
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

  const query = filtered ? cardEls.searchInput?.value?.trim() || null : null;
  const queryLower = query?.toLowerCase() || null;
  const pickTexts = (map: Record<string, Review>, limit: number) => {
    const revs: Review[] = [];
    for (const id in map) {
      const r = map[id];
      if (!r.text) continue;
      if (queryLower && !r.text.toLowerCase().includes(queryLower)) continue;
      revs.push(r);
    }
    revs.sort((a, b) => b.text.length - a.text.length);
    return revs.slice(0, limit).map((r) => r.text);
  };
  const half = Math.ceil(reviewLimit / 2);
  const texts = [...new Set([...pickTexts(scores.relevant.reviewMap, half), ...pickTexts(scores.newest.reviewMap, half)])].slice(0, reviewLimit);
  if (!texts.length) { panel.textContent = 'No review text available'; panel.className = 'rc-summary-panel'; return; }

  const customQuestion = !filtered ? cardEls.questionInput?.value?.trim() || null : null;
  try {
    const result = await summarizeReviews(texts, query, customQuestion);
    if (!customQuestion && typeof result !== 'string') {
      if (filtered) summaryCache.filtered = result;
      else summaryCache.all = result;
      saveSummaryCache();
    }
    renderSummary(panel, result);
  } catch (e) {
    console.error('[Reviews] Summarize error:', e);
    panel.textContent = 'Summarization failed';
    panel.className = 'rc-summary-panel';
  }
};

const updateSearchSection = () => {
  const res = cardEls.searchResults;
  if (!res) return;
  const query = cardEls.searchInput?.value?.trim();
  if (!query) { res.style.display = 'none'; if (cardEls.filteredSumPanel) cardEls.filteredSumPanel.style.display = 'none'; return; }

  const queryLower = query.toLowerCase();
  const seen = new Set<string>();
  let allCount = 0;
  const filtered: Review[] = [];
  for (const map of [scores.relevant.reviewMap, scores.newest.reviewMap]) {
    for (const id in map) {
      if (seen.has(id)) continue;
      seen.add(id);
      allCount++;
      const r = map[id];
      if (r.text && r.text.toLowerCase().includes(queryLower)) filtered.push(r);
    }
  }

  if (!filtered.length) {
    res.style.display = 'block';
    res.textContent = `No reviews mention "${query}" (in ${allCount} sampled)`;
    return;
  }

  const trusted = filtered.filter((r) => isTrusted(r.reviewerReviewCount));
  const score = trusted.reduce((s, r) => s + starScore(r.stars), 0);
  const pct = trusted.length ? toPct(score / trusted.length) : 0;
  const color = getScoreColor(Math.max(0, score / (trusted.length || 1)));

  res.style.display = 'block';
  res.textContent = '';
  const header = el('div', 'rc-search-header');
  const scoreEl = el('span', 'rc-search-score', `${pct}%`);
  scoreEl.style.color = color;
  header.appendChild(scoreEl);
  header.appendChild(el('span', 'rc-search-count', `${filtered.length} of ${allCount} mention "${query}"`));
  res.appendChild(header);

  const sumBtn = el('button', 'rc-summarize-btn', `Summarize "${query}"`);
  sumBtn.onclick = () => triggerSummarize(true);
  res.appendChild(sumBtn);
};

const observer = new MutationObserver((mutations) => {
  const url = location.href;

  const placeDetails = document.querySelector<HTMLElement>('.dmRWX');
  if (placeDetails && !placeDetails.querySelector('.truescore-simple-score')) {
    injectSimpleScore(placeDetails);
  }

  let reviewsChanged = false;
  outer: for (const m of mutations) {
    for (const nodes of [m.addedNodes, m.removedNodes]) {
      for (const n of nodes) {
        if (n instanceof Element && (n.classList.contains('jftiEf') || n.querySelector('.jftiEf'))) {
          reviewsChanged = true;
          break outer;
        }
      }
    }
  }
  if (reviewsChanged) updateVisibleScore();

  if (url === lastUrl) return;
  lastUrl = url;

  const featureId = getFeatureId();
  if (!featureId) {
    document.querySelector('#reviews-container')?.remove();
    clearCardEls();
    return;
  }

  if (featureId !== lastFeatureId) {
    lastFeatureId = featureId;
    resetScores();
    loadSummaryCache();
    document.querySelector('#reviews-container')?.remove();
    clearCardEls();
    startFetching();
  }
  if (!document.querySelector('#reviews-container')) {
    updateUI();
    if (!scores.relevant.isFetching && !scores.relevant.done) startFetching();
  }
});

observer.observe(document.body, { childList: true, subtree: true });
