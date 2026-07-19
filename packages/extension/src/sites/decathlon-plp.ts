import { npsStats } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { extractDecathlonIds, getDecathlonSite } from '../shared/decathlon';
import { setupScoreGrid, containersBySelector } from '../shared/score-grid';

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

// Decathlon lists the same product once per colourway; hide the repeats so the
// grid ranks distinct products. This is genuinely per-site (one grid does it),
// so it stays here with its own observer rather than in the shared ranker.
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

setupScoreGrid({
  cardSelector: CARD,
  scoreForCard: (card) => {
    const link = card.querySelector(LINK);
    const ids = link && extractDecathlonIds(link.getAttribute('href')!);
    return ids ? fetchScore(ids.sku, ids.productId) : Promise.resolve(null);
  },
  placeBadge: (card, badge) => {
    card.querySelector('.review__fullstars__votes')?.after(badge);
  },
  // The PLP grid is React-reconciled (fiber keys on its `li`s) and `display:
  // grid`; the default CSS-band ranking is the only kind it doesn't fight, and
  // it also can't corrupt the carousel tracks the way node moves could.
  discover: containersBySelector(CONTAINERS),
});

let dedupFrame: number;
const scheduleDedup = () => {
  cancelAnimationFrame(dedupFrame);
  dedupFrame = requestAnimationFrame(dedupGrid);
};
scheduleDedup();
new MutationObserver(scheduleDedup).observe(document.body, { childList: true, subtree: true });
