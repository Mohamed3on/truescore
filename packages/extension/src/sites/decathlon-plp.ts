import { addCommas, npsColor, npsStats } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { extractDecathlonIds, getDecathlonSite } from '../shared/decathlon';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const CONTAINERS = 'ul.product-grid, ul.carousel-slides-wrapper';
const CARD = `:is(${CONTAINERS}) .product-card`;
const LINK = 'a[href*="/p/"]';

const site = getDecathlonSite();
if (!site) throw new Error('unsupported locale');
const { tld, locale } = site;

const fetchScore = async (sku: string, productId: string) => {
  const key = `nps_score_${productId}`;
  const cached = cacheGet(key, CACHE_TTL);
  if (cached) return cached;

  const res = await fetch(
    `https://www.decathlon.${tld}/api/reviews/${locale}/reviews-stats/${sku}/product?nbItemsPerPage=0&page=0`
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

  const result = npsStats(five, one, total);
  cacheSet(key, result);
  return result;
};

const injectBadge = (card: Element, { score, nps }: { score: number; nps: number }) => {
  const target = card.querySelector('.review__fullstars__votes');
  if (!target) return;
  const badge = document.createElement('span');
  badge.style.cssText = `color:${npsColor(nps)};font-weight:600;font-size:12px;margin-left:6px`;
  badge.textContent = `${addCommas(score)} (${Math.round(nps)}%)`;
  target.after(badge);
};

let sorting = false;

const sortGrid = () => {
  for (const grid of document.querySelectorAll(CONTAINERS)) {
    const items = [...grid.children].map(li => {
      const val = li.querySelector('[data-nps]')?.getAttribute('data-nps');
      return { li, score: val != null ? parseFloat(val) : -Infinity };
    });
    items.sort((a, b) => b.score - a.score);
    sorting = true;
    for (const { li } of items) grid.appendChild(li);
    sorting = false;
  }
};

const dedupGrid = () => {
  const seen = new Set<string>();
  for (const li of document.querySelectorAll(`:is(${CONTAINERS}) > li`)) {
    const link = li.querySelector(LINK);
    if (!link) continue;
    const ids = extractDecathlonIds(link.getAttribute('href')!);
    if (!ids) continue;
    (li as HTMLElement).style.display = seen.has(ids.productId) ? 'none' : '';
    seen.add(ids.productId);
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
    const ids = extractDecathlonIds(link.getAttribute('href')!);
    if (!ids) continue;
    promises.push(
      fetchScore(ids.sku, ids.productId).then((data) => {
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
