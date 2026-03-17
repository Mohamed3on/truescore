import { addCommas } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const GRID = 'ul.product-grid';
const CARD = `${GRID} .product-card`;
const LINK = 'a[href*="/p/"]';

const locale = (() => {
  const h = location.hostname;
  if (h.includes('decathlon.de')) return 'de-DE';
  if (h.includes('decathlon.co.uk')) return 'en-GB';
  return null;
})();
if (!locale) throw new Error('unsupported locale');

const domain = locale === 'en-GB' ? 'co.uk' : locale.split('-')[0];
const cleanHref = (href: string) => href.split('#')[0].split('?')[0];

const extractModelId = (href: string) => {
  const match = cleanHref(href).split('/').pop()!.match(/(\d{5,})$/);
  return match?.[1] ?? null;
};

// URL pattern: /p/{slug}/{productId}/{variantId}
const extractProductId = (href: string) => {
  const parts = cleanHref(href).split('/');
  const i = parts.indexOf('p');
  return i >= 0 ? parts[i + 2] ?? null : null;
};

const fetchScore = async (modelId: string) => {
  const key = `nps_score_${modelId}`;
  const cached = cacheGet(key, CACHE_TTL);
  if (cached) return cached;

  const res = await fetch(
    `https://www.decathlon.${domain}/api/reviews/${locale}/reviews-stats/${modelId}/product?nbItemsPerPage=0&page=0`
  );
  if (!res.ok) return null;
  const dist = (await res.json())?.stats?.ratingDistribution;
  if (!dist?.length) return null;

  let total = 0, five = 0, one = 0;
  for (const { code, value } of dist) {
    total += value;
    if (code === '5') five = value;
    if (code === '1') one = value;
  }
  if (!total) return null;

  const nps = ((five - one) / total) * 100;
  const score = Math.round((five - one) * ((five - one) / total));
  const result = { score, nps };
  cacheSet(key, result);
  return result;
};

const injectBadge = (card: Element, { score, nps }: { score: number; nps: number }) => {
  const target = card.querySelector('.review__fullstars__votes');
  if (!target) return;
  const hue = Math.min(120, Math.max(0, (nps - 50) * 3));
  const badge = document.createElement('span');
  badge.style.cssText = `color:hsl(${hue},70%,35%);font-weight:600;font-size:12px;margin-left:6px`;
  badge.textContent = `${addCommas(score)} (${Math.round(nps)}%)`;
  target.after(badge);
};

let sorting = false;

const sortGrid = () => {
  const grid = document.querySelector(GRID);
  if (!grid) return;
  const items = [...grid.children].map(li => {
    const val = li.querySelector('[data-nps]')?.getAttribute('data-nps');
    return { li, score: val != null ? parseFloat(val) : -Infinity };
  });
  items.sort((a, b) => b.score - a.score);
  sorting = true;
  for (const { li } of items) grid.appendChild(li);
  sorting = false;
};

const dedupGrid = () => {
  const seen = new Set<string>();
  for (const li of document.querySelectorAll(`${GRID} > li`)) {
    const link = li.querySelector(LINK);
    if (!link) continue;
    const pid = extractProductId(link.getAttribute('href')!);
    if (!pid) continue;
    (li as HTMLElement).style.display = seen.has(pid) ? 'none' : '';
    seen.add(pid);
  }
};

const processNewCards = () => {
  if (sorting) return;
  const cards = document.querySelectorAll(`${CARD}:not([data-nps-done])`);
  if (!cards.length) return;

  const promises: Promise<void>[] = [];
  for (const card of cards) {
    card.setAttribute('data-nps-done', '1');
    const link = card.querySelector(LINK);
    if (!link) continue;
    const modelId = extractModelId(link.getAttribute('href')!);
    if (!modelId) continue;
    promises.push(
      fetchScore(modelId).then((data) => {
        if (data && !isNaN(data.nps)) {
          card.setAttribute('data-nps', data.score);
          injectBadge(card, data);
        }
      }).catch(() => {})
    );
  }
  if (promises.length) Promise.all(promises).then(sortGrid);
};

let frame: number;
const schedule = () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => { dedupGrid(); processNewCards(); });
};

schedule();
new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
