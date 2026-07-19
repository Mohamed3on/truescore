import { npsStats } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { setupScoreGrid, containersBySelector } from '../shared/score-grid';

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
  return npsStats(five, one, total);
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

const locale = getLocale();
if (!locale) throw new Error('unsupported locale');

setupScoreGrid({
  cardSelector: '.product-tile, .fr-ec-product-tile',
  scoreForCard: (tile) => {
    const link = tile.closest('a[href*="/products/"]') || tile.querySelector('a[href*="/products/"]');
    const productId = link && extractProductId(link.getAttribute('href')!);
    return productId ? fetchScore(locale.country, locale.lang, productId) : Promise.resolve(null);
  },
  placeBadge: (tile, badge) => {
    tile.querySelector('.fr-ec-rating-static__count-product-tile')?.after(badge);
  },
  // React-managed `display: grid` collections — the default CSS-band ranking
  // is the only kind they don't fight.
  discover: containersBySelector(
    '.fr-ec-product-collection--ecrenewal-grid, .fr-ec-product-collection--type-grid'
  ),
});
