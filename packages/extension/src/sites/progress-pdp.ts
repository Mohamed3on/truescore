import { addCommas, el } from '../shared/utils';
import { PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';
import { buildReviewPanel } from '../shared/review-panel';
import { buildGauge, createIslandShell, type IslandScore } from '../shared/score-island';
import { computeScore, getProductInfo, loadReviews, PROGRESS, reviewToText, type ProductInfo, type ReviewBundle, type StampedReview } from '../shared/stamped';

// Progress sells gis, rash guards and shorts, and its reviews mostly talk fit,
// so sizing leads as a buying tip, as on Uniqlo.
const SUMMARY_PROMPT = `${PRODUCT_SUMMARY_PROMPT}

This is BJJ apparel. Treat fit and sizing as first-class: when reviewers agree on how it runs, give the concrete tip (e.g. "Runs small — size up if you're between sizes"). Reviews are prefixed with the size the reviewer bought when known — anchor sizing advice to those sizes and to any height and weight reviewers give. Fold any care tips reviewers mention (shrinkage, washing, drying) into the conclusion.`;

// A review's variant is the size bought, unless it only repeats the product's name.
const sizeOf = (r: StampedReview) => (r.productVariantName !== r.productName && r.productVariantName) || '';

const toText = (r: StampedReview) => {
  const text = reviewToText(r);

  return text && sizeOf(r) ? `[Size: ${sizeOf(r)}] ${text}` : text;
};

const cardFields = (r: StampedReview) => ({ rating: r.reviewRating, title: r.reviewTitle, body: r.reviewMessage, meta: sizeOf(r) && `Size ${sizeOf(r)}` });

const buildPanel = (info: ProductInfo, bundle: ReviewBundle, scored: IslandScore, autoSummarize: boolean | Promise<boolean>) => {
  const wrapper = createIslandShell();
  wrapper.append(...buildGauge(scored));
  // Stamped's sample is all a Search reaches.
  buildReviewPanel(wrapper, {
    key: `progress-summary-${info.id}`,
    total: bundle.reviews.length,
    all: bundle.reviews,
    text: toText,
    card: cardFields,
    exampleQuery: 'shrink OR size',
    summaryPrompt: SUMMARY_PROMPT,
    autoSummarize,
  });

  return wrapper;
};

// One more item on Stamped's stars line under the title, in its type and grey;
// a click goes down to the panel.
const buildLineScore = ({ score, nps, total }: IslandScore, panel: HTMLElement) => {
  const item = el('a', undefined, ' · TrueScore ');
  item.setAttribute('href', '#');
  item.style.cssText = 'color:inherit;text-decoration:none';
  item.title = `Net loved: 5★ minus 1★, over all ${addCommas(total)} reviews`;
  item.append(el('b', undefined, addCommas(score)), ` · ${Math.round(nps)}% net loved`);
  item.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  return item;
};

(function main() {
  const info = getProductInfo();

  if (!info) return;
  const reviewsWidget = document.getElementById('stamped-main-widget')!;
  const titleBlock = document.querySelector('.product__title-and-price');

  // Stamped redraws its stars line once its script loads, wiping whatever is
  // inside, so the score goes back in whenever it's missing.
  let lineScore: HTMLElement | null = null;

  const placeLineScore = () => {
    const line = titleBlock?.querySelector('.stamped-main-badge .stamped-badge');

    if (lineScore && line && !line.contains(lineScore)) line.append(lineScore);
  };

  if (titleBlock) new MutationObserver(placeLineScore).observe(titleBlock, { childList: true, subtree: true });

  loadReviews(PROGRESS, info, (bundle, autoSummarize) => {
    const scored = computeScore(bundle);

    if (!scored || scored.total < 5) return;
    document.querySelector('.ars-wrapper')?.remove();
    lineScore?.remove();
    // Below the product's own details, just above Stamped's Customer Reviews.
    const panel = buildPanel(info, bundle, scored, autoSummarize);
    reviewsWidget.before(panel);
    lineScore = buildLineScore(scored, panel);
    placeLineScore();
  });
})();
