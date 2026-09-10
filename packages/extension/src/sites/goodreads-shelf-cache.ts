const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ratings far from the acceptance threshold are unlikely to change the shelf
 * decision soon. Borderline scores get revisited quickly; decisive scores can
 * stay cached for up to a year.
 */
export const shelfScoreCacheTtl = (score: number, threshold: number): number => {
  const distance = Math.abs(score - threshold);
  if (distance <= 1) return 7 * DAY_MS;
  if (distance <= 5) return 30 * DAY_MS;
  if (distance <= 10) return 90 * DAY_MS;
  return 365 * DAY_MS;
};

/**
 * Goodreads' shelf-page ratings are the signed-in viewer's "My rating" values,
 * so every cache containing them (or decisions derived from them) is account-scoped.
 * Only inspect authenticated identity surfaces: book pages also contain reviewer links.
 */
export const goodreadsViewerCacheScope = (root: ParentNode): string => {
  const profile = root.querySelector<HTMLAnchorElement>(
    '.dropdown__trigger--profileMenu[href*="/user/show/"], .personalNavDrawer__profileContainer a[href*="/user/show/"], .WriteReviewCTA a.Avatar[href*="/user/show/"]',
  );
  const id = profile?.href.match(/\/user\/show\/(\d+)/)?.[1];
  return id ? `user-${id}` : 'anonymous';
};
