import { addCommas, npsColor } from '../shared/utils';
import { SAMPLE_MAX } from '../shared/review-summary';
import { buildReviewPanel } from '../shared/review-panel';
import { appendStat, createIslandShell } from '../shared/score-island';
import { renderScoreBadge } from '../shared/score-grid';
import { renderVariationCard, tallyVariationDims } from '../shared/variation-table';
import { fetchReviews, pageProductId, productScore, type PrintfulReview } from '../shared/printful';

const text = (r: PrintfulReview) => r.body;
const card = (r: PrintfulReview) => ({ rating: r.rating, body: r.body, meta: r.date });

(async function main() {
  const productId = pageProductId();
  const scored = productId ? await productScore(productId) : null;

  if (!productId || !scored) return;
  const { score, nps, total } = scored;
  const badge = renderScoreBadge(scored);

  const panel = createIslandShell();
  const reviews = fetchReviews(productId, total);

  const { stats } = buildReviewPanel(panel, {
    key: `printful-summary-${productId}`,
    // Searches reach only the reviews in hand.
    total: Math.min(total, SAMPLE_MAX),
    ...reviews,
    allMax: SAMPLE_MAX,
    score,
    text,
    card,
    date: (r) => r.date,
    exampleQuery: 'fit OR print',
  });

  appendStat(stats!, addCommas(score), 'score', npsColor(nps));
  appendStat(stats!, addCommas(total), 'reviews');

  // Each review names the colour and size bought.
  reviews.all.then((all) => {
    const dims = tallyVariationDims(all, {
      variationsOf: (r) => [['Color', r.color], ['Size', r.size]],
      ratingOf: (r) => r.rating,
    });

    if (!dims.length) return;
    const variations = renderVariationCard(dims, { animate: true, summarize: { key: `printful-summary-${productId}`, text, card } });
    variations.style.maxWidth = '100%';
    panel.append(variations);
  });

  // The score joins the stars under the title; the panel goes under the
  // "Start designing" button. Both go back if Printful's Vue app redraws them.
  const place = () => {
    if (!badge.isConnected) document.querySelector('.reviews-in-total')?.append(badge);

    if (!panel.isConnected) document.querySelector('.product-action-buttons')?.after(panel);
  };

  place();
  new MutationObserver(place).observe(document.body, { childList: true, subtree: true });
})();
