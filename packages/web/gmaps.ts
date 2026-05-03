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

async function fetchSort(featureId: string, sort: SortKey): Promise<Review[]> {
  const collected = new Map<string, Review>();
  let cursor = '';
  let lastPct: number | null = null;
  for (let pageIdx = 0; ; pageIdx++) {
    const text = await googleFetch(buildListUrl(featureId, sort, cursor));
    const { reviews, nextCursor } = parseReviewsResponse(text);
    if (!reviews.length) break;
    for (const r of reviews) collected.set(r.reviewId, r);
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

export async function fetchAllForSearch(featureId: string, query: string): Promise<Review[]> {
  const collected = new Map<string, Review>();
  let cursor = '';
  for (let i = 0; i < TOKEN_MAX_PAGES; i++) {
    const text = await googleFetch(buildUrlForSearch(featureId, query, cursor));
    const { reviews, nextCursor } = parseReviewsResponse(text);
    if (!reviews.length) break;
    for (const r of reviews) collected.set(r.reviewId, r);
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

export async function scorePlace(featureId: string): Promise<ScoreResult> {
  const [relevant, newest] = await Promise.all([
    fetchSort(featureId, 'relevant'),
    fetchSort(featureId, 'newest'),
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
