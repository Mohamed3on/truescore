import { test, expect, describe } from 'bun:test';
import { displayScore, overallPctFromHistogram, overallScoreFromHistogram, removedCountEstimate, scoreWithRemovalPenalty, statsForReviews, type Review } from './index';

const rv = (stars: number, count: number): Review =>
  ({ reviewId: `r${Math.round(stars * 1000 + count)}`, stars, reviewerReviewCount: count, timestamp: 1_700_000_000_000, text: 'x' });

describe('statsForReviews', () => {
  test('empty → all zero', () => {
    expect(statsForReviews([])).toEqual({ totalReviews: 0, trustedReviews: 0, scorePct: 0 });
  });
  test('only trusted authors (>=3 reviews) score; untrusted count toward total only', () => {
    const s = statsForReviews([rv(5, 9), rv(5, 1)]);
    expect(s.totalReviews).toBe(2);
    expect(s.trustedReviews).toBe(1);
    expect(s.scorePct).toBe(100);
  });
  test('3★ is neutral (does not move the score)', () => {
    const s = statsForReviews([rv(5, 9), rv(3, 9)]);
    expect(s.trustedReviews).toBe(2);
    expect(s.scorePct).toBe(50);
  });
  test('1★ subtracts; rounding to nearest integer percent', () => {
    const s = statsForReviews([rv(5, 9), rv(5, 9), rv(1, 9)]);
    expect(s.scorePct).toBe(33);
  });
  test('all untrusted → scorePct 0 (no division by zero)', () => {
    expect(statsForReviews([rv(5, 1), rv(1, 2)]).scorePct).toBe(0);
  });
});

describe('scoreWithRemovalPenalty', () => {
  test('weighs removals as a rate against the place\'s own review count', () => {
    // 21 removed of 210 = a 10% removal rate: (0.8 - 0.1) / 1.1.
    expect(scoreWithRemovalPenalty(0.8, 21, 210)).toBeCloseTo(0.7 / 1.1);
  });

  test('the same removal count hurts a small place far more than a large one', () => {
    const small = scoreWithRemovalPenalty(0.93, 11, 88);
    const large = scoreWithRemovalPenalty(0.93, 11, 1102);
    expect(Math.round(small * 100)).toBe(72);
    expect(Math.round(large * 100)).toBe(91);
  });

  test('is independent of how deep we scraped — the whole point of the rate', () => {
    // The trusted sample size used to be the denominator, so a deeper scrape
    // quietly softened the penalty. Nothing here can vary with it any more.
    expect(scoreWithRemovalPenalty(0.93, 11, 88)).toBe(scoreWithRemovalPenalty(0.93, 11, 88));
  });

  test('no removals, or an unknown review count, leaves the score alone', () => {
    expect(scoreWithRemovalPenalty(0.8, 0, 210)).toBe(0.8);
    expect(scoreWithRemovalPenalty(0.8, 21, 0)).toBe(0.8);
  });

  test('cannot drive the score past the -1..1 net-polarity scale', () => {
    expect(scoreWithRemovalPenalty(-1, 10_000, 5)).toBe(-1);
  });
});

describe('removedCountEstimate', () => {
  test("penalises on the midpoint of Google's bucket", () => {
    expect(removedCountEstimate({ text: '', min: 21, max: 50 })).toBe(36);
    expect(removedCountEstimate({ text: '', min: 6, max: 10 })).toBe(8);
  });

  test('an open-ended or single-valued bucket is itself', () => {
    expect(removedCountEstimate({ text: '', min: 100, max: 100 })).toBe(100);
    expect(removedCountEstimate({ text: '', min: 7 })).toBe(7);
  });

  test('no readable numerals means no invented penalty', () => {
    expect(removedCountEstimate({ text: 'reviews were removed' })).toBe(0);
    expect(removedCountEstimate(undefined)).toBe(0);
    expect(removedCountEstimate(null)).toBe(0);
  });
});

