import { addCommas, el, npsColor, npsStats } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { buildSummarizeWidget, PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';
import { extractDecathlonIds, getDecathlonSite } from '../shared/decathlon';
import { setupSpaInjector } from '../shared/spa-injector';
import { appendStat, buildRecentGauge, createIslandShell, fillRecentGauge, recentPositiveRatio, trendingScore } from '../shared/score-island';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

const fetchStats = async (tld: string, locale: string, sku: string, productId: string) => {
  const cacheKey = `nps_stats_${productId}`;
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;

  const res = await fetch(
    `https://www.decathlon.${tld}/api/reviews/${locale}/reviews-stats/${sku}/product?nbItemsPerPage=0&page=0`
  );
  if (!res.ok) return null;
  const json = await res.json();
  const stats = json?.stats ?? null;
  if (stats) cacheSet(cacheKey, stats);
  return stats;
};

const getScoreFromStats = (stats: any) => {
  const dist = stats?.ratingDistribution;
  if (!dist?.length) return null;
  let total = 0, five = 0, one = 0;
  for (const { code, value } of dist) {
    total += value;
    if (code === '5') five = value;
    if (code === '1') one = value;
  }
  if (total === 0) return null;
  return npsStats(five, one, total);
};

const appendScore = (productInfo: Element, { score, nps }: { score: number; nps: number }) => {
  const reviewDiv = productInfo.querySelector('.review');
  if (!reviewDiv || reviewDiv.querySelector('.nps-score-badge')) return;
  const separator = document.createElement('div');
  separator.className = 'review__vertical-line';
  const badge = document.createElement('span');
  badge.className = 'vp-body-s nps-score-badge';
  badge.style.cssText = `color: ${npsColor(nps)}; font-weight: 600;`;
  badge.textContent = `${addCommas(String(score))} (${Math.round(nps)}%)`;
  reviewDiv.appendChild(separator);
  reviewDiv.appendChild(badge);
};

const renderInsights = (productInfo: Element, stats: any) => {
  if (document.querySelector('.nps-insights')) return;
  const { averageAttributeRating, recommendedCount, count } = stats;
  if (!averageAttributeRating?.length) return;

  const recPct = count ? Math.round((recommendedCount / count) * 100) : null;

  let html = '';

  if (recPct != null) {
    html += `<div style="margin-bottom:12px;display:flex;align-items:center;gap:6px;font-size:13px">
      <strong>${recPct}%</strong> of reviewers recommend this
      <span style="color:#888;font-size:11px">(${recommendedCount}/${count})</span>
    </div>`;
  }

  for (const attr of averageAttributeRating) {
    const pct = (attr.value / 5) * 100;
    const hue = Math.min(120, Math.max(0, (pct - 50) * 3));
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
      <span style="width:170px;flex-shrink:0;font-size:12px;overflow-wrap:break-word">${attr.label}</span>
      <div style="flex:1;height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:hsl(${hue},70%,40%);border-radius:3px"></div>
      </div>
      <span style="width:26px;text-align:right;font-size:12px;font-weight:600">${attr.value.toFixed(1)}</span>
    </div>`;
  }

  const panel = document.createElement('div');
  panel.className = 'nps-insights';
  panel.style.cssText = 'margin:16px 0;padding:14px;border-radius:8px;background:#f5f5f5;line-height:1.5;color:#333;';
  panel.innerHTML = html;
  const desc = productInfo.querySelector('.product-info__description');
  if (desc) desc.before(panel);
  else productInfo.appendChild(panel);
};

const replaceSizometer = (stats: any) => {
  const { fitDistribution } = stats;
  if (!fitDistribution?.length) return;
  const fitTotal = fitDistribution.reduce((s: number, f: any) => s + f.value, 0);
  if (fitTotal === 0) return;

  const sizometer = document.querySelector('[data-cs-override-id="product_productinfo_sizometer"]');
  if (!sizometer) return;

  const labels = ['Too small', 'Slightly small', 'As expected', 'Slightly large', 'Too large'];
  const colors = ['#c62828', '#f57c00', '#2e7d32', '#f57c00', '#c62828'];
  const asExpected = fitDistribution.find((f: any) => f.code === 'as_expected');
  const asExpectedPct = asExpected ? Math.round((asExpected.value / fitTotal) * 100) : 0;

  let rowsHtml = '';
  for (let i = 0; i < fitDistribution.length; i++) {
    const f = fitDistribution[i];
    const pct = Math.round((f.value / fitTotal) * 100);
    rowsHtml += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
      <span style="width:100px;flex-shrink:0;font-size:11px;color:#555">${labels[i]}</span>
      <div style="flex:1;height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${colors[i]};border-radius:3px;min-width:${pct > 0 ? 2 : 0}px"></div>
      </div>
      <span style="width:32px;text-align:right;font-size:11px;color:#888">${pct}%</span>
    </div>`;
  }

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin:4px 0;';
  wrapper.innerHTML = [
    `<button type="button" style="`,
    `  display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;`,
    `  cursor:pointer;padding:8px 0;font-family:inherit;font-size:13px;color:#333;`,
    `">`,
    `  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">`,
    `    <path d="M12.4 12.4L9.9 9.9M6.3 13.4L8.4 15.5M13.4 6.3L15.5 8.4M20 8.3L8.3 19.9C7.9 20.3 7.3 20.3 6.9 19.9L4.1 17.1C3.7 16.7 3.7 16.1 4.1 15.7L15.7 4C16.1 3.6 16.7 3.6 17.1 4L20 6.9C20.4 7.2 20.4 7.9 20 8.3Z"/>`,
    `  </svg>`,
    `  <span>Fit: <strong>${asExpectedPct}% as expected</strong></span>`,
    `  <svg class="nps-fit-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-left:auto;transition:transform .2s">`,
    `    <path d="M6 9l6 6 6-6"/>`,
    `  </svg>`,
    `</button>`,
    `<div class="nps-fit-body" style="padding:4px 0 8px 28px;">`,
    `  ${rowsHtml}`,
    `  <div style="font-size:11px;color:#888;margin-top:4px">${fitTotal} reviews</div>`,
    `</div>`,
  ].join('\n');

  const btn = wrapper.querySelector('button')!;
  const body = wrapper.querySelector('.nps-fit-body') as HTMLElement;
  const chevron = wrapper.querySelector('.nps-fit-chevron') as HTMLElement;
  btn.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    chevron.style.transform = open ? 'rotate(-90deg)' : '';
  });

  sizometer.replaceWith(wrapper);
};

