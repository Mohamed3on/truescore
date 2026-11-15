import { DM, setupBazaarvoicePdp } from '../shared/bazaarvoice';

// dm uses two PDP URL formats: legacy `...-p1298306.html` and the newer
// `/p/d/1298306/<slug>`. The id in the path is dm's routing key and doubles as
// the BazaarVoice product id, so it is the whole resolution — the slug is
// decorative (`/p/d/3087729/x` resolves fine).
const productIdFromUrl = () => {
  const match =
    location.pathname.match(/-p(\d{6,})\.html/) || location.pathname.match(/\/p\/[a-z]+\/(\d{6,})\b/);

  return match?.[1] ?? null;
};

const resolvePanelAnchor = () => {
  const ratingSummary = document.querySelector('[data-dmid="product-detail-rating-summary"]');
  const ratingBlock = ratingSummary?.closest('a')?.parentElement?.parentElement;

  if (ratingBlock) return { node: ratingBlock, position: 'after' as const };

  const buybox = document.querySelector('[data-dmid="buybox"]');

  if (buybox) return { node: buybox, position: 'before' as const };

  const reviewAnchor =
    document.querySelector('#dm_bv_container') ||
    document.querySelector('[data-bv-show="reviews"]');

  if (reviewAnchor) return { node: reviewAnchor, position: 'before' as const };

  const title = document.querySelector('[data-dmid="detail-page-headline-product-title"], h1');

  if (title) return { node: title, position: 'after' as const };

  return null;
};

// dm's product API states the base price as "0,5 kg (5,70 € je 1 kg)". Read
// there, not off the page, which Chrome Translate rewrites.
const unitPrice = async (productId: string): Promise<[string, string] | null> => {
  const res = await fetch(`https://products.dm.de/product/products/detail/DE/dan/${productId}`);
  const match = /\((.+?) je (?:1 )?(.+?)\)/.exec((await res.json())?.price?.infos?.[0] ?? '');

  return match ? [match[1], `per ${match[2]}`] : null;
};

setupBazaarvoicePdp(DM, {
  productId: productIdFromUrl,
  ratingLine: () => document.querySelector('[data-dmid="product-detail-rating-summary"]'),
  panelAnchor: resolvePanelAnchor,
  exampleQuery: 'Qualität OR Preis',
  unitPrice,
});
