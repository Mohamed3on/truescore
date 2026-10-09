const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A shelf's verdict flips only once the viewer's ratings carry its score across the
 * threshold, and at a couple of books a month that's at most ~2 points a month: a score
 * `distance` points away holds for distance × 15 days (a week at the threshold, where
 * Goodreads reshuffling the shelf alone can flip it). Decisive scores, over 10 away, stay
 * a year — rating a book on its page re-scores the cached shelves it tops anyway.
 */
export const shelfScoreCacheTtl = (score: number, threshold: number): number => {
  const distance = Math.abs(score - threshold);
  return (distance > 10 ? 365 : Math.max(7, distance * 15)) * DAY_MS;
};

/**
 * Goodreads' shelf-page ratings are the signed-in viewer's "My rating" values,
 * so every cache containing them (or decisions derived from them) is account-scoped.
 * The page's own data names the viewer (ROOT_QUERY.getUser, absent when signed out):
 * its header no longer links them, and the user links a book page does have are reviewers'.
 */
export const goodreadsViewerCacheScope = (root: ParentNode): string => {
  try {
    const data = JSON.parse(root.querySelector('#__NEXT_DATA__')?.textContent || '{}');
    const id = data.props?.pageProps?.apolloState?.ROOT_QUERY?.getUser?.__ref?.match(/^User:(\d+)$/)?.[1];
    return id ? `user-${id}` : 'anonymous';
  } catch {
    return 'anonymous';
  }
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
