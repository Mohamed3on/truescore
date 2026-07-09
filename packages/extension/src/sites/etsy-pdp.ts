import { addCommas, npsColor } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { renderVariationCard, type VarDim } from '../shared/variation-table';
import { buildSummarizeWidget, PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';
import {
  fetchItemScore,
  fetchRecentReviews,
  fetchVariations,
  listingMeta,
  type EtsyReview,
  type ItemScore,
  type ListingMeta,
} from '../shared/etsy';

const REVIEWS_TTL = 7 * 24 * 60 * 60 * 1000;
const RECENT_PAGES = 13; // 104 reviews — the newest ones, where variants still exist
const VARIATION_BATCH = 20;

const throttledFetch = createThrottledFetcher(8);

// 5★ reads as a recommendation and 1★ as a warning; the middle is noise. Same
// net-sentiment mapping the rest of TrueScore scores on.
const starScore = (rating: number) => (rating === 5 ? 1 : rating === 1 ? -1 : 0);

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const recentReviews = async (meta: ListingMeta): Promise<EtsyReview[]> => {
  const key = `etsy_reviews_${meta.listingId}`;
  const cached = cacheGet(key, REVIEWS_TTL);
  if (cached) return cached;

  const pages = await Promise.all(
    Array.from({ length: RECENT_PAGES }, (_, i) =>
      fetchRecentReviews(throttledFetch, meta, i + 1).catch((): EtsyReview[] => [])
    )
  );
  const reviews = pages.flat();
  if (reviews.length) cacheSet(key, reviews);
  return reviews;
};

const variationsFor = async (meta: ListingMeta, reviews: EtsyReview[]) => {
  const batches = chunk(reviews.map((r) => r.transactionId), VARIATION_BATCH);
  const maps = await Promise.all(
    batches.map((ids) =>
      fetchVariations(throttledFetch, meta, ids).catch(() => new Map<number, [string, string][]>())
    )
  );
  return new Map(maps.flatMap((m) => [...m]));
};

// One tab per variation dimension (Colour, Size, …), each ranking that
// dimension's values by net sentiment. A dimension with a single value has
// nothing to compare, so it earns no tab.
const buildDims = (reviews: EtsyReview[], variations: Map<number, [string, string][]>): VarDim[] => {
  const dims = new Map<string, Map<string, { score: number; count: number }>>();
  for (const review of reviews) {
    for (const [dim, value] of variations.get(review.transactionId) ?? []) {
      let values = dims.get(dim);
      if (!values) dims.set(dim, (values = new Map()));
      const tally = values.get(value) ?? { score: 0, count: 0 };
      tally.score += starScore(review.rating);
      tally.count++;
      values.set(value, tally);
    }
  }

  return [...dims.entries()]
    .filter(([, values]) => values.size >= 2)
    .map(([dim, values]) => ({
      label: dim,
      rows: [...values.entries()]
        .map(([label, { score, count }]) => ({
          label,
          score,
          meta: `${count} review${count === 1 ? '' : 's'}`,
        }))
        .sort((a, b) => b.score - a.score),
    }));
};

// In the buy box, under the price and above the variant pickers — the score is
// worth reading while deciding, not a scroll away. Etsy's own rating block is
// the fallback for layouts that ship no buy box (sold-out, digital downloads).
const panelAnchor = (): [Element, InsertPosition] | null => {
  const buyBox = document.querySelector('[data-buy-box]');
  if (buyBox) return [buyBox, 'beforebegin'];
  const header = document.querySelector('.reviews-header');
  return header ? [header, 'afterend'] : null;
};

const buildGauge = ({ score, nps, total }: ItemScore) => {
  const gauge = document.createElement('div');
  gauge.className = 'ars-gauge';
  gauge.style.cursor = 'default';
  gauge.innerHTML = `
    <div class="ars-gauge-label"><span class="ars-gauge-pct"></span> positive on this item</div>
    <div class="ars-gauge-track"><div class="ars-gauge-fill"></div></div>
  `; // safe: no user content in template
  const tone = npsColor(nps);
  const pct = gauge.querySelector('.ars-gauge-pct') as HTMLElement;
  pct.textContent = `${Math.round(nps)}%`;
  pct.style.color = tone;
  const fill = gauge.querySelector('.ars-gauge-fill') as HTMLElement;
  fill.style.cssText = `width:100%;background:${tone};transform:scaleX(${Math.max(0, nps) / 100})`;

  const stats = document.createElement('div');
  stats.className = 'ars-stats';
  stats.innerHTML = `
    <div class="ars-stat"><span class="ars-stat-val"></span><span class="ars-stat-lbl">truescore</span></div>
    <div class="ars-stat-div"></div>
    <div class="ars-stat"><span class="ars-stat-val"></span><span class="ars-stat-lbl">item reviews</span></div>
  `; // safe: no user content in template
  const [scoreEl, totalEl] = stats.querySelectorAll('.ars-stat-val');
  scoreEl.textContent = addCommas(score);
  totalEl.textContent = addCommas(total);

  return [gauge, stats];
};

const run = async (meta: ListingMeta) => {
  const anchor = panelAnchor();
  if (!anchor || document.querySelector('.ars-wrapper')) return;

  const [score, reviews] = await Promise.all([
    fetchItemScore(throttledFetch, meta.listingId, meta.shopId).catch(() => null),
    recentReviews(meta),
  ]);
  if (!score && !reviews.length) return;
  if (document.querySelector('.ars-wrapper')) return; // a late-hydration rerun beat us here

  const wrapper = document.createElement('div');
  wrapper.className = 'ars-wrapper';
  const header = document.createElement('div');
  header.className = 'ars-header';
  header.innerHTML = '<span class="ars-header-accent">&#x25C8;</span> Review Intelligence';
  wrapper.appendChild(header);
  if (score) wrapper.append(...buildGauge(score));

  // Variations resolve a beat after the reviews they annotate; hold their place
  // so the summariser below doesn't end up above them.
  const variationSlot = document.createElement('div');
  wrapper.appendChild(variationSlot);

  const texts = [...new Set(reviews.map((r) => r.text).filter(Boolean))];
  if (texts.length >= 5) {
    buildSummarizeWidget({
      wrapper,
      cacheKey: `etsy-summary-${meta.listingId}`,
      summaryPrompt: PRODUCT_SUMMARY_PROMPT,
      fetchReviews: async () => texts,
    });
  }
  anchor[0].insertAdjacentElement(anchor[1], wrapper);

  if (!reviews.length) return;
  const dims = buildDims(reviews, await variationsFor(meta, reviews));
  if (!dims.length) return;

  const card = renderVariationCard(dims, { animate: true });
  card.style.maxWidth = '100%';
  card.style.margin = '2px 0 0';
  variationSlot.appendChild(card);
};

const meta = listingMeta();
if (meta) run(meta).catch(() => {});

// Etsy hydrates the buy box after `document_end`, so the anchor can arrive late.
// The second run re-reads the cache rather than the network.
if (meta && !panelAnchor()) {
  const observer = new MutationObserver(() => {
    if (!panelAnchor()) return;
    observer.disconnect();
    run(meta).catch(() => {});
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
