import { addCommas, el, npsColor, npsStats } from '../shared/utils';
import { cacheGet, cacheSet, NEG_TTL } from '../shared/cache';
import { idbGet, idbSet } from '../shared/idb-cache';
import { buildSummarizeWidget, keywordSummaryPrompt, PRODUCT_SUMMARY_PROMPT, SAMPLE_MAX, summarizeMatches } from '../shared/review-summary';
import { buildSearchSection, localSearchAsk, SEARCH_MAX } from '../shared/review-search';
import { setupSpaInjector } from '../shared/spa-injector';
import { appendStat, buildRecentGauge, createIslandShell, fillRecentGauge } from '../shared/score-island';
import { adjust, RECENT_REVIEWS, recentRatio } from '../shared/recency';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const REVIEWS_TTL = 7 * 24 * 60 * 60 * 1000;
const CLIENT_ID = 'a1047798-0fc4-446e-9616-0afe3256d0d7';

const getLocale = () => {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { country: parts[0], lang: parts[1] };
};

const extractItemNo = () => {
  const match = location.pathname.match(/(\d{7,})\/?$/);
  return match ? match[1] : null;
};

const fetchRating = async (country: string, lang: string, itemNo: string) => {
  const cacheKey = `nps_ikea_${itemNo}`;
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;
  const res = await fetch(
    `https://web-api.ikea.com/tugc/public/v5/rating/${country}/${lang}/${itemNo}`,
    { headers: { 'x-client-id': CLIENT_ID } }
  );
  if (!res.ok) return null;
  const json = await res.json();
  const data = json?.[0] ?? null;
  if (data) cacheSet(cacheKey, data);
  return data;
};

const getScore = (data: any) => {
  const dist = data?.ratingDistribution;
  if (!dist?.length) return null;
  let total = 0, five = 0, one = 0;
  for (const { ratingType, ratingCount } of dist) {
    total += ratingCount;
    if (ratingType === 5) five = ratingCount;
    if (ratingType === 1) one = ratingCount;
  }
  if (total === 0) return null;
  return npsStats(five, one, total);
};

const appendScore = (ratingBtn: Element, { score, nps }: { score: number; nps: number }) => {
  if (ratingBtn.querySelector('.nps-score-badge')) return;
  const badge = document.createElement('span');
  // The pdp marker keeps cleanup() off the PLP grid script's badges, which
  // share .nps-score-badge on this same page (listing carousels).
  badge.className = 'nps-score-badge nps-pdp-badge';
  badge.style.cssText = `color:${npsColor(nps)};font-weight:600;font-size:14px;margin-left:8px;white-space:nowrap;`;
  badge.textContent = `${addCommas(String(score))} (${Math.round(nps)}%)`;
  ratingBtn.appendChild(badge);
};

