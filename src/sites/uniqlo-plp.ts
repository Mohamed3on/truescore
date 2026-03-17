import { addCommas, npsColor } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

const getLocale = () => {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { country: parts[0], lang: parts[1] };
};

const extractProductId = (href: string) => {
  const match = href.match(/\/products\/([^/]+)/);
  return match ? match[1] : null;
};

const scoreFromRateCount = (rc: any) => {
  const { one = 0, two = 0, three = 0, four = 0, five = 0 } = rc;
  const total = one + two + three + four + five;
  if (total === 0) return null;
  const nps = ((five - one) / total) * 100;
  const score = Math.round((five - one) * ((five - one) / total));
  return { score, nps };
};

const fetchScore = async (country: string, lang: string, productId: string) => {
  const cacheKey = `nps_uniqlo_score_${productId}`;
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;
  // reuse PDP cache if available
  const pdpCached = cacheGet(`nps_uniqlo_${productId}`, CACHE_TTL);
  if (pdpCached?.rateCount) {
    const result = scoreFromRateCount(pdpCached.rateCount);
    if (result) { cacheSet(cacheKey, result); return result; }
  }

  const res = await fetch(
    `https://www.uniqlo.com/${country}/api/commerce/v5/${lang}/products/${productId}/reviews?limit=1&offset=0&sort=submission_time&httpFailure=true`,
    { headers: { 'x-fr-clientid': `uq.${country}.web-spa` } }
  );
  if (!res.ok) return null;
  const json = await res.json();
  const rc = json?.result?.rating?.rateCount;
  if (!rc) return null;

  const result = scoreFromRateCount(rc);
  if (result) cacheSet(cacheKey, result);
  return result;
};

const injectBadge = (tile: Element, { score, nps }: { score: number; nps: number }) => {
  const badge = document.createElement('span');
  badge.style.cssText = `color:${npsColor(nps)};font-weight:600;font-size:12px;margin-left:6px;`;
  badge.textContent = `${addCommas(score)} (${Math.round(nps)}%)`;
  const target = tile.querySelector('.fr-ec-rating-static__count-product-tile');
  if (target) target.after(badge);
};

let sorting = false;

const sortGrid = () => {
  const grid = document.querySelector('.fr-ec-product-collection--ecrenewal-grid');
  if (!grid) return;
  const items = [...grid.children];
  const scores = items.map(el => ({
    el,
    score: parseFloat(el.querySelector('[data-nps]')?.getAttribute('data-nps') ?? '-Infinity'),
  }));
  scores.sort((a, b) => b.score - a.score);
  sorting = true;
  for (const { el } of scores) grid.appendChild(el);
  sorting = false;
};

const locale = getLocale();
if (!locale) throw new Error('unsupported locale');

const processCards = () => {
  if (sorting) return;
  const tiles = document.querySelectorAll('.product-tile:not([data-nps-done]), .fr-ec-product-tile:not([data-nps-done])');
  if (tiles.length === 0) return;

  const promises: Promise<void>[] = [];
  for (const tile of tiles) {
    tile.setAttribute('data-nps-done', '1');
    const link = tile.closest('a[href*="/products/"]') || tile.querySelector('a[href*="/products/"]');
    if (!link) continue;
    const productId = extractProductId(link.getAttribute('href')!);
    if (!productId) continue;

    promises.push(
      fetchScore(locale.country, locale.lang, productId).then((data) => {
        if (data && !isNaN(data.nps)) {
          tile.setAttribute('data-nps', data.score);
          injectBadge(tile, data);
        }
      }).catch(() => {})
    );
  }

  if (promises.length > 0) Promise.all(promises).then(sortGrid);
};

processCards();
new MutationObserver(processCards).observe(document.body, { childList: true, subtree: true });
