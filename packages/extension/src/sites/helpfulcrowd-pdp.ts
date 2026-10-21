import { addCommas, el } from '../shared/utils';
import { buildReviewPanel } from '../shared/review-panel';
import { buildGauge, createIslandShell, type IslandScore } from '../shared/score-island';
import { computeScore, fetchReviews, storeCode, type HcReview } from '../shared/helpfulcrowd';

const MIN_REVIEW_CHARS = 20;

// One line under HelpfulCrowd's stars summary, in the host's type; a click goes
// down to the panel.
const buildLineScore = ({ score, nps, total }: IslandScore, panel: HTMLElement) => {
  const item = el('a', undefined, 'TrueScore ');
  item.setAttribute('href', '#');
  item.style.cssText = 'display:block;color:inherit;text-decoration:none;font-size:0.9em';
  item.title = `Net loved: 5★ minus 1★, over all ${addCommas(total)} reviews`;
  item.append(el('b', undefined, addCommas(score)), ` · ${Math.round(nps)}% net loved`);
  item.addEventListener('click', (e) => {
    e.preventDefault();
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return item;
};

(async function main() {
  const code = storeCode();
  const tabs = document.querySelector('[data-hc="product-tabs"][data-hc-id]');
  const id = tabs?.getAttribute('data-hc-id');
  if (!code || !id) return;

  const bundle = await fetchReviews(code, id);
  const scored = computeScore(bundle);
  if (!scored || scored.total < 5) return;

  // Just above HelpfulCrowd's reviews tabs, which its script fills from inside.
  const panel = createIslandShell();
  panel.append(...buildGauge(scored));
  buildReviewPanel(panel, {
    key: `helpfulcrowd-summary-${code}-${id}`,
    total: bundle.reviews.length,
    all: bundle.reviews,
    text: (r: HcReview) => (r.body.length < MIN_REVIEW_CHARS ? '' : r.body),
    card: (r: HcReview) => ({ rating: r.rating, body: r.body }),
    exampleQuery: 'size OR quality',
  });
  const lineScore = buildLineScore(scored, panel);
  // Themes re-render the sections these sit in (Wear The Peace redraws its
  // recommendations around the tabs), so the same nodes go back in when wiped.
  const place = () => {
    if (!panel.isConnected) document.querySelector(`[data-hc="product-tabs"][data-hc-id="${id}"]`)?.before(panel);
    if (!lineScore.isConnected) document.querySelector(`[data-hc="product-summary"][data-hc-id="${id}"]`)?.after(lineScore);
  };
  place();
  new MutationObserver(place).observe(document.body, { childList: true, subtree: true });
})();
