import {
  PAGE_SIZE,
  parseOrQuery,
  statsForReviews,
  collectSort,
  collectToken,
  collectPaged,
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

// `query` may use the Gmail-style ` OR ` operator. Each term becomes its own
// Google search, run in parallel; results merge + dedup by reviewId so the
// score reflects reviews matching ANY term. A plain query is the single-term
// case and behaves exactly as before. `onPage` fires after every page from any
// term with the merged running set, so the streamed count climbs across terms.
export async function fetchAllForSearch(
  featureId: string,
  query: string,
  onPage?: SortPageCallback,
): Promise<Review[]> {
  const terms = parseOrQuery(query);
  const running: Review[][] = terms.map(() => []);
  const merged = (): Review[] => {
    const m = new Map<string, Review>();
    for (const rs of running) for (const r of rs) m.set(r.reviewId, r);
    return [...m.values()];
  };
  const settled = await Promise.all(
    terms.map((term, i) =>
      collectPaged((c) => buildUrlForSearch(featureId, term, c), transport, {
        maxPages: 30,
        onPage: (rs) => { running[i] = rs; onPage?.('relevant', merged()); },
      }),
    ),
  );
  settled.forEach((res, i) => { running[i] = res.reviews; });
  return merged();
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
    const merged = new Map<string, Review>();
    for (const r of [...latestRelevant, ...latestNewest]) merged.set(r.reviewId, r);
    const all = [...merged.values()];
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
  const merged = new Map<string, Review>();
  for (const r of [...relevant, ...newest]) merged.set(r.reviewId, r);
  const all = [...merged.values()];
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
