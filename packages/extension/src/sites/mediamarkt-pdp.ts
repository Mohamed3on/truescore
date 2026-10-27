import { afterHydration } from '../shared/utils';
import { MEDIAMARKT, SATURN, setupBazaarvoicePdp } from '../shared/bazaarvoice';

// MediaMarkt and Saturn run one shop. A product page is `/de/product/_<slug>-<id>.html`,
// and the id doubles as the BazaarVoice product id.
const productIdFromUrl = () => location.pathname.match(/\/product\/[^/]*-(\d+)\.html$/)?.[1] ?? null;

setupBazaarvoicePdp(location.hostname.endsWith('saturn.de') ? SATURN : MEDIAMARKT, {
  productId: productIdFromUrl,
  // The stars and review count under the title.
  ratingLine: () => document.querySelector('[data-test="mms-select-details-header"] a[href="#reviews"]')?.parentElement ?? null,
  // Under the add-to-basket row (not a bundle card's or the sticky bar's).
  panelAnchor: () => {
    const node = document.querySelector('#pdp-add-to-cart-button')?.parentElement?.parentElement;

    return node ? { node, position: 'after' } : null;
  },
  exampleQuery: 'Bild OR Ton',
  // The page is server-rendered React: written to before it hydrates, React renders it again.
  ready: afterHydration(),
});
