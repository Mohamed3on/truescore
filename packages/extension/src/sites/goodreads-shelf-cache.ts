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

export type ShelfStatus = 'read' | 'to-read' | 'reading' | 'dnf' | 'other' | null;

/** The viewer's own shelf for a book, and their stars for it (0 when unrated). */
export type ViewerShelving = { status: ShelfStatus; myRating: number };

/** Goodreads' own exclusive shelves, by the name its shelf button shows; any other is one the viewer made. */
const SHELF_BY_NAME: Record<string, ShelfStatus> = {
  'Read': 'read',
  'Want to Read': 'to-read',
  'Currently Reading': 'reading',
  'Did Not Finish': 'dnf',
};

/**
 * The viewer's shelf and stars for a book page's own book, as its shelf button ("Shelved
 * as 'Read'. Tap to edit…", or "Tap to shelve…" when it's on none) and its stars ("Rating
 * 2 out of 5") show them now. Null until both are there: the stars render on hydration.
 * Reviewers' stars sit outside the book's actions.
 */
export const readViewerShelving = (root: ParentNode): ViewerShelving | null => {
  const shelf = root
    .querySelector('.BookActions button[aria-label^="Shelved as "], .BookActions button[aria-label^="Tap to shelve"]')
    ?.getAttribute('aria-label');
  const stars = root.querySelector('.BookActions [aria-label^="Rating "]')?.getAttribute('aria-label')?.match(/^Rating (\d) out of 5$/);
  if (!shelf || !stars) return null;
  const name = shelf.match(/^Shelved as '(.+)'\./)?.[1];
  return { status: name ? (SHELF_BY_NAME[name] ?? 'other') : null, myRating: Number(stars[1]) };
};
