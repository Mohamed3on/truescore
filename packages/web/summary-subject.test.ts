import { test, expect, describe } from 'bun:test';
import { NoReviews, errStatus, removalNote, resolveSubject } from './summary-subject';
import type { CacheEntry } from './cache';

const entry = (name: string) => ({ name } as unknown as CacheEntry);
const review = (text: string) => ({ reviewId: text, stars: 5, reviewerReviewCount: 9, timestamp: null, text }) as any;

describe('resolveSubject', () => {
  test("the body's pre-formatted texts win over the cached reviews", () => {
    const s = resolveSubject({
      entry: entry('Cached Place'),
      reviewTexts: ['already formatted'],
      reviews: [review('from cache')],
      hint: 'x',
    });
    expect(s.reviewTexts).toEqual(['already formatted']);
  });

  test('falls back to the cached reviews, run through textReviewsFor', () => {
    const s = resolveSubject({ entry: entry('Cached Place'), reviews: [review('a real review body')], hint: 'x' });
    expect(s.reviewTexts).toHaveLength(1);
    expect(s.reviewTexts[0]).toContain('a real review body');
  });

  test('the cached name wins; the body name covers a place the server never scraped', () => {
    expect(resolveSubject({ entry: entry('Cached'), name: 'Body', reviewTexts: ['r'], hint: 'x' }).placeName).toBe('Cached');
    expect(resolveSubject({ name: 'Body', reviewTexts: ['r'], hint: 'x' }).placeName).toBe('Body');
    expect(resolveSubject({ reviewTexts: ['r'], hint: 'x' }).placeName).toBe('');
  });

  test('nothing to read is one failure with one status, whichever route asked', () => {
    // /api/highlight-summary used to answer 400 here while /api/summarize and
    // /api/ask answered 404, for the same condition.
    for (const req of [{ hint: 'a' }, { reviewTexts: [], hint: 'b' }, { entry: entry('P'), reviews: [], hint: 'c' }]) {
      expect(() => resolveSubject(req)).toThrow(NoReviews);
      try { resolveSubject(req); } catch (e) { expect(errStatus(e)).toBe(404); }
    }
  });

  test('every other failure stays a 400', () => {
    expect(errStatus(new Error('upstream blew up'))).toBe(400);
  });

  test("the body's takedown notice wins; the cached preview meta covers a featureId-only caller", () => {
    const fromTab = { text: '21 to 50 reviews removed due to defamation complaints.', min: 21, max: 50 };
    const fromCache = { text: 'Six to ten reviews removed due to defamation complaints.', min: 6, max: 10 };
    const cached = { name: 'P', meta: { removedReviews: fromCache } } as unknown as CacheEntry;
    expect(resolveSubject({ entry: cached, reviewTexts: ['r'], removedReviews: fromTab, hint: 'x' }).removedReviews).toEqual(fromTab);
    expect(resolveSubject({ entry: cached, reviewTexts: ['r'], hint: 'x' }).removedReviews).toEqual(fromCache);
    // The extension sends null for "no notice on this place" — that must not
    // mask a notice the server itself has seen.
    expect(resolveSubject({ entry: cached, reviewTexts: ['r'], removedReviews: null, hint: 'x' }).removedReviews).toEqual(fromCache);
  });

  test('no notice anywhere leaves the subject without one', () => {
    expect(resolveSubject({ entry: entry('P'), reviewTexts: ['r'], removedReviews: null, hint: 'x' })).not.toHaveProperty('removedReviews');
  });
});

describe('removalNote', () => {
  test('empty without a notice, so prompts can append it unconditionally', () => {
    expect(removalNote(undefined)).toBe('');
  });

  test("quotes Google's fuller sentence when there is one, else the short line", () => {
    const short = '21 to 50 reviews removed due to defamation complaints.';
    const detail = 'In the past year, 21 to 50 reviews were removed from this place due to defamation complaints.';
    expect(removalNote({ text: short, detail })).toContain(`"${detail}"`);
    expect(removalNote({ text: short, detail })).not.toContain(`"${short}"`);
    expect(removalNote({ text: short })).toContain(`"${short}"`);
  });

  test('asks the model to verify against the reviews and to hedge, not to invent', () => {
    const note = removalNote({ text: '21 to 50 reviews removed due to defamation complaints.' });
    expect(note).toMatch(/SURVIVED/);
    expect(note).toMatch(/corroborate/);
    expect(note).toMatch(/never guess at what the removed reviews said/);
  });
});
