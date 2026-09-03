import { textReviewsFor, type Review } from '@truescore/gmaps-shared';
import type { CacheEntry } from './cache';

// What a summarize / ask call needs, resolved from one request body: who the
// place is and the review text to read.
//
// Every one of these routes is dual-mode — the web caller sends just a
// featureId and we read the cached entry; the extension sends the reviews it
// already scraped, so a place the server has never seen can still be
// summarized. Three routes each answered that in their own four lines and
// drifted on the part that a caller can actually observe: /api/summarize and
// /api/ask reject "no review text here" with 404, /api/highlight-summary with
// 400, for the same condition. One resolver, one failure, one status.

export type Subject = { placeName: string; reviewTexts: string[] };

/** The one precondition all three share: there is nothing here to read. */
export class NoReviews extends Error {
  readonly status = 404;
  constructor(hint: string) {
    super(`no review text — ${hint}`);
    this.name = 'NoReviews';
  }
}

export type SubjectRequest = {
  entry?: CacheEntry;
  /** Caller-supplied place name, used when the server has never scraped it. */
  name?: string;
  /** Pre-formatted texts from the body — the extension already ran textReviewsFor. */
  reviewTexts?: string[];
  /** Reviews to fall back on when the body shipped none. */
  reviews?: Review[];
  /** What the caller should do about it, appended to the error. */
  hint: string;
};

export const resolveSubject = ({ entry, name, reviewTexts, reviews, hint }: SubjectRequest): Subject => {
  const texts = reviewTexts ?? (reviews ? textReviewsFor(reviews) : null);
  if (!texts?.length) throw new NoReviews(hint);
  return { placeName: entry?.name ?? name ?? '', reviewTexts: texts };
};

/** 404 for a missing subject; everything else stays a 400 as before. */
export const errStatus = (e: unknown): number => (e instanceof NoReviews ? e.status : 400);
