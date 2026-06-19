import {
  buildSearchReq,
  expandSearchTerms,
  isStaleReviewsResponse,
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
import { getMapsCreds, markSessionStale, markSessionFresh } from './maps-creds';

export type { Review, SortKey, SortStats };

// One throttle for the session-health warnings: a scrape fans out dozens of
// requests, so an unthrottled stale/no-creds session would log a line per page.
const HEALTH_LOG_INTERVAL_MS = 30_000;
let lastStaleLog = 0;
let lastNoCredsLog = 0;
const throttledNow = (last: number): number | null => {
  const now = Date.now();
  return now - last > HEALTH_LOG_INTERVAL_MS ? now : null;
};
const warnNoCreds = (where: string): void => {
  const now = throttledNow(lastNoCredsLog);
  if (now === null) return;
  lastNoCredsLog = now;
  console.warn(`[maps-creds] no session seeded — ${where} serving empty; reseed by opening a Google Maps tab`);
};

// The server's transport: proxy + cookies + retry all live in googleFetch. We
// also sniff each batchexecute body for the expired-session shape and warn once,
// so a stale seed shows up as "session expired" in the logs instead of a silent
// run of empties. No abort path — the server never pauses a sort.
const transport: Transport = async (url, init) => {
  // Update session health from the actual review-RPC outcome (POST batchexecute
  // only — preview GETs don't exercise the session), which drives the reseed
  // banner and the headless self-renewal. Two failure modes both mean a dead
  // bgkey: a 200 "expired" payload, and a 4xx that googleFetch throws on after
  // retries. A valid reply marks it fresh again.
  let body: string;
  try {
    body = await googleFetch(url, init);
  } catch (e) {
    if (init?.method === 'POST') markSessionStale();
    throw e;
  }
  if (init?.method === 'POST') {
    if (isStaleReviewsResponse(body)) {
      markSessionStale();
      const now = throttledNow(lastStaleLog);
      if (now !== null) {
        lastStaleLog = now;
        console.warn('[maps-creds] session looks expired — Google returned an empty RPC payload; reviews/highlights read empty until renewal (open a Maps tab if it persists)');
      }
    } else {
      markSessionFresh();
    }
  }
  return body;
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
  if (!creds) { warnNoCreds('search'); return Promise.resolve([]); }
  return collectSearchTerms(
    expandSearchTerms(query),
    (term, c) => buildSearchReq(featureId, term, creds, c),
    transport,
    onPage ? (merged) => onPage('relevant', merged) : undefined,
  );
}

export async function fetchAllForToken(featureId: string, token: string): Promise<Review[]> {
  const creds = getMapsCreds();
  if (!creds) { warnNoCreds('token'); return []; }
  // A token fetch coming back empty while the list path works is the recurring
  // highlights failure. A stale session is already flagged by the transport, so
  // a *non-stale* empty — a token Google accepted but returned nothing for — is
  // the regression canary worth a line. Log structure only (place, public chip
  // token, body length), never the raw response payload.
  let lastRaw = '';
  const tap: Transport = async (url, init) => (lastRaw = await transport(url, init));
  const reviews = await collectToken(featureId, token, tap, { creds });
  if (!reviews.length && !isStaleReviewsResponse(lastRaw)) {
    console.warn(`[token] 0 reviews (non-stale) featureId=${featureId} token=${token} rawLen=${lastRaw.length}`);
  }
  return reviews;
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
    warnNoCreds('scorePlace');
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
