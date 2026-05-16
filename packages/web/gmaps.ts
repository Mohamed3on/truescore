import {
  PAGE_SIZE,
  buildListUrl,
  buildTokenUrl,
  parseReviewsResponse,
  scorePct,
  statsForReviews,
  type Review,
  type SortKey,
  type SortStats,
} from '@truescore/gmaps-shared';
import { googleFetch } from './browser';

export type { Review, SortKey, SortStats };

const MIN_PAGES_BEFORE_STABILIZE = 2;
const TOKEN_MAX_PAGES = 30;

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

async function fetchSort(featureId: string, sort: SortKey, onPage?: SortPageCallback): Promise<Review[]> {
  const collected = new Map<string, Review>();
  let cursor = '';
  let lastPct: number | null = null;
  for (let pageIdx = 0; ; pageIdx++) {
    const text = await googleFetch(buildListUrl(featureId, sort, cursor));
    const { reviews, nextCursor } = parseReviewsResponse(text);
    if (!reviews.length) break;
    for (const r of reviews) collected.set(r.reviewId, r);
    onPage?.(sort, [...collected.values()]);
    if (pageIdx + 1 >= MIN_PAGES_BEFORE_STABILIZE) {
      const pct = scorePct([...collected.values()]);
      if (lastPct !== null && Math.abs(pct - lastPct) <= 1) break;
      lastPct = pct;
    }
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return [...collected.values()];
}

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

export async function fetchAllForSearch(
  featureId: string,
  query: string,
  onPage?: SortPageCallback,
): Promise<Review[]> {
  const collected = new Map<string, Review>();
  let cursor = '';
  for (let i = 0; i < TOKEN_MAX_PAGES; i++) {
    const text = await googleFetch(buildUrlForSearch(featureId, query, cursor));
    const { reviews, nextCursor } = parseReviewsResponse(text);
    if (!reviews.length) break;
    for (const r of reviews) collected.set(r.reviewId, r);
    onPage?.('relevant', [...collected.values()]);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return [...collected.values()];
}

export async function fetchAllForToken(featureId: string, token: string): Promise<Review[]> {
  const collected = new Map<string, Review>();
  let cursor = '';
  for (let i = 0; i < TOKEN_MAX_PAGES; i++) {
    const text = await googleFetch(buildTokenUrl(featureId, token, cursor));
    const { reviews, nextCursor } = parseReviewsResponse(text);
    if (!reviews.length) break;
    for (const r of reviews) collected.set(r.reviewId, r);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return [...collected.values()];
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
    fetchSort(featureId, 'relevant', (_, reviews) => { latestRelevant = reviews; emit(); }),
    fetchSort(featureId, 'newest', (_, reviews) => { latestNewest = reviews; emit(); }),
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
