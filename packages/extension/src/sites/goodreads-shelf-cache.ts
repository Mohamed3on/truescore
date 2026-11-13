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

/** The data a Goodreads page was rendered from (its Apollo cache); null when it carries none. */
type Ref = { __ref: string };

/** The fields read here off the cache's entries: the root query, a book, its shelving, a review. */
type PageEntity = {
  __typename?: string;
  getUser?: Ref;
  legacyId?: number;
  viewerShelving?: Ref | null;
  shelf?: { name: string } | null;
  review?: Ref | null;
  rating?: number;
};

export type PageState = Partial<Record<string, PageEntity>>;

const pageState = (root: ParentNode): PageState | null => {
  try {
    return JSON.parse(root.querySelector('#__NEXT_DATA__')?.textContent || '{}').props?.pageProps?.apolloState ?? null;
  } catch {
    return null;
  }
};

/**
 * Goodreads' shelf-page ratings are the signed-in viewer's "My rating" values,
 * so every cache containing them (or decisions derived from them) is account-scoped.
 * The page's own data names the viewer (ROOT_QUERY.getUser, absent when signed out):
 * its header no longer links them, and the user links a book page does have are reviewers'.
 */
export const goodreadsViewerCacheScope = (root: ParentNode): string => {
  const id = pageState(root)?.ROOT_QUERY?.getUser?.__ref?.match(/^User:(\d+)$/)?.[1];

  return id ? `user-${id}` : 'anonymous';
};

export type ShelfStatus = 'read' | 'to-read' | 'reading' | 'dnf' | 'other' | null;

/** The viewer's own shelf for a book, and their stars for it (0 when unrated). */
export type ViewerShelving = { status: ShelfStatus; myRating: number };

/** Goodreads' own exclusive shelves, by the name its shelf button shows; any other is one the viewer made. */
const SHELF_BY_NAME = new Map<string, ShelfStatus>([
  ['Read', 'read'],
  ['Want to Read', 'to-read'],
  ['Currently Reading', 'reading'],
  ['Did Not Finish', 'dnf'],
]);

/** Goodreads' own exclusive shelves, by the name its page data gives them. */
const SHELF_BY_SLUG = new Map<string, ShelfStatus>([
  ['read', 'read'],
  ['to-read', 'to-read'],
  ['currently-reading', 'reading'],
  ['did-not-finish', 'dnf'],
]);

/**
 * The viewer's shelf and stars for a book page's own book as the page was served, from its
 * data, not its markup, which Goodreads redesigns. Null when the data doesn't hold the book.
 */
export const viewerShelvingFromPageData = (root: ParentNode, bookId: string): ViewerShelving | null => {
  const state = pageState(root);
  const book = Object.values(state ?? {}).find((v) => v?.__typename === 'Book' && String(v.legacyId) === bookId);

  if (!state || !book) return null;
  const shelving = state[book.viewerShelving?.__ref ?? ''];

  if (!shelving) return { status: null, myRating: 0 };

  return { status: SHELF_BY_SLUG.get(shelving.shelf?.name ?? '') ?? 'other', myRating: state[shelving.review?.__ref ?? '']?.rating || 0 };
};

/**
 * The same once the viewer changes them on the page, as its shelf button ("Shelved
 * as 'Read'. Tap to edit…", or "Tap to shelve…" when it's on none) and its quarter-star slider
 * (aria-valuenow, 0 when unrated) show them now. Null until both are there: the stars render
 * on hydration. Reviewers' stars sit outside the book's actions.
 */
export const readViewerShelving = (root: ParentNode): ViewerShelving | null => {
  const shelf = root
    .querySelector('.BookActions button[aria-label^="Shelved as "], .BookActions button[aria-label^="Tap to shelve"]')
    ?.getAttribute('aria-label');

  const stars = root.querySelector('.BookActions [role="slider"]')?.getAttribute('aria-valuenow');

  if (!shelf || stars == null) return null;
  const name = shelf.match(/^Shelved as '(.+)'\./)?.[1];

  return { status: name ? (SHELF_BY_NAME.get(name) ?? 'other') : null, myRating: Number(stars) || 0 };
};
