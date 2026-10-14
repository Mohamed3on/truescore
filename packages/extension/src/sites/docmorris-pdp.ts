import { afterHydration } from '../shared/utils';
import { DOCMORRIS, setupBazaarvoicePdp } from '../shared/bazaarvoice';

// A product page is `/<slug>/<PZN>`, and the PZN doubles as the BazaarVoice
// product id. Category pages nest two slugs deep too, but never end in digits.
const productIdFromUrl = () => location.pathname.match(/^\/[^/]+\/(\d{8,})\/?$/)?.[1] ?? null;

setupBazaarvoicePdp(DOCMORRIS, {
  productId: productIdFromUrl,
  // The stars and their "(277)" under the title.
  ratingLine: () => document.querySelector('[data-testid="product-data"] [role="img"][aria-label*="Sternen"]')?.parentElement ?? null,
  // Below the buy box, so the pack choice and add-to-cart stay where DocMorris
  // puts them; under the title row when a product has no buy box.
  panelAnchor: () => {
    const block = (selector: string) =>
      document.querySelector(`[data-testid="product-data"] ${selector}`)?.closest('[data-testid="product-data"] > *');
    const node = block('[data-testid="add-to-cart-cta"]') ?? block('[data-testid="title"]');
    return node ? { node, position: 'after' } : null;
  },
  exampleQuery: 'Nebenwirkungen OR Geschmack',
  // Next.js server-renders the page: written to before React hydrates it, React
  // throws the markup away and renders the page again.
  ready: afterHydration(),
});
