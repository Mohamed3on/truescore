import { addCommas, npsColor } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

const getLocale = () => {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { country: parts[0], lang: parts[1] };
};

const extractProductId = () => {
  const match = location.pathname.match(/\/products\/([^/]+)/);
  return match ? match[1] : null;
};

const fetchRating = async (country: string, lang: string, productId: string) => {
  const cacheKey = `nps_uniqlo_${productId}`;
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;
  const res = await fetch(
    `https://www.uniqlo.com/${country}/api/commerce/v5/${lang}/products/${productId}/reviews?limit=1&offset=0&sort=submission_time&httpFailure=true`,
    { headers: { 'x-fr-clientid': `uq.${country}.web-spa` } }
  );
  if (!res.ok) return null;
  const json = await res.json();
  const rating = json?.result?.rating ?? null;
  if (rating) cacheSet(cacheKey, rating);
  return rating;
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

const renderInsights = (ratingEl: Element, rating: any) => {
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

  const gutter = ratingEl.closest('.gutter-container');
  if (gutter) gutter.after(panel);
};

let generation = 0;
let activeObs: MutationObserver | null = null;

const cleanup = () => {
  if (activeObs) { activeObs.disconnect(); activeObs = null; }
  document.querySelectorAll('.nps-insights').forEach(el => el.remove());
  document.querySelectorAll('.nps-score-badge').forEach(el => el.remove());
};

const init = async () => {
  const locale = getLocale();
  const productId = extractProductId();
  if (!locale || !productId) return;

  const gen = ++generation;
  cleanup();

  const rating = await fetchRating(locale.country, locale.lang, productId);
  if (gen !== generation || !rating) return;
  const scoreData = getScore(rating);

  const inject = () => {
    if (gen !== generation) { activeObs?.disconnect(); return; }
    const ratingEl = document.querySelector('[data-testid="ITORating"]');
    if (!ratingEl) return;
    if (scoreData && !ratingEl.parentElement?.querySelector('.nps-score-badge')) {
      appendScore(ratingEl, scoreData);
    }
    if (!document.querySelector('.nps-insights')) {
      renderInsights(ratingEl, rating);
    }
  };

  inject();
  activeObs = new MutationObserver(inject);
  activeObs.observe(document.body, { childList: true, subtree: true });
};

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (extractProductId()) init();
  }
}).observe(document, { childList: true, subtree: true });

init();
