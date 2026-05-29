import { addCommas, npsColor } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { setupSpaInjector } from '../shared/spa-injector';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
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

// One round-trip: fetch all MAX_PAGES in parallel (the API caps `limit` at 25, so 4 pages =
// 100 reviews). Page 0's response also carries the aggregate `rating`. Reviews are deduped by
// id in case the API clamps an out-of-range offset. Cached 30 days, so it's paid once per product.
const fetchReviewData = async (country: string, lang: string, productId: string) => {
  const cacheKey = `nps_uniqlo_v2_${productId}`;
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
      // Keep only what the breakdown needs — avoids caching comment text for 100 reviews.
      reviews.push({
        purchasedSize: rv.purchasedSize,
        purchasedColorName: rv.purchasedColorName,
        rate: rv.rate,
        fit: rv.fit,
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
  const nps = ((five - one) / total) * 100;
  const score = Math.round((five - one) * ((five - one) / total));
  return { score, nps };
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

interface VarRow { label: string; net: number; n: number; fit: number | null; }

const aggregate = (
  reviews: any[],
  keyFn: (r: any) => string,
  labelFn: (r: any) => string
): VarRow[] => {
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

const VAR_STYLE_ID = 'uq-var-styles';
const ensureVarStyles = () => {
  if (document.getElementById(VAR_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = VAR_STYLE_ID;
  s.textContent = `
.uq-var{margin-top:14px;background:#fff;border:1px solid #E7E5E4;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.uq-var-head{padding:10px 12px 0}
.uq-var-title{display:block;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#A8A29E}
.uq-var-tabs{display:flex;gap:2px;margin-top:8px;border-bottom:1px solid #E7E5E4}
.uq-var-tab{appearance:none;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;padding:6px 10px;font-family:inherit;font-size:12px;font-weight:600;color:#A8A29E;cursor:pointer;transition:color .15s,border-color .15s}
.uq-var-tab:hover{color:#57534E}
.uq-var-tab.is-active{color:#0F766E;border-bottom-color:#0F766E}
.uq-var-panel{display:flex;flex-direction:column;padding:6px 12px 10px}
.uq-var-row{display:grid;grid-template-columns:1fr 56px auto;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #F5F5F4}
.uq-var-row:last-child{border-bottom:none}
.uq-var-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.uq-var-val{font-size:12.5px;color:#44403C;overflow-wrap:anywhere}
.uq-var-best .uq-var-val{font-weight:700;color:#1C1917}
.uq-var-best .uq-var-val::before{content:"\\25C6";color:#0F766E;font-size:9px;margin-right:5px;vertical-align:1px}
.uq-var-fit{font-size:10px;color:#A8A29E;letter-spacing:.01em}
.uq-var-track{height:5px;background:#EFEDEC;border-radius:3px;overflow:hidden}
.uq-var-fill{display:block;height:100%;border-radius:3px}
.uq-var-fill.pos{background:#16A34A}
.uq-var-fill.neg{background:#DC2626}
.uq-var-score{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;color:#78716C}
.uq-var-score.pos{color:#15803D}
.uq-var-score.neg{color:#DC2626}`;
  document.head.appendChild(s);
};

const buildVariations = (reviews: any[]): HTMLElement | null => {
  if (!reviews?.length) return null;

  const dims = [
    { label: 'Size', rows: aggregate(reviews, (r) => r.purchasedSize, (r) => r.purchasedSize) },
    { label: 'Colour', rows: aggregate(reviews, (r) => colorCode(r.purchasedColorName), (r) => r.purchasedColorName) },
  ].filter((d) => d.rows.length >= 2);

  if (!dims.length) return null;
  ensureVarStyles();

  const box = document.createElement('div');
  box.className = 'uq-var';
  const head = document.createElement('div');
  head.className = 'uq-var-head';
  const title = document.createElement('span');
  title.className = 'uq-var-title';
  title.textContent = 'Best by variation';
  head.appendChild(title);
  box.appendChild(head);

  const panel = document.createElement('div');
  panel.className = 'uq-var-panel';

  const renderPanel = (rows: VarRow[]) => {
    panel.replaceChildren();
    const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.net)), 0) || 1;
    rows.forEach((r, i) => {
      const sign = r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : '';
      const row = document.createElement('div');
      row.className = 'uq-var-row' + (i === 0 && r.net > 0 ? ' uq-var-best' : '');

      const name = document.createElement('span');
      name.className = 'uq-var-name';
      const val = document.createElement('span');
      val.className = 'uq-var-val';
      val.textContent = r.label;
      const meta = document.createElement('span');
      meta.className = 'uq-var-fit';
      meta.textContent =
        `${r.n} review${r.n === 1 ? '' : 's'}` + (r.fit != null && r.n >= 3 ? ` · ${fitText(r.fit)}` : '');
      name.append(val, meta);

      const track = document.createElement('span');
      track.className = 'uq-var-track';
      const fill = document.createElement('i');
      fill.className = 'uq-var-fill ' + sign;
      fill.style.width = `${(Math.abs(r.net) / maxAbs) * 100}%`;
      track.appendChild(fill);

      const score = document.createElement('span');
      score.className = 'uq-var-score ' + sign;
      score.textContent = (r.net > 0 ? '+' : '') + r.net;

      row.append(name, track, score);
      panel.appendChild(row);
    });
  };

  if (dims.length > 1) {
    const tabs = document.createElement('div');
    tabs.className = 'uq-var-tabs';
    tabs.setAttribute('role', 'tablist');
    dims.forEach((dim, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'uq-var-tab' + (i === 0 ? ' is-active' : '');
      btn.setAttribute('role', 'tab');
      btn.textContent = dim.label;
      btn.addEventListener('click', () => {
        tabs.querySelectorAll('.uq-var-tab').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        renderPanel(dim.rows);
      });
      tabs.appendChild(btn);
    });
    head.appendChild(tabs);
  }

  box.appendChild(panel);
  renderPanel(dims[0].rows);
  return box;
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

setupSpaInjector({
  match: extractProductId,
  load: async () => {
    const locale = getLocale();
    const productId = extractProductId();
    if (!locale || !productId) return null;
    const data = await fetchReviewData(locale.country, locale.lang, productId);
    if (!data) return null;
    return { rating: data.rating, reviews: data.reviews, scoreData: getScore(data.rating) };
  },
  inject: ({ rating, reviews, scoreData }) => {
    const ratingEl = document.querySelector('[data-testid="ITORating"]');
    if (!ratingEl) return;
    if (scoreData && !ratingEl.parentElement?.querySelector('.nps-score-badge')) {
      appendScore(ratingEl, scoreData);
    }
    if (!document.querySelector('.nps-insights')) {
      renderInsights(ratingEl, rating, reviews);
    }
  },
  cleanup: () => {
    document.querySelectorAll('.nps-insights').forEach(el => el.remove());
    document.querySelectorAll('.nps-score-badge').forEach(el => el.remove());
  },
});
