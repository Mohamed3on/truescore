// The Asia-Pacific shops run their own storefront, whose review routes answer in
// the EU routes' shapes. Their `range` is inclusive and can't be empty, so the
// stats come with one review.
const APAC = new Set(['co.th', 'sg', 'my', 'ph', 'co.id', 'vn', 'com.hk', 'tw', 'co.kr', 'co.jp', 'com.au', 'com.kh']);

// Malta runs Decathlon's PrestaShop storefront ("oneshop"). Its review route
// answers in the EU routes' shapes, wrapped in `data`, but counts pages from 1, and
// `page=1` redirects into a failed fetch, so the first page leaves it out.
const ONESHOP = new Set(['mt']);

// Their rating line, the same on listing tiles and product pages.
export const APAC_RATING = '[data-testid="productHitReviewStarBox"]';

export const getDecathlonSite = () => {
  const m = location.hostname.match(/\bdecathlon\.([a-z.]+)$/);

  if (!m) return null;
  const locale = document.documentElement.lang || 'en-US';
  const api = `https://www.decathlon.${m[1]}/api`;

  if (APAC.has(m[1])) {
    const reviews = (sku: string, from: number, to: number) =>
      `${api}/product/reviews/all?isDecathlonProduct=true&productIdentifier=${sku}&localeUnderscore=${locale.replace('-', '_')}&range=${from}-${to}`;

    return {
      apac: true,
      oneshop: false,
      statsUrl: (sku: string) => reviews(sku, 0, 0),
      reviewsUrl: (sku: string, size: number, page: number) => reviews(sku, page * size, (page + 1) * size - 1),
    };
  }

  if (ONESHOP.has(m[1])) {
    const reviews = (sku: string, size: number, page: number) =>
      `https://www.decathlon.${m[1]}/module/oneshop_reviews/api?action=load&modelCode=${sku}&nbItemsPerPage=${size}${page ? `&page=${page + 1}` : ''}`;

    return { apac: false, oneshop: true, statsUrl: (sku: string) => reviews(sku, 1, 0), reviewsUrl: reviews };
  }

  const reviews = (sku: string) => `${api}/reviews/${locale}/reviews-stats/${sku}/product`;

  return {
    apac: false,
    oneshop: false,
    statsUrl: (sku: string) => `${reviews(sku)}?nbItemsPerPage=0&page=0`,
    reviewsUrl: (sku: string, size: number, page: number) => `${reviews(sku)}?nbItemsPerPage=${size}&page=${page}&sortBy=DATE`,
  };
};

export type DecathlonSite = NonNullable<ReturnType<typeof getDecathlonSite>>;

// URL pattern: /{locale}/p/{slug}/{productId}/{variantSku}
// `sku` (last segment, trailing digits) is what the reviews-stats API
// accepts. `productId` (parent code, second-to-last segment) is shared
// across color/size variants — use it for cache keys so all variants of
// the same product hit one cache entry. Falls back to sku when no parent
// segment is present, as on the Asia-Pacific shops: …/p/{slug}-{sku}.html. Their
// reviews API takes only 7-digit model codes (older 6-digit ones get a 400, on the
// host's own page too), and a marketplace item ends in a UUID instead.
export const extractDecathlonIds = (
  href: string = location.href,
): { productId: string; sku: string } | null => {
  let path: string;

  try { path = new URL(href, location.href).pathname; }
  catch { return null; }

  const i = path.indexOf('/p/');

  if (i < 0) return null;
  const parts = path.slice(i + 3).split('/').filter(Boolean);
  const last = parts.at(-1) ?? '';
  const sku = (last.match(/(\d{5,})$/) ?? last.match(/-(\d{7})\.html$/))?.[1];

  if (!sku) return null;
  const prev = parts.at(-2) ?? '';
  const productId = /^\d{5,}$/.test(prev) ? prev : sku;

  return { productId, sku };
};

// The product page's ids. A oneshop URL (/p/{supermodel}-{attribute}-{slug}.html)
// doesn't carry the model code its reviews are filed under; its variant picker does.
export const pageDecathlonIds = () => {
  const model = document.querySelector('os-product-variants')?.getAttribute('model-id');

  return model ? { productId: model, sku: model } : extractDecathlonIds();
};
