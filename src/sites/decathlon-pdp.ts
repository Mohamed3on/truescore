import { addCommas, npsColor } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

const getLocale = () => {
  const host = location.hostname;
  if (host.includes('decathlon.de')) return 'de-DE';
  if (host.includes('decathlon.co.uk')) return 'en-GB';
  return null;
};

const extractModelId = () => {
  const path = location.pathname.split('#')[0].split('?')[0];
  const match = path.split('/').pop()!.match(/(\d{5,})$/);
  return match ? match[1] : null;
};

const fetchStats = async (locale: string, modelId: string) => {
  const cacheKey = `nps_stats_${modelId}`;
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;

  const domain = locale === 'en-GB' ? 'co.uk' : locale.split('-')[0];
  const res = await fetch(
    `https://www.decathlon.${domain}/api/reviews/${locale}/reviews-stats/${modelId}/product?nbItemsPerPage=0&page=0`
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
  const nps = ((five - one) / total) * 100;
  const score = Math.round((five - one) * ((five - one) / total));
  return { score, nps };
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
  panel.innerHTML = html; // safe: browser extension with controlled data
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
  wrapper.innerHTML = [ // safe: browser extension with controlled data
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

let generation = 0;

const cleanup = () => {
  document.querySelectorAll('.nps-insights').forEach(el => el.remove());
  document.querySelectorAll('.nps-score-badge').forEach(el => {
    const sep = el.previousElementSibling;
    if (sep?.classList.contains('review__vertical-line')) sep.remove();
    el.remove();
  });
};

const init = async () => {
  const locale = getLocale();
  const modelId = extractModelId();
  if (!locale || !modelId) return;

  const gen = ++generation;
  cleanup();

  const waitFor = (sel: string) => new Promise<Element>((resolve, reject) => {
    const el = document.querySelector(sel);
    if (el) return resolve(el);
    const obs = new MutationObserver(() => {
      if (gen !== generation) { obs.disconnect(); return reject('stale'); }
      const el = document.querySelector(sel);
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });

  const [productInfo, stats] = await Promise.all([
    waitFor('.product-info'),
    fetchStats(locale, modelId),
  ]);

  if (gen !== generation || !stats) return;
  const scoreData = getScoreFromStats(stats);
  if (scoreData) appendScore(productInfo, scoreData);
  renderInsights(productInfo, stats);
  replaceSizometer(stats);
};

init();
