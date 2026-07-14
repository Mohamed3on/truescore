import { addCommas, npsColor, npsStats } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { setupSpaInjector } from '../shared/spa-injector';
import { renderVariationCard, type VarDim } from '../shared/variation-table';
import { buildSummarizeWidget, PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';
import { createIslandShell } from '../shared/score-island';

// Uniqlo reviews are overwhelmingly about fit, fabric, and sizing, so nudge those
// to the front as actionable buying tips rather than leaving them buried.
const UNIQLO_SUMMARY_PROMPT = `${PRODUCT_SUMMARY_PROMPT}

This is a clothing item. Treat fit and sizing as first-class: when reviewers agree on how it runs, give the concrete tip (e.g. "Runs small — size up if you're between sizes"). Fold any care or styling tips reviewers mention (shrinkage, sheerness, layering, ironing) into the conclusion.`;

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 4; // 25 reviews/page — 100 reviews is plenty for the variation breakdown

const getLocale = () => {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { country: parts[0], lang: parts[1] };
};

const extractProductId = () => {
  const match = location.pathname.match(/\/products\/([^/]+)/);
  return match ? match[1] : null;
};

// The buy-box rating (aggregate stars up by the title/price) lives in the product
// <main>; the per-review stars render in a separate section outside it. Scoping to
// <main> keeps us off a review-card rating — "first ITORating in the document" is a
// hydration race that binds to whichever rendered first. Returns null until the rating
// has hydrated into <main>, letting the injector's mutation retry place it a beat later.
const findBuyBoxRating = (): Element | null =>
  document.querySelector('main')?.querySelector('[data-testid="ITORating"]') ?? null;

// One round-trip: fetch all MAX_PAGES in parallel (the API caps `limit` at 25, so 4 pages =
// 100 reviews). Page 0's response also carries the aggregate `rating`. Reviews are deduped by
// id in case the API clamps an out-of-range offset. Cached a week, so it's paid ~once per product.
const fetchReviewData = async (country: string, lang: string, productId: string) => {
  const cacheKey = `nps_uniqlo_v3_${productId}`;
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;

  const headers = { 'x-fr-clientid': `uq.${country}.web-spa` };
  const page = (offset: number) =>
    fetch(
      `https://www.uniqlo.com/${country}/api/commerce/v5/${lang}/products/${productId}/reviews?limit=25&offset=${offset}&sort=submission_time&httpFailure=true`,
      { headers }
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

  const pages = await Promise.all(Array.from({ length: MAX_PAGES }, (_, i) => page(i * 25)));
  const rating = pages[0]?.result?.rating ?? null;
  if (!rating) return null;

  const reviews: any[] = [];
  const seen = new Set<unknown>();
  for (const p of pages) {
    for (const rv of p?.result?.reviews ?? []) {
      const id = rv.reviewId ?? rv.bvId ?? `${rv.name}-${rv.createDate}`;
      if (seen.has(id)) continue;
      seen.add(id);
      // Kept: the variation-breakdown fields plus the review prose the LLM summary needs.
      reviews.push({
        purchasedSize: rv.purchasedSize,
        purchasedColorName: rv.purchasedColorName,
        rate: rv.rate,
        fit: rv.fit,
        title: rv.title,
        comment: rv.comment,
      });
    }
  }

  const data = { rating, reviews };
  cacheSet(cacheKey, data);
  return data;
};

const getScore = (rating: any) => {
  const rc = rating?.rateCount;
  if (!rc) return null;
  const { one = 0, two = 0, three = 0, four = 0, five = 0 } = rc;
  const total = one + two + three + four + five;
  if (total === 0) return null;
  return npsStats(five, one, total);
};

const appendScore = (ratingEl: Element, { score, nps }: { score: number; nps: number }) => {
  const parent = ratingEl.parentElement;
  if (!parent || parent.querySelector('.nps-score-badge')) return;
  const badge = document.createElement('span');
  badge.className = 'nps-score-badge';
  badge.style.cssText = `color:${npsColor(nps)};font-weight:600;font-size:14px;margin-left:8px;white-space:nowrap;`;
  badge.textContent = `${addCommas(String(score))} (${Math.round(nps)}%)`;
  parent.appendChild(badge);
};

// === Variation breakdown (best-performing size / colour, tab through) ===

// Match the page score: 5★ → +1, 1★ → −1, everything else neutral.
const polarity = (rate: number) => (rate >= 5 ? 1 : rate <= 1 ? -1 : 0);

// Reviews syndicate across locales, so the same colour shows localized names
// ("56 OLIVGRÜN" / "56 VERT OLIVE"). They share a numeric code prefix — merge on it.
const colorCode = (name: string) => {
  const t = (name || '').trim();
  return t.match(/^\d+/)?.[0] || t;
};

const fitText = (fit: number) => (fit < 2.4 ? 'runs small' : fit > 3.6 ? 'runs large' : 'true to size');

interface DimStat { label: string; net: number; n: number; fit: number | null; }

const aggregate = (
  reviews: any[],
  keyFn: (r: any) => string,
  labelFn: (r: any) => string
): DimStat[] => {
  const groups = new Map<string, { net: number; n: number; fitSum: number; fitN: number; labels: Map<string, number> }>();
  for (const r of reviews) {
    const key = keyFn(r);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { net: 0, n: 0, fitSum: 0, fitN: 0, labels: new Map() }));
    g.net += polarity(r.rate);
    g.n++;
    if (typeof r.fit === 'number') { g.fitSum += r.fit; g.fitN++; }
    const lbl = (labelFn(r) || '').trim();
    if (lbl) g.labels.set(lbl, (g.labels.get(lbl) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      // Most-frequent full colour name (e.g. "30 NATURAL"); fall back to the code if unnamed.
      label: [...g.labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || key,
      net: g.net,
      n: g.n,
      fit: g.fitN ? g.fitSum / g.fitN : null,
    }))
    .sort((a, b) => b.net - a.net || b.n - a.n);
};

const buildVariations = (reviews: any[]): HTMLElement | null => {
  if (!reviews?.length) return null;

  const dims = [
    { label: 'Size', rows: aggregate(reviews, (r) => r.purchasedSize, (r) => r.purchasedSize) },
    { label: 'Colour', rows: aggregate(reviews, (r) => colorCode(r.purchasedColorName), (r) => r.purchasedColorName) },
  ].filter((d) => d.rows.length >= 2);

  if (!dims.length) return null;

  const varDims: VarDim[] = dims.map((d) => ({
    label: d.label,
    rows: d.rows.map((r) => ({
      label: r.label,
      score: r.net,
      meta: `${r.n} review${r.n === 1 ? '' : 's'}` + (r.fit != null && r.n >= 3 ? ` · ${fitText(r.fit)}` : ''),
    })),
  }));

  return renderVariationCard(varDims);
};

const renderInsights = (ratingEl: Element, rating: any, reviews: any[]) => {
  if (document.querySelector('.nps-insights')) return;
  const rc = rating?.rateCount;
  if (!rc) return;
  const { one = 0, two = 0, three = 0, four = 0, five = 0 } = rc;
  const total = one + two + three + four + five;
  if (total === 0) return;

  const bars = [
    { label: '5 stars', value: five },
    { label: '4 stars', value: four },
    { label: '3 stars', value: three },
    { label: '2 stars', value: two },
    { label: '1 star', value: one },
  ];
  const colors = ['#2e7d32', '#558b2f', '#f9a825', '#ef6c00', '#c62828'];

  let html = '';
  for (let i = 0; i < bars.length; i++) {
    const pct = Math.round((bars[i].value / total) * 100);
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
      <span style="width:55px;flex-shrink:0;font-size:12px">${bars[i].label}</span>
      <div style="flex:1;height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${colors[i]};border-radius:3px;min-width:${pct > 0 ? 2 : 0}px"></div>
      </div>
      <span style="width:32px;text-align:right;font-size:12px;color:#888">${pct}%</span>
    </div>`;
  }

  if (rating.fit != null) {
    const fitLabels = ['Too small', 'Slightly small', 'True to size', 'Slightly large', 'Too large'];
    const idx = Math.min(4, Math.max(0, Math.round(rating.fit) - 1));
    const fitHue = Math.min(120, Math.max(0, (1 - Math.abs(rating.fit - 3) / 2) * 120));
    html += `<div style="margin-top:8px;font-size:13px">
      Fit: <strong style="color:hsl(${fitHue},70%,35%)">${fitLabels[idx]}</strong>
      <span style="color:#888;font-size:11px">(${rating.fit.toFixed(1)}/5)</span>
    </div>`;
  }

  const panel = document.createElement('div');
  panel.className = 'nps-insights';
  panel.style.cssText = 'margin:12px 0;padding:14px;border-radius:8px;background:#f5f5f5;line-height:1.5;color:#333;';
  panel.innerHTML = html; // safe: browser extension with controlled data

  const variations = buildVariations(reviews);
  if (variations) panel.appendChild(variations);

  const gutter = ratingEl.closest('.gutter-container');
  if (gutter) gutter.after(panel);
};

// === LLM review summary (praised / complaints / better alternative / verdict) ===

const reviewTexts = (reviews: any[]): string[] => {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const r of reviews) {
    const text = [r.title, r.comment].filter(Boolean).join(': ').trim();
    if (text && !seen.has(text)) { seen.add(text); texts.push(text); }
  }
  return texts;
};

const addSummarizeUI = (ratingEl: Element, productId: string, texts: string[]) => {
  if (document.querySelector('.ars-wrapper')) return;

  const wrapper = createIslandShell();

  buildSummarizeWidget({
    wrapper,
    cacheKey: `uniqlo-summary-${productId}`,
    summaryPrompt: UNIQLO_SUMMARY_PROMPT,
    fetchReviews: async () => texts,
  });

  // Sit in the buy-box, directly under the rating row (above the fold) instead of
  // after the far-down insights panel. Anchor to the rating's top-level block in the
  // product-info column so the widget spans that column's width.
  const gutter = ratingEl.closest('.gutter-container');
  const block = gutter ? [...gutter.children].find((c) => c.contains(ratingEl)) : null;
  (block ?? ratingEl).after(wrapper);
};

setupSpaInjector({
  match: extractProductId,
  load: async () => {
    const locale = getLocale();
    const productId = extractProductId();
    if (!locale || !productId) return null;
    const data = await fetchReviewData(locale.country, locale.lang, productId);
    if (!data) return null;
    return { productId, rating: data.rating, reviews: data.reviews, scoreData: getScore(data.rating) };
  },
  inject: ({ productId, rating, reviews, scoreData }) => {
    const ratingEl = findBuyBoxRating();
    if (!ratingEl) return;
    if (scoreData && !ratingEl.parentElement?.querySelector('.nps-score-badge')) {
      appendScore(ratingEl, scoreData);
    }
    if (!document.querySelector('.nps-insights')) {
      renderInsights(ratingEl, rating, reviews);
    }
    const texts = reviewTexts(reviews);
    if (texts.length >= 5 && !document.querySelector('.ars-wrapper')) {
      addSummarizeUI(ratingEl, productId, texts);
    }
  },
  cleanup: () => {
    document.querySelectorAll('.nps-insights').forEach(el => el.remove());
    document.querySelectorAll('.nps-score-badge').forEach(el => el.remove());
    document.querySelectorAll('.ars-wrapper').forEach(el => el.remove());
  },
});
