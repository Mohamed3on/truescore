import { addCommas, afterHydration, el, npsColor, npsStats } from '../shared/utils';
import { cacheGet, cacheSet, NEG_TTL } from '../shared/cache';
import { idbGet, idbSet } from '../shared/idb-cache';
import { buildSummarizeWidget, keywordSummaryPrompt, PRODUCT_SUMMARY_PROMPT, SAMPLE_MAX, summarizeMatches } from '../shared/review-summary';
import { buildSearchSection, localSearchAsk, SEARCH_MAX } from '../shared/review-search';
import { extractDecathlonIds, getDecathlonSite } from '../shared/decathlon';
import { setupSpaInjector } from '../shared/spa-injector';
import { appendStat, buildRecentGauge, createIslandShell, fillRecentGauge } from '../shared/score-island';
import { adjust, RECENT_REVIEWS, recentRatio } from '../shared/recency';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

// Hydration happens once per page load: in-app navigations after it wait for nothing.
const hydrated = afterHydration();
const REVIEWS_TTL = 7 * 24 * 60 * 60 * 1000;
// Decathlon hands over a page as large as asked, but big ones fail (500) now and
// then — a 20,000-review page (25 MB) did — so the full set comes in pages this
// size, each tried up to three times.
const REVIEWS_PAGE = 5000;

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
  // The pdp marker keeps cleanup() off the PLP grid script's badges — this
  // script runs domain-wide, so its cleanup fires on PLP filter navs too.
  badge.className = 'vp-body-s nps-score-badge nps-pdp-badge';
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

  if (document.querySelector('.nps-fit')) return;
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
  wrapper.className = 'nps-fit';
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

  // Hide the host's sizometer instead of replacing it — the node is
  // Vue-managed, and removing it invites the framework to fight or crash on
  // its next patch of that subtree. Ours sits after it; cleanup un-hides.
  sizometer.after(wrapper);
  (sizometer as HTMLElement).style.display = 'none';
};

interface DktReview { rating: number; title: string; body: string; date: string }

const reviewToText = (r: DktReview) => [r.title, r.body].filter(Boolean).join(': ').trim();

const reviewFields = (r: DktReview) => ({ rating: r.rating, title: r.title, body: r.body, meta: r.date });

const reviewsUrl = (tld: string, locale: string, sku: string, size: number, page: number) =>
  `https://www.decathlon.${tld}/api/reviews/${locale}/reviews-stats/${sku}/product?nbItemsPerPage=${size}&page=${page}&sortBy=DATE`;

const fetchJson = async (url: string, tries = 3): Promise<any> => {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) return res.json();
    if (attempt >= tries) throw new Error(`Decathlon reviews ${res?.status ?? 'unreachable'}`);
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
};

// Appends the page's reviews not `seen` yet to `into`, each with its 1–5 rating.
// Rating-only reviews stay in — they count toward the recent gauge even with no
// prose for the summarizer.
const addReviews = (json: any, into: DktReview[], seen = new Set<string>()) => {
  for (const r of json?.reviews ?? []) {
    const review: DktReview = {
      rating: Number(r.rating?.code) || 0,
      title: r.title || '',
      body: r.comment || '',
      date: String(r.publisherDate || '').slice(0, 10),
    };
    const id = String(r.id ?? '') || reviewToText(review);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    into.push(review);
  }
  return into;
};

