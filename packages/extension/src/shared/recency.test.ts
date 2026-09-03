import { test, expect, describe } from 'bun:test';
import { adjust, FIVE_STAR, ratioFromTally, recentRatio, TEN_POINT } from './recency';

describe('recentRatio', () => {
  test('is the 5★-minus-1★ share of the reviews', () => {
    expect(recentRatio([5, 5, 1, 3])).toBe(0.25);
  });

  test('null when there are no reviews to judge', () => {
    expect(recentRatio([])).toBeNull();
  });

  test('can go negative when 1★ outweighs 5★', () => {
    expect(recentRatio([1, 1, 5, 2])).toBe(-0.25);
  });

  test('the middle of the scale is neither loved nor hated, but still counts', () => {
    expect(recentRatio([5, 3, 3, 3])).toBe(0.25);
  });

  test("Letterboxd's 10-point scale counts 4½★ as loved", () => {
    // 9 = four and a half stars, 10 = five, 2 = one star.
    expect(recentRatio([9, 10, 2, 6], TEN_POINT)).toBe(0.25);
    // Read on the five-star polarity the same numbers are nonsense — 6 and 9
    // both clear "loved" and nothing reaches "hated". The polarity is not a
    // detail a caller can leave to the default.
    expect(recentRatio([9, 10, 2, 6], FIVE_STAR)).toBe(0.75);
  });
});

describe('ratioFromTally', () => {
  test('folds a running tally to the same share', () => {
    expect(ratioFromTally(1, 4)).toBe(0.25);
  });

  test('null when nothing was rated — never 0', () => {
    expect(ratioFromTally(0, 0)).toBeNull();
  });
});

describe('adjust', () => {
  test('damps the score by the recent ratio, rounded', () => {
    expect(adjust(1234, 0.62)).toBe(765);
  });

  test('propagates unknown instead of collapsing it to zero', () => {
    expect(adjust(1234, null)).toBeNull();
  });

  test('an unknown ratio must not read as a beatable threshold', () => {
    // The Letterboxd Similar Picks bug: a caught fetch became a 0% recent, so
    // the threshold became 0 and every candidate cleared it. Unknown stays
    // unknown, and the caller has to decide what to do about it.
    const threshold = adjust(1234, ratioFromTally(0, 0));
    expect(threshold).toBeNull();
    expect(threshold === 0).toBe(false);
  });
});
