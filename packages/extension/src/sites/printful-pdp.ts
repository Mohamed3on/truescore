import { addCommas, npsColor } from '../shared/utils';
import { SAMPLE_MAX } from '../shared/review-summary';
import { buildReviewPanel } from '../shared/review-panel';
import { appendStat, createIslandShell } from '../shared/score-island';
import { renderScoreBadge } from '../shared/score-grid';
import { fetchReviews, pageProductId, productScore, type PrintfulReview } from '../shared/printful';

(async function main() {
  const productId = pageProductId();
  const scored = productId ? await productScore(productId) : null;

  if (!productId || !scored) return;
  const { score, nps, total } = scored;
  const badge = renderScoreBadge(scored);

  const panel = createIslandShell();

  const { stats } = buildReviewPanel(panel, {
    key: `printful-summary-${productId}`,
    // Searches reach only the reviews in hand.
    total: Math.min(total, SAMPLE_MAX),
    ...fetchReviews(productId, total),
    allMax: SAMPLE_MAX,
    score,
    text: (r: PrintfulReview) => r.body,
    card: (r: PrintfulReview) => ({ rating: r.rating, body: r.body, meta: r.date }),
    date: (r) => r.date,
    exampleQuery: 'fit OR print',
  });

  appendStat(stats!, addCommas(score), 'score', npsColor(nps));
  appendStat(stats!, addCommas(total), 'reviews');

  // The score joins the stars under the title; the panel goes under the
  // "Start designing" button. Both go back if Printful's Vue app redraws them.
  const place = () => {
    if (!badge.isConnected) document.querySelector('.reviews-in-total')?.append(badge);

    if (!panel.isConnected) document.querySelector('.product-action-buttons')?.after(panel);
  };

  place();
  new MutationObserver(place).observe(document.body, { childList: true, subtree: true });
})();
