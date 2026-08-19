import { test, expect, describe } from 'bun:test';
import {
  statsForReviews,
  overallPctFromHistogram,
  overallScoreFromHistogram,
  removedCountEstimate,
  scoreWithRemovalPenalty,
  type Review,
} from './index';

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
  test('counts each removed review as a trusted 1-star review', () => {
    // 80% across 40 trusted reviews = +32 net; 21 assumed 1★ removals => 11 / 61.
    expect(scoreWithRemovalPenalty(0.8, 40, 21)).toBeCloseTo(11 / 61);
  });

  test('does not adjust a score without trusted reviews or removals', () => {
    expect(scoreWithRemovalPenalty(0.8, 0, 21)).toBe(0.8);
    expect(scoreWithRemovalPenalty(0.8, 40, 0)).toBe(0.8);
  });

  test('cannot drive the score past the -1..1 net-polarity scale', () => {
    expect(scoreWithRemovalPenalty(-1, 5, 10_000)).toBe(-1);
  });
});

describe('removedCountEstimate', () => {
  test('penalises on the midpoint of Google\'s bucket, not its floor', () => {
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