// Newest first (sortBy=DATE, the page's own language leading): the newest
// RECENT_REVIEWS in one small request, so the gauge needn't wait, and every review
// up to SEARCH_MAX for the Sample and the search — its first page at once, the
// rest when `total` says how many there are. The whole set is kept a week in
// IndexedDB — only once complete, or a failed page's hole would be served for the
// week. `v3`: entries were the newest 500 as plain texts before.
const fetchReviews = (tld: string, locale: string, sku: string, productId: string, total: Promise<number>) => {
  const cacheKey = `dkt-reviews-v3-${productId}`;
  const cached: Promise<DktReview[] | null> = idbGet(cacheKey, (reviews) => (reviews.length ? REVIEWS_TTL : NEG_TTL));
  const all = cached.then(async (hit) => {
    if (hit) return hit;
    const first = fetchJson(reviewsUrl(tld, locale, sku, REVIEWS_PAGE, 0));
    const pageCount = Math.ceil(Math.min(await total, SEARCH_MAX) / REVIEWS_PAGE);
    const pages = await Promise.allSettled([
      first,
      ...Array.from({ length: pageCount - 1 }, (_, i) => fetchJson(reviewsUrl(tld, locale, sku, REVIEWS_PAGE, i + 1))),
    ]);
    const reviews: DktReview[] = [];
    const seen = new Set<string>();
    for (const page of pages) if (page.status === 'fulfilled') addReviews(page.value, reviews, seen);
    // Parsed-but-empty tombstones briefly (see the TTL above).
    if (pages.every((page) => page.status === 'fulfilled')) idbSet(cacheKey, reviews);
    return reviews;
  });
  const recent = cached.then((hit) => hit ?? fetchJson(reviewsUrl(tld, locale, sku, RECENT_REVIEWS, 0))
    .then((json) => addReviews(json, []), () => all));
  return { recent, all };
};

const addSummarizeUI = (
  anchor: Element,
  { recent, all }: ReturnType<typeof fetchReviews>,
  productId: string,
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
      const stats = el('div', 'ars-stats') as HTMLElement;
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
      exampleQuery: 'size OR quality',
      mountSummarize: summarizeMatches(`dkt-summary-${productId}`, { searchAsk }),
    }));
  });

  buildSummarizeWidget({
    wrapper,
    cacheKey: `dkt-summary-${productId}`,
    summaryPrompt: PRODUCT_SUMMARY_PROMPT,
    fetchReviews: () =>
      all.then((reviews) => [...new Set(reviews.slice(0, SAMPLE_MAX).map(reviewToText).filter(Boolean))]),
    searchAsk,
  });

  anchor.after(wrapper);
};

setupSpaInjector({
  match: () => !!extractDecathlonIds(),
  load: async () => {
    const site = getDecathlonSite();
    const ids = extractDecathlonIds();
    if (!site || !ids) return null;
    const statsPromise = fetchStats(site.tld, site.locale, ids.sku, ids.productId);
    // Reviews start downloading at once, alongside the stats that size them; only
    // touching the page waits for React to hydrate it.
    const reviews = fetchReviews(site.tld, site.locale, ids.sku, ids.productId, statsPromise.then((stats) => stats?.count ?? 0));
    const [stats] = await Promise.all([statsPromise, hydrated]);
    if (!stats) return null;
    return { ids, stats, scoreData: getScoreFromStats(stats), reviews: stats.count >= 5 ? reviews : null };
  },
  inject: ({ ids, stats, scoreData, reviews }) => {
    const productInfo = document.querySelector('.product-info');
    if (!productInfo) return;
    if (scoreData) appendScore(productInfo, scoreData);
    renderInsights(productInfo, stats);
    replaceSizometer(stats);
    if (reviews && !document.querySelector('.ars-wrapper')) {
      const anchor = document.querySelector('.nps-insights') || productInfo.querySelector('.product-info__description') || productInfo;
      addSummarizeUI(anchor, reviews, ids.productId, stats.count, scoreData);
    }
  },
  cleanup: () => {
    document.querySelectorAll('.nps-insights').forEach(el => el.remove());
    document.querySelectorAll('.nps-pdp-badge').forEach(el => {
      const sep = el.previousElementSibling;
      if (sep?.classList.contains('review__vertical-line')) sep.remove();
      el.remove();
    });
    document.querySelectorAll('.nps-fit').forEach(el => el.remove());
    document.querySelectorAll<HTMLElement>('[data-cs-override-id="product_productinfo_sizometer"]')
      .forEach(el => { el.style.display = ''; });
    document.querySelectorAll('.ars-wrapper').forEach(el => el.remove());
  },
});