const buildInsightsPanel = (data: any) => {
  const { secondaryRatings, totalRecommendedCount, totalNotRecommendedCount } = data;

  let html = '';

  const recTotal = totalRecommendedCount + totalNotRecommendedCount;
  if (recTotal > 0) {
    const recPct = Math.round((totalRecommendedCount / recTotal) * 100);
    html += `<div style="margin-bottom:12px;display:flex;align-items:center;gap:6px;font-size:13px">
      <strong>${recPct}%</strong> recommend this
      <span style="color:#888;font-size:11px">(${totalRecommendedCount}/${recTotal})</span>
    </div>`;
  }

  if (secondaryRatings?.length) {
    const filtered = secondaryRatings.filter((a: any) => a.ratingValue > 0).sort((a: any, b: any) => b.ratingValue - a.ratingValue);
    for (const attr of filtered) {
      const pct = (attr.ratingValue / attr.ratingRange) * 100;
      const hue = Math.min(120, Math.max(0, (pct - 50) * 3));
      html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
        <span style="width:170px;flex-shrink:0;font-size:12px;overflow-wrap:break-word">${attr.label}</span>
        <div style="flex:1;height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:hsl(${hue},70%,40%);border-radius:3px"></div>
        </div>
        <span style="width:26px;text-align:right;font-size:12px;font-weight:600">${attr.ratingValue.toFixed(1)}</span>
      </div>`;
    }
  }

  if (!html) return null;

  const host = document.createElement('div');
  host.className = 'nps-insights';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<div style="margin:16px 0;padding:14px;border-radius:8px;background:#f5f5f5;line-height:1.5;color:#333;">${html}</div>`; // safe: browser extension with controlled data
  return host;
};

interface IkeaReview { rating: number; title: string; body: string; date: string }

const reviewToText = (r: IkeaReview): string => [r.title, r.body].filter(Boolean).join(': ').trim();

const reviewFields = (r: IkeaReview) => ({ rating: r.rating, title: r.title, body: r.body, meta: r.date });

// One page of reviews, newest first (submissionOn desc), each with its 1–5 rating;
// null when the request fails. No country filter: the pool spans all markets and
// product variants — the same population the rating endpoint's totals (and so our
// overall score) cover.
const fetchPage = async (country: string, lang: string, itemNo: string, size: number): Promise<IkeaReview[] | null> => {
  const res = await fetch(`https://web-api.ikea.com/tugc/public/v5/reviews/${country}/${lang}/${itemNo}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': CLIENT_ID },
    body: JSON.stringify({
      filter: { and: [], not: [] },
      sort: [{ field: 'submissionOn', direction: 'desc' }],
      page: { size, number: 1 },
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const json = await res.json();
  if (!Array.isArray(json)) return null;

  const seen = new Set<string>();
  const reviews: IkeaReview[] = [];
  for (const r of json) {
    const review: IkeaReview = {
      rating: Number(r.primaryRating?.ratingValue) || 0,
      title: r.title || '',
      body: r.text || '',
      date: String(r.submissionOn || '').slice(0, 10),
    };
    const id = String(r.id ?? '') || reviewToText(review);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    reviews.push(review);
  }
  return reviews;
};

// The newest RECENT_REVIEWS in one small request, so the gauge needn't wait, and
// every review up to SEARCH_MAX in one more (IKEA hands over a page as large as
// asked; KALLAX's ~10.5k is 13 MB) for the Sample and the search. The whole set is
// kept a week in IndexedDB: a big item's set would crowd the site's localStorage.
const fetchReviews = (country: string, lang: string, itemNo: string) => {
  const cacheKey = `ikea-reviews-v3-${itemNo}`;
  const cached: Promise<IkeaReview[] | null> = idbGet(cacheKey, (reviews) => (reviews.length ? REVIEWS_TTL : NEG_TTL));
  const all = cached.then(async (hit) => {
    if (hit) return hit;
    const reviews = await fetchPage(country, lang, itemNo, SEARCH_MAX);
    // Empty result sets tombstone briefly too (see the TTL above).
    if (reviews) idbSet(cacheKey, reviews);
    return reviews ?? [];
  });
  const recent = cached.then(async (hit) => hit ?? (await fetchPage(country, lang, itemNo, RECENT_REVIEWS)) ?? all);
  return { recent, all };
};

const addSummarizeUI = (
  anchor: Element,
  { recent, all }: ReturnType<typeof fetchReviews>,
  itemNo: string,
  total: number,
  scoreData: { score: number; nps: number } | null
) => {
  if (document.querySelector('.ars-wrapper')) return;

  const wrapper = createIslandShell();

  // Recent-positive gauge and the adjusted/analyzed stats row from the newest
  // RECENT_REVIEWS, which land first; the search waits for every review.
  const gauge = buildRecentGauge();
  const searchSlot = el('div');
  wrapper.append(gauge, searchSlot);
  // The Sample stops at SAMPLE_MAX; past it, an Ask Searches the rest.
  const searchAsk = total > SAMPLE_MAX ? localSearchAsk(all, reviewFields, reviewToText, wrapper) : undefined;
  recent
    .then((reviews) => {
      const newest = reviews.slice(0, RECENT_REVIEWS);
      const ratio = recentRatio(newest.map((r) => r.rating));
      fillRecentGauge(gauge, ratio);
      if (ratio == null) return;
      const stats = el('div', 'ars-stats');
      if (scoreData) appendStat(stats, addCommas(adjust(scoreData.score, ratio)), 'adjusted');
      appendStat(stats, String(newest.length), 'analyzed');
      gauge.after(stats);
    })
    .catch(() => fillRecentGauge(gauge, null));

  // Between the stats row and the summarize widget's question row.
  all.then((reviews) => {
    if (!reviews.length) return;
    searchSlot.appendChild(buildSearchSection({
      reviews,
      fields: reviewFields,
      toText: reviewToText,
      summaryPrompt: keywordSummaryPrompt,
      exampleQuery: 'quality OR assembly',
      mountSummarize: summarizeMatches(`ikea-summary-${itemNo}`, { searchAsk }),
    }));
  });

  buildSummarizeWidget({
    wrapper,
    cacheKey: `ikea-summary-${itemNo}`,
    summaryPrompt: PRODUCT_SUMMARY_PROMPT,
    fetchReviews: () =>
      all.then((reviews) => [...new Set(reviews.slice(0, SAMPLE_MAX).map(reviewToText).filter(Boolean))]),
    searchAsk,
  });

  anchor.after(wrapper);
};

const cleanup = () => {
  document.querySelectorAll('.nps-insights').forEach((el) => el.remove());
  document.querySelectorAll('.nps-pdp-badge').forEach((el) => el.remove());
  document.querySelectorAll('.ars-wrapper').forEach((el) => el.remove());
};

setupSpaInjector({
  match: () => getLocale() && extractItemNo(),
  load: async () => {
    const locale = getLocale();
    const itemNo = extractItemNo();
    if (!locale || !itemNo) return null;
    // Reviews start downloading alongside the rating, which only decides whether
    // the island shows — not once the page has an anchor for it.
    const reviews = fetchReviews(locale.country, locale.lang, itemNo);
    const data = await fetchRating(locale.country, locale.lang, itemNo);
    if (!data) return null;
    const reviewCount = data.totalReviewCount ?? 0;
    return { itemNo, scoreData: getScore(data), panel: buildInsightsPanel(data), reviewCount, reviews: reviewCount >= 5 ? reviews : null };
  },
  inject: ({ itemNo, scoreData, panel, reviewCount, reviews }) => {
    if (scoreData) {
      const ratingBtn = document.querySelector('button.pipf-rating');
      if (ratingBtn && !ratingBtn.querySelector('.nps-score-badge')) appendScore(ratingBtn, scoreData);
    }
    const ugc = document.querySelector('.js-ugc-container');
    if (panel && !document.body.contains(panel) && ugc) ugc.after(panel);
    if (reviews) {
      const anchor = document.querySelector('.nps-insights') || ugc;
      if (anchor) addSummarizeUI(anchor, reviews, itemNo, reviewCount, scoreData);
    }
  },
  cleanup,
});
