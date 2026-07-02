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
import { getMapsCreds, onStaleRpc, onFreshRpc } from './maps-creds';
import { logEvent } from './events';

export type { Review, SortKey, SortStats };

// A self-contained log throttle: the returned fn is true at most once per
// interval and owns its own cursor, so a scrape's fan-out of stale/no-creds
// pages logs one line, not dozens.
const throttle = (ms: number) => {
  let last = 0;
  return (): boolean => {
    const now = Date.now();
    if (now - last <= ms) return false;
    last = now;
    return true;
  };
};
const staleLog = throttle(30_000);
const noCredsLog = throttle(30_000);
const warnNoCreds = (where: string): void => {
  if (noCredsLog()) console.warn(`[maps-creds] no session seeded — ${where} serving empty; reseed by opening a Google Maps tab`);
};

// A [null,…,true] payload is NOT a reliable dead-session signal: it's also what
// Google returns on a transient throttle, and a plain retry on a fresh proxy exit
// usually recovers it (verified — a single retry brought a "stale" session back).
// So on the stale shape we retry a couple times (the rotating gateway hands out a
// new IP per request) before concluding the session is actually expired. Only
// then do we trigger a renewal. This turns the common case — a throttle blip that
// used to surface as empty/0% and spawn a doomed headless mint — into a silent
// self-recovery, and the rpc-recovered / rpc-stale-final events tell the two apart.
const STALE_RETRY_ATTEMPTS = 2;

// The server's transport: proxy + cookies + retry all live in googleFetch. We
// also sniff each batchexecute body for the expired-session shape (POST
// batchexecute only — preview GETs don't exercise the session). No abort path —
// the server never pauses a sort.
const transport: Transport = async (url, init) => {
  let body = await googleFetch(url, init);
  if (init?.method !== 'POST') return body;
  if (!isStaleReviewsResponse(body)) { onFreshRpc(); return body; }
  // stale shape — could be a transient throttle; retry before believing it
  for (let attempt = 1; attempt <= STALE_RETRY_ATTEMPTS; attempt++) {
    logEvent('rpc-stale', { attempt });
    await Bun.sleep(300 * attempt); // brief backoff; the retry lands on a fresh exit IP
    body = await googleFetch(url, init);
    if (!isStaleReviewsResponse(body)) {
      onFreshRpc();
      logEvent('rpc-recovered', { attempt }); // throttle, not expiry — no renewal needed
      return body;
    }
  }
  // still stale after retries → treat as a genuinely expired session
  onStaleRpc();
  logEvent('rpc-stale-final', { attempts: STALE_RETRY_ATTEMPTS + 1 });
  if (staleLog()) console.warn('[maps-creds] session looks expired after retries — Google returned empty payloads; renewing…');
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

  let lastEmit = 0;
  const emit = () => {
    if (!onProgress) return;
    // Coalesce: each page from either sort would otherwise re-merge + re-stat the
    // whole running set (O(n) × pages ≈ O(n²)). These numbers are cosmetic
    // progress — the authoritative final score is returned below — so cap the
    // recompute at ~once / 250ms; the trailing pages settle into the `score` event.
    const now = Date.now();
    if (now - lastEmit < 250) return;
    lastEmit = now;
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
