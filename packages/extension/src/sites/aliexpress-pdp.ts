import { cacheGet, cacheSet } from '../shared/cache';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { renderVariationCard, tallyVariationDims } from '../shared/variation-table';
import { createIslandShell, buildGauge } from '../shared/score-island';
import { setupSpaInjector } from '../shared/spa-injector';
import { buildSummarizeWidget, PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';
import { fetchEvaluation, parseVariations, productId, type AliReview, type Evaluation } from '../shared/aliexpress';

const EVAL_TTL = 7 * 24 * 60 * 60 * 1000;

const throttledFetch = createThrottledFetcher(8);

// One request already carries both halves, so they share a cache entry.
const evaluationFor = async (id: string): Promise<Evaluation> => {
  const key = `ali_eval_${id}`;
  const cached = cacheGet(key, EVAL_TTL);
  if (cached) return cached;

  const data = await fetchEvaluation(throttledFetch, id).catch(
    (): Evaluation => ({ score: null, reviews: [] })
  );
  if (data.score || data.reviews.length) cacheSet(key, data);
  return data;
};

// AliExpress names each review's variation as one flat string aligned to the
// review order, so its dimensions tally by index.
const buildDims = (reviews: AliReview[]) => {
  const variations = parseVariations(reviews.map((r) => r.skuInfo));
  return tallyVariationDims(reviews, {
    variationsOf: (_r, i) => variations[i],
    ratingOf: (r) => r.rating,
  });
};

// Directly under AliExpress's own star average, where the number it corrects is
// still on screen. Listings that render no rating line — a brand-new item — put
// it under the title instead.
const panelAnchor = (): [Element, InsertPosition] | null => {
  const rating = document.querySelector('[class*="reviewer--wrap"]');
  if (rating) return [rating, 'afterend'];
  const title = document.querySelector('[class*="title--wrap"]');
  return title ? [title, 'afterend'] : null;
};

const buildIsland = async (id: string): Promise<HTMLElement | null> => {
  const { score, reviews } = await evaluationFor(id);
  if (!score && !reviews.length) return null;

  const wrapper = createIslandShell();
  if (score) wrapper.append(...buildGauge(score));

  const dims = buildDims(reviews);
  if (dims.length) {
    const card = renderVariationCard(dims, { animate: true });
    card.style.maxWidth = '100%';
    card.style.margin = '2px 0 0';
    wrapper.appendChild(card);
  }

  const texts = [...new Set(reviews.map((r) => r.text).filter(Boolean))];
  if (texts.length >= 5) {
    buildSummarizeWidget({
      wrapper,
      cacheKey: `ali-summary-${id}`,
      summaryPrompt: PRODUCT_SUMMARY_PROMPT,
      fetchReviews: async () => texts,
    });
  }
  return wrapper;
};

// The buy box is client-rendered, so the anchor routinely arrives after
// `document_end`; the injector re-inserts once it appears.
setupSpaInjector<HTMLElement>({
  match: () => productId(),
  load: async () => {
    const id = productId();
    return id ? buildIsland(id) : null;
  },
  inject: (wrapper) => {
    const anchor = panelAnchor();
    if (anchor && !document.body.contains(wrapper)) anchor[0].insertAdjacentElement(anchor[1], wrapper);
  },
  cleanup: () => document.querySelectorAll('.ars-wrapper').forEach((node) => node.remove()),
});
