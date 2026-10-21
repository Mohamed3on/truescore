import { afterHydration } from '../shared/utils';
import { ROSSMANN, setupBazaarvoicePdp } from '../shared/bazaarvoice';

// A product page is `/de/<slug>/p/<EAN>`, and the EAN doubles as the BazaarVoice
// product id.
const productIdFromUrl = () => location.pathname.match(/\/p\/(\d{8,})\/?$/)?.[1] ?? null;

setupBazaarvoicePdp(ROSSMANN, {
  productId: productIdFromUrl,
  // BazaarVoice's stars under the title. The title block is rendered twice, for
  // phones and for desktops, and CSS shows one: the badge joins the shown one.
  ratingLine: () =>
    [...document.querySelectorAll('[data-bv-show="rating_summary"]')].find((root) => root.checkVisibility())?.parentElement ?? null,
  // Below the quantity and add-to-cart row of the buy column (not a product
  // card's or the sticky bar's), so Rossmann's buy box stays where it is.
  panelAnchor: () => {
    let node = document.querySelector(
      '[data-testid="product-amountAndAddToCart"]:not([data-testid="product-card"] *, [data-testid="product-sticky-buy-box"] *)',
    );
    // Up to its block in the buy column, the one beside the title's.
    while (node?.parentElement && !node.parentElement.querySelector('h1')) node = node.parentElement;
    return node ? { node, position: 'after' } : null;
  },
  exampleQuery: 'Geschmack OR Konsistenz',
  // Next.js server-renders the page: written to before React hydrates it, React
  // throws the markup away and renders the page again.
  ready: afterHydration(),
});
