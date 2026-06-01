import {
  PAGE_SIZE,
  parseOrQuery,
  mergeByReviewId,
  statsForReviews,
  collectSort,
  collectToken,
  collectSearchTerms,
  type Review,
  type SortKey,
  type SortStats,
  type Transport,
} from '@truescore/gmaps-shared';
import { googleFetch } from './browser';

export type { Review, SortKey, SortStats };

// The server's transport: proxy + cookies + retry all live in googleFetch. It
// has no abort path — the server never pauses a sort — so the signal goes unused.
const transport: Transport = googleFetch;

// Web search pb encoding — intentionally separate from the extension's (the two
// reverse-engineered different slots; see the gmaps-shared note). Cursor rides
// only the !2s slot here.
const buildUrlForSearch = (featureId: string, query: string, cursor = '') => {
  const pb = [
    `!1m7!1s${featureId}!3s${encodeURIComponent(query)}!6m4!4m1!1e1!4m1!1e3`,
    `!2m2!1i${PAGE_SIZE}!2s${encodeURIComponent(cursor)}`,
    `!5m2!1s!7e81`,
    `!8m9!2b1!3b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1`,
    `!11m4!1e3!2e1!6m1!1i2`,
    `!13m1!1e1`,
  ].join('');
  return `https://www.google.com/maps/rpc/listugcposts?authuser=0&hl=en&gl=&pb=${pb}`;
};

// Called once after every page lands so the caller can emit interim state.
// `reviews` is the running accumulator (deduped), not just the latest page.
export type SortPageCallback = (sort: SortKey, reviews: Review[]) => void;

export type ScoreResult = {
  featureId: string;
  totalReviews: number;
  trustedReviews: number;
  scorePct: number;
  relevant: SortStats;
  newest: SortStats;
  reviews: Review[];
};

export type PartialScore = Omit<ScoreResult, 'reviews'>;

// Callback receives a fully merged snapshot (relevant ∪ newest, deduped) after
// every page from either sort. Suitable for streaming `score-progress` events.
export type ScoreProgressCallback = (partial: PartialScore) => void;

// `query` may use the Gmail-style ` OR ` operator: each term becomes its own
// Google search, fanned out + merged by reviewId in collectSearchTerms so the
// score reflects reviews matching ANY term. A plain query is the single-term
// case. `onPage` streams the merged running set so the count climbs across terms.
export function fetchAllForSearch(
  featureId: string,
  query: string,
  onPage?: SortPageCallback,
): Promise<Review[]> {
  return collectSearchTerms(
    parseOrQuery(query),
    (term, c) => buildUrlForSearch(featureId, term, c),
    transport,
    onPage ? (merged) => onPage('relevant', merged) : undefined,
  );
}

export async function fetchAllForToken(featureId: string, token: string): Promise<Review[]> {
  return collectToken(featureId, token, transport);
}

export async function scorePlace(
  featureId: string,
  onProgress?: ScoreProgressCallback,
): Promise<ScoreResult> {
  let latestRelevant: Review[] = [];
  let latestNewest: Review[] = [];

  const emit = () => {
    if (!onProgress) return;
    const all = mergeByReviewId(latestRelevant, latestNewest);
    const m = statsForReviews(all);
    onProgress({
      featureId,
      totalReviews: m.totalReviews,
      trustedReviews: m.trustedReviews,
      scorePct: m.scorePct,
      relevant: statsForReviews(latestRelevant),
      newest: statsForReviews(latestNewest),
    });
  };

  const [relevant, newest] = await Promise.all([
    collectSort(featureId, 'relevant', transport, { onPage: (rs) => { latestRelevant = rs; emit(); } }).then((r) => r.reviews),
    collectSort(featureId, 'newest', transport, { onPage: (rs) => { latestNewest = rs; emit(); } }).then((r) => r.reviews),
  ]);
  const all = mergeByReviewId(relevant, newest);
  const m = statsForReviews(all);
  return {
    featureId,
    totalReviews: m.totalReviews,
    trustedReviews: m.trustedReviews,
    scorePct: m.scorePct,
    relevant: statsForReviews(relevant),
    newest: statsForReviews(newest),
    reviews: all,
  };
}
