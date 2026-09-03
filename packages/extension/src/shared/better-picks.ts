import { adjust } from './recency';

// "Is there something similar that beats this?" — TrueScore's own question, and
// until now it had two answers.
//
// Letterboxd folded score and recency into one number and compared that.
// Goodreads ran two independent gates: score >= refScore, then recency >=
// refRecency. They disagree in both directions — a book that scores far higher
// on a slightly worse recent run passes Letterboxd's rule and fails Goodreads',
// and vice versa. The folded number is the one the domain is named after
// (recent-adjusted), and it is the one comparable quantity, so it wins.
//
// Discovery stays per-site: which candidates to consider, how far to crawl, and
// how to fetch each one's score is genuinely different (a popular-films list vs
// a Goodreads shelf). So does presentation — Letterboxd folds the losers into a
// disclosure and keeps an ignore drawer, Goodreads strikes them through inline.
// This module owns only the verdict, which is the part that should never differ.

export type Candidate<T> = {
  /** Stable id, for the caller to map results back to its own rows. */
  key: string;
  item: T;
  /** The candidate's own Score. */
  score: number;
  /** Its recent ratio (−1..1), or null when we could not measure it. */
  ratio: number | null;
  /**
   * The candidate's Score itself never resolved. It keeps the benefit of the
   * doubt and passes — we can't claim it loses to something we never measured.
   * An unresolved *recency* is different: the score is known, so the comparison
   * is real and simply can't be met.
   */
  unresolved?: boolean;
};

export type Reference = { score: number; ratio: number | null };

export type RankedPick<T> = Candidate<T> & {
  /** score x ratio, or null when either input is unknown. */
  adjusted: number | null;
  passes: boolean;
};

export type Ranking<T> = {
  /**
   * The number to beat, or null when the reference's own recency never resolved
   * — in which case nothing is judged rather than everything passing a 0.
   */
  threshold: number | null;
  /** Every candidate, best adjusted first; unknown sorts last. */
  ranked: RankedPick<T>[];
  passed: RankedPick<T>[];
  beaten: RankedPick<T>[];
};

export const rankPicks = <T>(reference: Reference, candidates: Candidate<T>[]): Ranking<T> => {
  const threshold = adjust(reference.score, reference.ratio);
  const ranked = candidates
    .map((c): RankedPick<T> => {
      const adjusted = adjust(c.score, c.ratio);
      const passes = threshold == null
        ? false
        : c.unresolved
          ? true
          : adjusted != null && adjusted >= threshold;
      return { ...c, adjusted, passes };
    })
    .sort((a, b) => (b.adjusted ?? -Infinity) - (a.adjusted ?? -Infinity));

  return {
    threshold,
    ranked,
    passed: ranked.filter((p) => p.passes),
    beaten: ranked.filter((p) => !p.passes),
  };
};

/**
 * A candidate whose Score alone can't reach the threshold can't qualify however
 * good its recent run is — the adjusted score never exceeds the score — so its
 * recency fetch can be skipped rather than proved. With no threshold there is
 * nothing to prefilter against and everything stays in.
 */
export const couldReach = (threshold: number | null, score: number, unresolved = false): boolean =>
  unresolved || threshold == null || score >= threshold;
