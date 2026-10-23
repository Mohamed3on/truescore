import { addCommas, npsColor } from '../shared/utils';
import { SAMPLE_MAX } from '../shared/review-summary';
import { buildReviewPanel } from '../shared/review-panel';
import { appendStat, createIslandShell } from '../shared/score-island';
import { renderScoreBadge } from '../shared/score-grid';
import { fetchReviews, histogram, scoreOf, type OttoReview } from '../shared/otto';

// A product page is `/p/<slug>-<id>/`; reviews are the product's, across its
// variations.
const productId = location.pathname.match(/^\/p\/(?:.*-)?([A-Z0-9]+)\/?$/)?.[1];
const scored = productId ? scoreOf(histogram(document)) : null;

if (productId && scored) {
  const { score, nps, total } = scored;
  const badge = renderScoreBadge(scored);

  const panel = createIslandShell();
  const { stats } = buildReviewPanel(panel, {
    key: `otto-summary-${productId}`,
    // Searches reach only the reviews in hand.
    total: Math.min(total, SAMPLE_MAX),
    ...fetchReviews(productId, total),
    allMax: SAMPLE_MAX,
    score,
    text: (r: OttoReview) => [r.title, r.body].filter(Boolean).join(': '),
    card: (r: OttoReview) => ({ rating: r.rating, title: r.title, body: r.body, meta: r.date }),
    date: (r) => r.date,
    exampleQuery: 'Qualität OR Lieferung',
  });
  appendStat(stats!, addCommas(score), 'score', npsColor(nps));
  appendStat(stats!, addCommas(total), 'reviews');

  // The score joins the stars under the title; the panel goes under the
  // add-to-cart card of the buy column, whose payment and returns notes are a
  // block of their own. Both go back if Otto redraws them.
  const buyCard = () => {
    const block = document.querySelector('.js_pdp_ordering')?.closest('.pl_block');
    return block?.parentElement?.querySelector(':scope > .pdp_platform-advantages') ?? block;
  };
  const place = () => {
    if (!badge.isConnected) document.querySelector('.js_pdp_quick-access .pdp_cr-rating__wrapper')?.append(badge);
    if (!panel.isConnected) buyCard()?.after(panel);
  };
  place();
  new MutationObserver(place).observe(document.body, { childList: true, subtree: true });
}
