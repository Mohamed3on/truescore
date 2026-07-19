import { addCommas, el, npsColor, npsStats } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { buildSummarizeWidget, FILTERED_PRODUCT_SUMMARY_PROMPT, PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';
import { buildSearchSection } from '../shared/review-search';
import { setupSpaInjector } from '../shared/spa-injector';
import { appendStat, buildRecentGauge, createIslandShell, fillRecentGauge, recentPositiveRatio, trendingScore } from '../shared/score-island';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const REVIEWS_TTL = 24 * 60 * 60 * 1000;
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

// The newest ~500 reviews (submissionOn desc), each with its 1–5 rating. No
// country filter: the pool spans all markets and product variants — the same
// population the rating endpoint's totals (and so our overall score) cover.
const fetchRecentReviews = async (country: string, lang: string, itemNo: string): Promise<IkeaReview[]> => {
  const cacheKey = `ikea-reviews-v2-${itemNo}`;
  const cached = cacheGet(cacheKey, REVIEWS_TTL);
  if (cached) return cached;

  const res = await fetch(`https://web-api.ikea.com/tugc/public/v5/reviews/${country}/${lang}/${itemNo}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': CLIENT_ID },
    body: JSON.stringify({
      filter: { and: [], not: [] },
      sort: [{ field: 'submissionOn', direction: 'desc' }],
      page: { size: 500, number: 1 },
    }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  if (!Array.isArray(json)) return [];

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
  if (reviews.length) cacheSet(cacheKey, reviews);
  return reviews;
};

const addSummarizeUI = (
  anchor: Element,
  country: string,
  lang: string,
  itemNo: string,
  scoreData: { score: number; nps: number } | null
) => {
  if (document.querySelector('.ars-wrapper')) return;

  const wrapper = createIslandShell();

  // Recent-positive gauge, filled once the newest reviews land (one cached
  // fetch shared with the summarizer), plus the trending/analyzed stats row.
  const gauge = buildRecentGauge();
  wrapper.appendChild(gauge);
  const reviewsPromise = fetchRecentReviews(country, lang, itemNo);
  reviewsPromise
    .then((reviews) => {
      const ratio = recentPositiveRatio(reviews.map((r) => r.rating));
      fillRecentGauge(gauge, ratio);
      if (ratio == null) return;
      const stats = el('div', 'ars-stats');
      if (scoreData) appendStat(stats, addCommas(trendingScore(scoreData.score, ratio)), 'trending');
      appendStat(stats, String(reviews.length), 'analyzed');
      gauge.after(stats);

      // Between the stats row and the summarize widget's question row.
      stats.after(buildSearchSection({
        reviews,
        fields: (r) => ({ rating: r.rating, title: r.title, body: r.body, meta: r.date }),
        toText: reviewToText,
        summaryPrompt: FILTERED_PRODUCT_SUMMARY_PROMPT,
        exampleQuery: 'quality OR assembly',
      }));
    })
    .catch(() => fillRecentGauge(gauge, null));

  buildSummarizeWidget({
    wrapper,
    cacheKey: `ikea-summary-${itemNo}`,
    summaryPrompt: PRODUCT_SUMMARY_PROMPT,
    fetchReviews: () =>
      reviewsPromise.then((reviews) => [...new Set(reviews.map(reviewToText).filter(Boolean))]),
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
    const data = await fetchRating(locale.country, locale.lang, itemNo);
    if (!data) return null;
    return { locale, itemNo, scoreData: getScore(data), panel: buildInsightsPanel(data), reviewCount: data.totalReviewCount ?? 0 };
  },
  inject: ({ locale, itemNo, scoreData, panel, reviewCount }) => {
    if (scoreData) {
      const ratingBtn = document.querySelector('button.pipf-rating');
      if (ratingBtn && !ratingBtn.querySelector('.nps-score-badge')) appendScore(ratingBtn, scoreData);
    }
    const ugc = document.querySelector('.js-ugc-container');
    if (panel && !document.body.contains(panel) && ugc) ugc.after(panel);
    if (reviewCount >= 5) {
      const anchor = document.querySelector('.nps-insights') || ugc;
      if (anchor) addSummarizeUI(anchor, locale.country, locale.lang, itemNo, scoreData);
    }
  },
  cleanup,
});
