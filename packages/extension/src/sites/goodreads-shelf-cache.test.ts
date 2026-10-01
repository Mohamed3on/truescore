import { describe, expect, test } from 'bun:test';
import { goodreadsViewerCacheScope, readViewerShelving, shelfScoreCacheTtl } from './goodreads-shelf-cache';

const DAY_MS = 24 * 60 * 60 * 1000;
const THRESHOLD = -2;

describe('shelfScoreCacheTtl', () => {
  test('refreshes a shelf one point from the threshold after a week', () => {
    expect(shelfScoreCacheTtl(-3, THRESHOLD)).toBe(7 * DAY_MS);
  });

  test('keeps increasingly decisive results longer', () => {
    expect(shelfScoreCacheTtl(-6, THRESHOLD)).toBe(30 * DAY_MS);
    expect(shelfScoreCacheTtl(-11, THRESHOLD)).toBe(90 * DAY_MS);
    expect(shelfScoreCacheTtl(-20, THRESHOLD)).toBe(365 * DAY_MS);
  });

  test('uses distance from the threshold on either side', () => {
    expect(shelfScoreCacheTtl(-1, THRESHOLD)).toBe(7 * DAY_MS);
    expect(shelfScoreCacheTtl(3, THRESHOLD)).toBe(30 * DAY_MS);
    expect(shelfScoreCacheTtl(8, THRESHOLD)).toBe(90 * DAY_MS);
    expect(shelfScoreCacheTtl(16, THRESHOLD)).toBe(365 * DAY_MS);
  });
});

describe('goodreadsViewerCacheScope', () => {
  test('uses the authenticated profile-navigation user id', () => {
    document.body.innerHTML = `
      <a class="dropdown__trigger--profileMenu" href="https://www.goodreads.com/user/show/123-reader">Profile</a>
    `;
    expect(goodreadsViewerCacheScope(document)).toBe('user-123');
  });

  test('uses the signed-in reader attached to the book-page review CTA', () => {
    document.body.innerHTML = `
      <article class="WriteReviewCTA">
        <a class="Avatar Avatar--medium" href="/user/show/456-reader">My profile</a>
      </article>
      <article class="ReviewCard">
        <a class="Avatar Avatar--medium" href="/user/show/999-reviewer">Reviewer</a>
      </article>
    `;
    expect(goodreadsViewerCacheScope(document)).toBe('user-456');
  });

  test('does not mistake a reviewer link for the authenticated viewer', () => {
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
