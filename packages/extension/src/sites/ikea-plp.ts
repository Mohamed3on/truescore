import { npsStats } from '../shared/utils';
import { cacheGet, cacheGetMaybe, cacheSet, cacheSetMaybe } from '../shared/cache';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { setupScoreGrid } from '../shared/score-grid';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const throttledFetch = createThrottledFetcher(8);

const getLocale = () => {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { country: parts[0], lang: parts[1] };
};

const extractItemNo = (href: string) => {
  const match = href.match(/(\d{7,})\/?$/);
  return match ? match[1] : null;
};

const scoreFromDist = (dist: any[]) => {
  let total = 0, five = 0, one = 0;
  for (const { ratingType, ratingCount } of dist) {
    total += ratingCount;
    if (ratingType === 5) five = ratingCount;
    if (ratingType === 1) one = ratingCount;
  }
  if (total === 0) return null;
  return npsStats(five, one, total);
};

const fetchScore = async (country: string, lang: string, itemNo: string) => {
  const cacheKey = `nps_ikea_score_${itemNo}`;
  const cached = cacheGetMaybe(cacheKey, CACHE_TTL);
  if (cached) return cached.value;
  const pdpCached = cacheGet(`nps_ikea_${itemNo}`, CACHE_TTL);
  if (pdpCached?.ratingDistribution) {
    const result = scoreFromDist(pdpCached.ratingDistribution);
    if (result) { cacheSet(cacheKey, result); return result; }
  }

  const res = await throttledFetch(
    `https://web-api.ikea.com/tugc/public/v5/rating/${country}/${lang}/${itemNo}`,
    { headers: { 'x-client-id': 'a1047798-0fc4-446e-9616-0afe3256d0d7' } }
  );
  if (!res.ok) return null;
  const json = await res.json();
  const dist = json?.[0]?.ratingDistribution;
  const result = dist?.length ? scoreFromDist(dist) : null;
  cacheSetMaybe(cacheKey, result);
  return result;
};

const getItemNo = (card: Element) => {
  // Use data-product-number attribute first, strip 's' prefix
  const num = card.getAttribute('data-product-number');
  if (num) return num.replace(/^s/, '');
  // Fallback to URL extraction
  const link = card.querySelector('a[href*="/p/"]');
  return link ? extractItemNo(link.getAttribute('href')!) : null;
};

const locale = getLocale();
if (!locale) throw new Error('unsupported locale');

setupScoreGrid({
  cardSelector: '.plp-mastercard, .listing-mastercard',
  scoreForCard: (card) => {
    const itemNo = getItemNo(card);
    return itemNo ? fetchScore(locale.country, locale.lang, itemNo) : Promise.resolve(null);
  },
  placeBadge: (card, badge) => {
    const target = card.querySelector('.plp-rating__label') || card.querySelector('.listing-rating__label');
    if (target) target.after(badge);
  },
  // IKEA ranks two surfaces: the main product grid and any listing carousels.
  discover: () => [
    ...document.querySelectorAll('.plp-product-list__products'),
    ...document.querySelectorAll('.listing-carousel__content'),
  ],
});
