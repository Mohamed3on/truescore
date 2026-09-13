import { textReviewsFor, type RemovedReviews, type Review } from '@truescore/gmaps-shared';
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

// `removedReviews` is Google's takedown notice for the place, when either end
// has read one: the model reads the reviews that SURVIVED the takedowns, so it
// needs to know the set is filtered before it calls the place a safe bet.
export type Subject = { placeName: string; reviewTexts: string[]; removedReviews?: RemovedReviews };

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
  /** The caller's own read of Google's takedown notice (the extension's live tab). */
  removedReviews?: RemovedReviews | null;
  /** What the caller should do about it, appended to the error. */
  hint: string;
};

export const resolveSubject = ({ entry, name, reviewTexts, reviews, removedReviews, hint }: SubjectRequest): Subject => {
  const texts = reviewTexts ?? (reviews ? textReviewsFor(reviews) : null);
  if (!texts?.length) throw new NoReviews(hint);
  // The body's notice is the live tab's read and wins; the cached preview meta
  // covers the web caller, which only ever sends a featureId.
  const removed = removedReviews ?? entry?.meta?.removedReviews;
  return { placeName: entry?.name ?? name ?? '', reviewTexts: texts, ...(removed ? { removedReviews: removed } : {}) };
};

// The prompt line that tells the model the review set is survivor-only. Google
// discloses only a bucket ("21 to 50"), never which reviews went. The UI already
// shows Google's banner, so the model speaks of it only when reviewers
// themselves corroborate it. Empty when there is no notice, so the prompts
// append it unconditionally.
export const removalNote = (removed: RemovedReviews | undefined): string => {
  if (!removed) return '';
  return `Google notes "${removed.text}" for this place. Businesses request these takedowns, so the surviving reviews skew positive; weigh them accordingly. Don't mention the removals unless reviewers themselves describe deleted reviews or an owner going after critics — the reader already sees Google's notice.`;
};

/** 404 for a missing subject; everything else stays a 400 as before. */
export const errStatus = (e: unknown): number => (e instanceof NoReviews ? e.status : 400);
