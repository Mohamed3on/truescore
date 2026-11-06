import { addCommas, el } from '../shared/utils';
import { PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';
import { buildReviewPanel } from '../shared/review-panel';
import { buildGauge, createIslandShell, type IslandScore } from '../shared/score-island';
import { computeScore, loadReviews, reviewToText, tatamiStore, type ProductInfo, type ReviewBundle, type StampedReview } from '../shared/stamped';

// Tatami's reviews pool across a product's family — its colours, its men's,
// ladies' and kids' cuts — the same pool its own stars count.
const SUMMARY_PROMPT = `${PRODUCT_SUMMARY_PROMPT}

This is BJJ apparel. Treat fit and sizing as first-class: when reviewers agree on how it runs, give the concrete tip (e.g. "Runs small — size up if you're between sizes"). Reviews are prefixed with the size the reviewer bought when known — anchor sizing advice to those sizes and to any height and weight reviewers give. Reviews cover the product's whole family; those for another colour or cut (ladies', kids') are prefixed with that product — keep cut-specific sizing advice tied to its cut. Fold any care tips reviewers mention (shrinkage, washing, drying) into the conclusion.`;

// A review's variant is the size bought, unless it only names a product.
const sizeOf = (r: StampedReview) => (r.productVariantName !== r.productName && !r.productVariantName?.includes(' - ') && r.productVariantName) || '';

const buildPanel = (info: ProductInfo, bundle: ReviewBundle, scored: IslandScore, autoSummarize: boolean | Promise<boolean>) => {
  const otherProduct = (r: StampedReview) => (r.productName !== info.name && r.productName) || '';

  const toText = (r: StampedReview) => {
    const text = reviewToText(r);
    const tags = [otherProduct(r) && `Product: ${otherProduct(r)}`, sizeOf(r) && `Size: ${sizeOf(r)}`].filter(Boolean);

    return text && tags.length ? `[${tags.join(' | ')}] ${text}` : text;
  };

  const wrapper = createIslandShell();
  wrapper.append(...buildGauge(scored));
  // The fetched sample is all a Search reaches.
  buildReviewPanel(wrapper, {
    key: `tatami-summary-${info.id}`,
    total: bundle.reviews.length,
    all: bundle.reviews,
    text: toText,
    card: (r) => ({ rating: r.reviewRating, title: r.reviewTitle, body: r.reviewMessage, meta: [otherProduct(r), sizeOf(r) && `Size ${sizeOf(r)}`].filter(Boolean).join(' · ') }),
    exampleQuery: 'shrink OR size',
    summaryPrompt: SUMMARY_PROMPT,
    autoSummarize,
  });

  return wrapper;
};

// One more item on the theme's stars line under the title; a click goes to the panel.
const buildLineScore = ({ score, nps, total }: IslandScore, panel: HTMLElement) => {
  const item = el('a', undefined, ' · TrueScore ');
  item.setAttribute('href', '#');
  item.style.cssText = 'color:inherit;text-decoration:none;font-size:13px';
  item.title = `Net loved: 5★ minus 1★, over all ${addCommas(total)} reviews`;
  item.append(el('b', undefined, addCommas(score)), ` · ${Math.round(nps)}% net loved`);
  item.addEventListener('click', (e) => {
    e.preventDefault();
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  return item;
};

(async function main() {
  const store = tatamiStore(location.host);
  const top = document.querySelector('section.product-view .container-fluid');

  if (!store || !top) return;
  // Stamped's widget, which names the product, is drawn late, so ask Shopify.
  const res = await fetch(`${location.pathname.replace(/\/$/, '')}.js`).catch(() => null);

  if (!res?.ok) return;
  // SAFETY: Shopify's product .js endpoint answers with the product's id, title and handle.
  const product = await res.json() as { id: number; title: string; handle: string };
  const count = document.querySelector('.product-view__rating-stars')?.getAttribute('title')?.match(/out of (\d+)/)?.[1];
  const info: ProductInfo = { id: String(product.id), sku: product.handle, name: product.title, count: count ? Number(count) : undefined };

  loadReviews(store, info, (bundle, autoSummarize) => {
    const scored = computeScore(bundle);

    if (!scored || scored.total < 5) return;
    document.querySelector('.ars-wrapper')?.remove();
    document.querySelector('.ts-tatami-line')?.remove();
    const panel = buildPanel(info, bundle, scored, autoSummarize);
    top.prepend(panel);
    const line = buildLineScore(scored, panel);
    line.classList.add('ts-tatami-line');
    const stars = document.querySelector<HTMLElement>('.product-view__rating');
    // The stars are a block: lay the line out as a row so the score sits beside them.
    stars?.style.setProperty('display', 'flex');
    stars?.style.setProperty('align-items', 'center');
    stars?.style.setProperty('gap', '4px');
    stars?.append(line);
  });
})();
