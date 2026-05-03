import { addCommas, npsColor } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

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
    { headers: { 'x-client-id': 'a1047798-0fc4-446e-9616-0afe3256d0d7' } }
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
  const nps = ((five - one) / total) * 100;
  const score = Math.round((five - one) * ((five - one) / total));
  return { score, nps };
};

const appendScore = (ratingBtn: Element, { score, nps }: { score: number; nps: number }) => {
  if (ratingBtn.querySelector('.nps-score-badge')) return;
  const badge = document.createElement('span');
  badge.className = 'nps-score-badge';
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

let generation = 0;

const cleanup = () => {
  document.querySelectorAll('.nps-insights').forEach(el => el.remove());
  document.querySelectorAll('.nps-score-badge').forEach(el => el.remove());
};

const init = async () => {
  const locale = getLocale();
  const itemNo = extractItemNo();
  if (!locale || !itemNo) return;

  const gen = ++generation;
  cleanup();

  const data = await fetchRating(locale.country, locale.lang, itemNo);
  if (gen !== generation || !data) return;

  const scoreData = getScore(data);
  const panel = buildInsightsPanel(data);

  const obs = new MutationObserver(() => {
    if (gen !== generation) { obs.disconnect(); return; }
    obs.disconnect();

    if (scoreData) {
      const ratingBtn = document.querySelector('button.pipf-rating');
      if (ratingBtn && !ratingBtn.querySelector('.nps-score-badge')) appendScore(ratingBtn, scoreData);
    }
    if (panel && !document.body.contains(panel)) {
      const ugc = document.querySelector('.js-ugc-container');
      if (ugc) ugc.after(panel);
    }

    obs.observe(document.body, { childList: true, subtree: true });
  });

  // Initial injection
  if (scoreData) {
    const ratingBtn = document.querySelector('button.pipf-rating');
    if (ratingBtn) appendScore(ratingBtn, scoreData);
  }
  if (panel) {
    const ugc = document.querySelector('.js-ugc-container');
    if (ugc) ugc.after(panel);
  }

  obs.observe(document.body, { childList: true, subtree: true });
};

init();
