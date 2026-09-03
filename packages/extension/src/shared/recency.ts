// How positive an item's newest reviews run, and the Score damped by it.
//
// One rule, one unit, one absence contract. `recentRatio` is a signed share in
// −1..1 and `null` means "no evidence" — never "hated". `adjust` propagates that
// null instead of collapsing it to 0, and the overloads make the compiler ask
// for the branch: pass a possibly-null ratio and you get back a possibly-null
// score. Letterboxd used to return 0 for "unknown", and one failed fetch turned
// its Similar Picks threshold into 0 — every candidate then "scored higher".

/** Which ratings count as loved / hated on a site's own scale. */
export type Polarity = { positive: number; negative: number };

/** 1–5 stars: only a 5 is loved, only a 1 is hated. */
export const FIVE_STAR: Polarity = { positive: 5, negative: 1 };

/** Letterboxd's 10-point half-star scale: 4½★ and 5★ are loved, ½★ and 1★ hated. */
export const TEN_POINT: Polarity = { positive: 9, negative: 2 };

/**
 * Net loved-minus-hated over the ratings given, as a share in −1..1.
 * Null when there is nothing to judge. Callers filter the corpus first (a date
 * window, unrated entries); everything passed in counts toward the denominator.
 */
export const recentRatio = (ratings: number[], p: Polarity = FIVE_STAR): number | null => {
  if (!ratings.length) return null;
  let net = 0;
  for (const rating of ratings) {
    if (rating >= p.positive) net++;
    else if (rating <= p.negative) net--;
  }
  return net / ratings.length;
};

/**
 * The same share from an already-folded tally, for callers that accumulate
 * across paged fetches rather than holding every rating.
 */
export const ratioFromTally = (net: number, total: number): number | null =>
  total > 0 ? net / total : null;

/** The Score damped by the recent ratio. Unknown in → unknown out. */
export function adjust(score: number, ratio: number): number;
export function adjust(score: number, ratio: number | null): number | null;
export function adjust(score: number, ratio: number | null): number | null {
  return ratio == null ? null : Math.round(score * ratio);
}