interface DktReview { rating: number; text: string }

// The newest ~500 reviews (sortBy=DATE, newest first), each with its 1–5 rating.
// Rating-only reviews stay in — they count toward the recent gauge even with no
// prose for the summarizer. `v2`: entries were plain texts before ratings rode along.
const fetchRecentReviews = async (tld: string, locale: string, sku: string, productId: string): Promise<DktReview[]> => {
  const reviewsCacheKey = `dkt-reviews-v2-${productId}`;
  const cached = cacheGet(reviewsCacheKey, 86400000);
  if (cached) return cached;

  const seen = new Set<string>();
  const reviews: DktReview[] = [];
  const results = await Promise.allSettled(
    [0, 1, 2, 3, 4].map(page =>
      fetch(`https://www.decathlon.${tld}/api/reviews/${locale}/reviews-stats/${sku}/product?nbItemsPerPage=100&page=${page}&sortBy=DATE`)
        .then(r => r.ok ? r.json() : null)
    )
  );
  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value?.reviews) continue;
    for (const r of result.value.reviews) {
      const text = [r.title, r.comment].filter(Boolean).join(': ').trim();
      const id = String(r.id ?? '') || text;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      reviews.push({ rating: Number(r.rating?.code) || 0, text });
    }
  }
  if (reviews.length) cacheSet(reviewsCacheKey, reviews);
  return reviews;
};

const addSummarizeUI = (
  anchor: Element,
  tld: string,
  locale: string,
  sku: string,
  productId: string,
  scoreData: { score: number; nps: number } | null
) => {
  if (document.querySelector('.ars-wrapper')) return;

  const wrapper = createIslandShell();

  // Recent-positive gauge, filled once the newest reviews land (one cached
  // fetch shared with the summarizer), plus the trending/analyzed stats row.
  const gauge = buildRecentGauge();
  wrapper.appendChild(gauge);
  const reviewsPromise = fetchRecentReviews(tld, locale, sku, productId);
  reviewsPromise
    .then((reviews) => {
      const ratio = recentPositiveRatio(reviews.map((r) => r.rating));
      fillRecentGauge(gauge, ratio);
      if (ratio == null) return;
      const stats = el('div', 'ars-stats') as HTMLElement;
      if (scoreData) appendStat(stats, addCommas(trendingScore(scoreData.score, ratio)), 'trending');
      appendStat(stats, String(reviews.length), 'analyzed');
      gauge.after(stats);
    })
    .catch(() => fillRecentGauge(gauge, null));

  buildSummarizeWidget({
    wrapper,
    cacheKey: `dkt-summary-${productId}`,
    summaryPrompt: PRODUCT_SUMMARY_PROMPT,
    fetchReviews: () =>
      reviewsPromise.then((reviews) => [...new Set(reviews.map((r) => r.text).filter(Boolean))]),
  });

  anchor.after(wrapper);
};

setupSpaInjector({
  match: () => !!extractDecathlonIds(),
  load: async () => {
    const site = getDecathlonSite();
    const ids = extractDecathlonIds();
    if (!site || !ids) return null;
    const stats = await fetchStats(site.tld, site.locale, ids.sku, ids.productId);
    if (!stats) return null;
    return { site, ids, stats, scoreData: getScoreFromStats(stats) };
  },
  inject: ({ site, ids, stats, scoreData }) => {
    const productInfo = document.querySelector('.product-info');
    if (!productInfo) return;
    if (scoreData) appendScore(productInfo, scoreData);
    renderInsights(productInfo, stats);
    replaceSizometer(stats);
    if (stats.count >= 5 && !document.querySelector('.ars-wrapper')) {
      const anchor = document.querySelector('.nps-insights') || productInfo.querySelector('.product-info__description') || productInfo;
      addSummarizeUI(anchor, site.tld, site.locale, ids.sku, ids.productId, scoreData);
    }
  },
  cleanup: () => {
    document.querySelectorAll('.nps-insights').forEach(el => el.remove());
    document.querySelectorAll('.nps-score-badge').forEach(el => {
      const sep = el.previousElementSibling;
      if (sep?.classList.contains('review__vertical-line')) sep.remove();
      el.remove();
    });
    document.querySelectorAll('.ars-wrapper').forEach(el => el.remove());
  },
});
