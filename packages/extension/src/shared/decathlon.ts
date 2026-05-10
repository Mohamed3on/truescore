export const getDecathlonSite = () => {
  const m = location.hostname.match(/\bdecathlon\.([a-z.]+)$/);
  if (!m) return null;
  const locale = document.documentElement.lang || 'en-US';
  return { tld: m[1], locale };
};

// URL pattern: /{locale}/p/{slug}/{productId}/{variantSku}
// `sku` (last segment, trailing digits) is what the reviews-stats API
// accepts. `productId` (parent code, second-to-last segment) is shared
// across color/size variants — use it for cache keys so all variants of
// the same product hit one cache entry. Falls back to sku when no parent
// segment is present.
export const extractDecathlonIds = (
  href: string = location.href,
): { productId: string; sku: string } | null => {
  let path: string;
  try { path = new URL(href, location.href).pathname; }
  catch { return null; }
  const i = path.indexOf('/p/');
  if (i < 0) return null;
  const parts = path.slice(i + 3).split('/').filter(Boolean);
  const sku = parts.at(-1)?.match(/(\d{5,})$/)?.[1];
  if (!sku) return null;
  const prev = parts.at(-2) ?? '';
  const productId = /^\d{5,}$/.test(prev) ? prev : sku;
  return { productId, sku };
};
