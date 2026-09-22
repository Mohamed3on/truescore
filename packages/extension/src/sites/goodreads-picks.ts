/**
 * A book's average, shrunk toward its shelf's as if `weight` typical ratings were
 * mixed in. A new book's first ratings come from its fans: 4.86 from seven readers
 * gated the non-fiction shelf at 4.56, whose top hundred books peak at 4.5, and left
 * one better pick. In the thousands of ratings the shrink is invisible; with no
 * shelf average to lean on the book's own stands.
 */
export const shrunkAverage = (avg: number, count: number, shelfAvg: number | null, weight: number): number =>
  shelfAvg === null ? avg : (avg * count + shelfAvg * weight) / (count + weight);
