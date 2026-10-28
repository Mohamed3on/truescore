import { afterHydration } from '../shared/utils';
import { MEDIAMARKT, SATURN, setupBazaarvoicePdp } from '../shared/bazaarvoice';

// MediaMarkt and Saturn run one shop. A product page is `/de/product/_<slug>-<id>.html`,
// and the id doubles as the BazaarVoice product id.
const productIdFromUrl = () => location.pathname.match(/\/product\/[^/]*-(\d+)\.html$/)?.[1] ?? null;

// The product's family, from the page's JSON-LD ProductGroup: each variant's id and
// what it varies by ("size": "65 Zoll").
const variants = () => {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const group = JSON.parse(script.textContent || 'null')?.object;

    if (group?.['@type'] !== 'ProductGroup') continue;
    const dims: string[] = group.variesBy ?? [];

    return new Map<string, [string, string][]>((group.hasVariant ?? []).map((v: Record<string, string>) =>
      [v.sku, dims.map((dim): [string, string] => [dim[0].toUpperCase() + dim.slice(1), v[dim]])]));
  }

  return new Map<string, [string, string][]>();
};

setupBazaarvoicePdp(location.hostname.endsWith('saturn.de') ? SATURN : MEDIAMARKT, {
  productId: productIdFromUrl,
  // The stars and review count under the title.
  ratingLine: () => document.querySelector('[data-test="mms-select-details-header"] a[href="#reviews"]')?.parentElement ?? null,
  // Under the price, in the buy box the add-to-basket row closes (not a bundle card's
  // or the sticky bar's): financing, services and promos push that row ~2000px down.
  panelAnchor: () => {
    const box = document.querySelector('#pdp-add-to-cart-button')?.parentElement?.parentElement?.parentElement;
    const node = [...(box?.children ?? [])].find((block) => block.querySelector('[data-test="mms-product-price"]'));

    return node ? { node, position: 'after' } : null;
  },
  exampleQuery: 'Bild OR Ton',
  variants,
  // The page is server-rendered React: written to before it hydrates, React renders it again.
  ready: afterHydration(),
});
