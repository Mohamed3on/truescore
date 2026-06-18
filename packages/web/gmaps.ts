import {
  buildSearchReq,
  expandSearchTerms,
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
import { getMapsCreds } from './maps-creds';

export type { Review, SortKey, SortStats };

// The server's transport: proxy + cookies + retry all live in googleFetch. It
// has no abort path — the server never pauses a sort — so the signal goes unused.
const transport: Transport = googleFetch;

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

// `query` may use the Gmail-style ` OR ` operator, and each term expands to its
// accent/hyphen/space spellings: every term becomes its own Google search,
// fanned out + merged by reviewId in collectSearchTerms so the score reflects
// reviews matching ANY spelling. `onPage` streams the merged running set so the
// count climbs across terms.
export function fetchAllForSearch(
  featureId: string,
  query: string,
  onPage?: SortPageCallback,
): Promise<Review[]> {
  const creds = getMapsCreds();
  if (!creds) return Promise.resolve([]);
  return collectSearchTerms(
    expandSearchTerms(query),
    (term, c) => buildSearchReq(featureId, term, creds, c),
    transport,
    onPage ? (merged) => onPage('relevant', merged) : undefined,
  );
}

export async function fetchAllForToken(featureId: string, token: string): Promise<Review[]> {
  const creds = getMapsCreds();
  if (!creds) return [];
  return collectToken(featureId, token, transport, { creds });
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

  const creds = getMapsCreds();
  if (!creds) {
    const z = statsForReviews([]);
    return { featureId, ...z, relevant: z, newest: z, reviews: [] };
  }
  const [relevant, newest] = await Promise.all([
    collectSort(featureId, 'relevant', transport, { creds, onPage: (rs) => { latestRelevant = rs; emit(); } }).then((r) => r.reviews),
    collectSort(featureId, 'newest', transport, { creds, onPage: (rs) => { latestNewest = rs; emit(); } }).then((r) => r.reviews),
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
