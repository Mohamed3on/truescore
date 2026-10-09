import { describe, expect, test } from 'bun:test';
import { goodreadsViewerCacheScope, readViewerShelving, shelfScoreCacheTtl } from './goodreads-shelf-cache';

const DAY_MS = 24 * 60 * 60 * 1000;
const THRESHOLD = -2;

describe('shelfScoreCacheTtl', () => {
  test('refreshes a shelf at the threshold after a week', () => {
    expect(shelfScoreCacheTtl(-2, THRESHOLD)).toBe(7 * DAY_MS);
  });

  test('keeps a score 15 days per point from the threshold, a year once decisive', () => {
    expect(shelfScoreCacheTtl(-3, THRESHOLD)).toBe(15 * DAY_MS);
    expect(shelfScoreCacheTtl(-6, THRESHOLD)).toBe(60 * DAY_MS);
    expect(shelfScoreCacheTtl(-12, THRESHOLD)).toBe(150 * DAY_MS);
    expect(shelfScoreCacheTtl(-13, THRESHOLD)).toBe(365 * DAY_MS);
  });

  test('uses distance from the threshold on either side', () => {
    expect(shelfScoreCacheTtl(-1, THRESHOLD)).toBe(15 * DAY_MS);
    expect(shelfScoreCacheTtl(3, THRESHOLD)).toBe(75 * DAY_MS);
    expect(shelfScoreCacheTtl(16, THRESHOLD)).toBe(365 * DAY_MS);
  });
});

describe('goodreadsViewerCacheScope', () => {
  const page = (rootQuery: object) => {
    document.body.innerHTML = `
      <article class="ReviewCard"><a class="Avatar Avatar--medium" href="/user/show/999-reviewer">Reviewer</a></article>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apolloState: { ROOT_QUERY: rootQuery } } } })}</script>
    `;
    return goodreadsViewerCacheScope(document);
  };

  test("uses the signed-in viewer the page's own data names", () => {
    expect(page({ __typename: 'Query', getUser: { __ref: 'User:123' } })).toBe('user-123');
  });

  test('does not mistake a reviewer link for the viewer when signed out', () => {
    expect(page({ __typename: 'Query' })).toBe('anonymous');
  });

  test('is anonymous on a page without its data', () => {
    document.body.innerHTML = '<main><a href="/user/show/999-reviewer">Reviewer</a></main>';
    expect(goodreadsViewerCacheScope(document)).toBe('anonymous');
  });
});

describe('readViewerShelving', () => {
  const page = (shelf: string, stars?: string) => {
    document.body.innerHTML = `
      <div class="BookActions">
        <button aria-label="${shelf}"></button>
        <button aria-label="More options to get the book, Menu pop up"></button>
        ${stars ? `<div class="BookRatingStars"><span aria-label="${stars}" role="group"><button aria-label="Rate 1 out of 5"></button></span></div>` : ''}
      </div>
      <article class="ReviewCard"><span aria-label="Rating 5 out of 5"></span></article>
    `;
    return readViewerShelving(document);
  };

  test("reads Goodreads' own shelves and the viewer's stars", () => {
    expect(page("Shelved as 'Read'. Tap to edit shelf for this book", 'Rating 2 out of 5')).toEqual({ status: 'read', myRating: 2 });
    expect(page("Shelved as 'Currently Reading'. Tap to edit shelf for this book", 'Rating 0 out of 5')).toEqual({ status: 'reading', myRating: 0 });
    expect(page("Shelved as 'Want to Read'. Tap to edit shelf for this book", 'Rating 0 out of 5')).toEqual({ status: 'to-read', myRating: 0 });
    expect(page("Shelved as 'Did Not Finish'. Tap to edit shelf for this book", 'Rating 1 out of 5')).toEqual({ status: 'dnf', myRating: 1 });
  });

  test("files a shelf the viewer made as another shelf, and none as unshelved", () => {
    expect(page("Shelved as 'Didn't grab me'. Tap to edit shelf for this book", 'Rating 0 out of 5')).toEqual({ status: 'other', myRating: 0 });
    expect(page('Tap to shelve book as want to read', 'Rating 0 out of 5')).toEqual({ status: null, myRating: 0 });
  });

  test("waits for the book's own stars, never a reviewer's", () => {
    expect(page("Shelved as 'Read'. Tap to edit shelf for this book")).toBeNull();
  });
});
