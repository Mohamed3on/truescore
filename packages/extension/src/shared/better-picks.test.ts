import { test, expect, describe } from 'bun:test';
import { couldReach, rankPicks, type Candidate } from './better-picks';

const c = (key: string, score: number, ratio: number | null, unresolved = false): Candidate<string> =>
  ({ key, item: key, score, ratio, unresolved });

describe('rankPicks', () => {
  test('the threshold is the reference folded to one number', () => {
    expect(rankPicks({ score: 1000, ratio: 0.5 }, []).threshold).toBe(500);
  });

  test('a candidate passes on its adjusted score, not on score alone', () => {
    // 2000 x 0.2 = 400, under the 500 threshold: a big score on a bad recent
    // run loses. Goodreads' two-gate rule passed this book.
    const { passed, beaten } = rankPicks({ score: 1000, ratio: 0.5 }, [c('big-but-fading', 2000, 0.2)]);
    expect(passed).toHaveLength(0);
    expect(beaten.map((p) => p.key)).toEqual(['big-but-fading']);
  });

  test('and a smaller score on a strong recent run wins', () => {
    // 700 x 0.9 = 630 >= 500. Goodreads' first gate (score >= refScore) rejected
    // this one outright.
    const { passed } = rankPicks({ score: 1000, ratio: 0.5 }, [c('small-but-hot', 700, 0.9)]);
    expect(passed.map((p) => p.key)).toEqual(['small-but-hot']);
  });

  test('equal to the threshold passes', () => {
    expect(rankPicks({ score: 1000, ratio: 0.5 }, [c('exact', 500, 1)]).passed).toHaveLength(1);
  });

  test('no reference recency judges nothing rather than passing everything', () => {
    // The Letterboxd bug in its final form: an unknown reference used to fold to
    // 0, and then every candidate cleared it.
    const r = rankPicks({ score: 1000, ratio: null }, [c('a', 10, 0.1), c('b', 5000, 0.9)]);
    expect(r.threshold).toBeNull();
    expect(r.passed).toHaveLength(0);
    expect(r.beaten).toHaveLength(2);
  });

  test("a candidate we couldn't measure the recency of loses, it isn't guessed", () => {
    const { passed, ranked } = rankPicks({ score: 1000, ratio: 0.5 }, [c('no-recent', 9000, null)]);
    expect(passed).toHaveLength(0);
    expect(ranked[0]!.adjusted).toBeNull();
  });

  test('a candidate whose own score never resolved keeps the benefit of the doubt', () => {
    const { passed } = rankPicks({ score: 1000, ratio: 0.5 }, [c('score-failed', 0, null, true)]);
    expect(passed.map((p) => p.key)).toEqual(['score-failed']);
  });

  test('ordered by adjusted score, unknown last', () => {
    const { ranked } = rankPicks({ score: 100, ratio: 0.5 }, [
      c('mid', 100, 0.6), c('unknown', 900, null), c('best', 100, 0.9), c('worst', 100, 0.1),
    ]);
    expect(ranked.map((p) => p.key)).toEqual(['best', 'mid', 'worst', 'unknown']);
  });

  test('a negative recent run gives a negative adjusted score, below anything positive', () => {
    const { ranked, passed } = rankPicks({ score: 100, ratio: 0.5 }, [c('hated', 900, -0.4), c('ok', 100, 0.6)]);
    expect(ranked[1]!.key).toBe('hated');
    expect(passed.map((p) => p.key)).toEqual(['ok']);
  });
});

describe('couldReach', () => {
  test('skips a candidate whose score alone cannot reach the threshold', () => {
    expect(couldReach(500, 400)).toBe(false);
    expect(couldReach(500, 500)).toBe(true);
  });

  test('keeps everything when there is no threshold, or the score is unknown', () => {
    expect(couldReach(null, 1)).toBe(true);
    expect(couldReach(500, 0, true)).toBe(true);
  });
});
