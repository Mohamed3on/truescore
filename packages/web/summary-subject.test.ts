import { test, expect, describe } from 'bun:test';
import { NoReviews, errStatus, resolveSubject } from './summary-subject';
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
});