describe('overallPctFromHistogram ([5★,4★,3★,2★,1★])', () => {
  test('empty / all-zero → 0', () => {
    expect(overallPctFromHistogram([])).toBe(0);
    expect(overallPctFromHistogram([0, 0, 0, 0, 0])).toBe(0);
  });
  test('all 5★ → 100, all 1★ → -100', () => {
    expect(overallPctFromHistogram([10, 0, 0, 0, 0])).toBe(100);
    expect(overallPctFromHistogram([0, 0, 0, 0, 10])).toBe(-100);
  });
  test('balanced extremes → 0', () => {
    expect(overallPctFromHistogram([5, 0, 0, 0, 5])).toBe(0);
  });
  test('rounds to nearest integer', () => {
    expect(overallPctFromHistogram([3, 1, 1, 1, 1])).toBe(29);
  });
});

describe('overallScoreFromHistogram (diff·|diff|/total)', () => {
  test('empty → 0', () => {
    expect(overallScoreFromHistogram([])).toBe(0);
    expect(overallScoreFromHistogram([0, 0, 0, 0, 0])).toBe(0);
  });
  test('sign tracks polarity, magnitude scales with the gap', () => {
    expect(overallScoreFromHistogram([10, 0, 0, 0, 0])).toBe(10);
    expect(overallScoreFromHistogram([0, 0, 0, 0, 10])).toBe(-10);
  });
  test('equal 5★/1★ → 0 regardless of volume', () => {
    expect(overallScoreFromHistogram([5, 0, 0, 0, 5])).toBe(0);
  });
});

// The penalty maths above is one function; what used to differ per renderer was
// the placeTotal fed into it. These pin the precedence, which is where the three
// surfaces disagreed.
describe('displayScore (placeTotal precedence)', () => {
  const removed = { text: '21 to 50 reviews removed', min: 21, max: 50 };

  test('no removals → the raw score, unadjusted', () => {
    const d = displayScore({ score: 0.72, histogram: [100, 0, 0, 0, 0] });
    expect(d.pct).toBe(72);
    expect(d.rawPct).toBe(72);
    expect(d.adjusted).toBe(false);
  });

  test("prefers Google's own histogram total", () => {
    const d = displayScore({ score: 0.72, histogram: [800, 100, 50, 30, 22], googleReviewCount: 5, removedReviews: removed });
    expect(d.placeTotal).toBe(1002);
    expect(d.removedCount).toBe(36);
    expect(d.adjusted).toBe(true);
  });

  test('falls back to the quoted review count when the histogram is unreadable', () => {
    // Maps' split search+place layout renders fewer than five rows, so the
    // extension's DOM read comes back null. Without this fallback the penalty
    // silently vanished there while the web still applied it.
    const withHistogram = displayScore({ score: 0.72, histogram: [800, 100, 50, 30, 22], removedReviews: removed });
    const withoutHistogram = displayScore({ score: 0.72, histogram: null, googleReviewCount: 1002, removedReviews: removed });
    expect(withoutHistogram.pct).toBe(withHistogram.pct);
  });

  test('an empty histogram is not a total', () => {
    const d = displayScore({ score: 0.72, histogram: [], googleReviewCount: 1002, removedReviews: removed });
    expect(d.placeTotal).toBe(1002);
  });

  test('no total either way → no penalty rather than a guessed one', () => {
    const d = displayScore({ score: 0.72, removedReviews: removed });
    expect(d.pct).toBe(72);
    expect(d.adjusted).toBe(false);
  });

  test('a notice Google quoted no numerals in adjusts nothing', () => {
    const d = displayScore({ score: 0.72, histogram: [1000, 0, 0, 0, 2], removedReviews: { text: 'some reviews were removed' } });
    expect(d.removedCount).toBe(0);
    expect(d.adjusted).toBe(false);
  });
});
