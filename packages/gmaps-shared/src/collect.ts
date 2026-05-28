import {
  buildListUrl,
  buildTokenUrl,
  parseReviewsResponse,
  scorePct,
  type Locale,
  type Review,
  type SortKey,
} from './index';

// One transport per package — googleFetch (proxy + cookies) on the server, a
// tab-session fetch in the extension. The shared loop never knows which; the
// optional AbortSignal lets a caller (the extension) pause a sort to free the
// shared google.com connection for highlight fetches.
export type Transport = (url: string, init?: { signal?: AbortSignal }) => Promise<string>;

export type CollectPage = { index: number; nextCursor: string | null; pageReviews: Review[] };
// Returning 'stop' ends the loop after this page — lets a caller layer its own
// stop policy (e.g. the extension's page-1 live-head reconcile) on top.
export type OnPage = (running: Review[], page: CollectPage) => void | 'stop';

export type CollectOptions = {
  startCursor?: string;
  maxPages?: number;
  stabilize?: boolean;
  signal?: AbortSignal;
  onPage?: OnPage;
};

const MIN_PAGES_BEFORE_STABILIZE = 2;

// The kernel both packages used to duplicate: page a listugcposts cursor URL,
// dedup by reviewId, and stop on the first of — no reviews, no next cursor,
// maxPages, an onPage 'stop', or (opt-in) scorePct stabilizing within 1%. An
// aborted signal propagates as the transport's rejection; callers that pause
// catch it and keep whatever pages already landed (already surfaced via onPage).
export async function collectPaged(
  urlFor: (cursor: string) => string,
  transport: Transport,
  opts: CollectOptions = {},
): Promise<{ reviews: Review[]; nextCursor: string | null }> {
  const { startCursor = '', maxPages = Infinity, stabilize = false, signal, onPage } = opts;
  const collected = new Map<string, Review>();
  let cursor = startCursor;
  let lastPct: number | null = null;
  for (let index = 0; index < maxPages; index++) {
    const { reviews, nextCursor } = parseReviewsResponse(await transport(urlFor(cursor), { signal }));
    if (!reviews.length) break;
    for (const r of reviews) collected.set(r.reviewId, r);
    const running = [...collected.values()];
    if (onPage?.(running, { index, nextCursor, pageReviews: reviews }) === 'stop') return { reviews: running, nextCursor };
    if (stabilize && index + 1 >= MIN_PAGES_BEFORE_STABILIZE) {
      const pct = scorePct(running);
      if (lastPct !== null && Math.abs(pct - lastPct) <= 1) return { reviews: running, nextCursor };
      lastPct = pct;
    }
    if (!nextCursor) return { reviews: running, nextCursor: null };
    cursor = nextCursor;
  }
  return { reviews: [...collected.values()], nextCursor: cursor || null };
}

// Sort + token URLs are shared (buildListUrl / buildTokenUrl); review search is
// not — the two packages reverse-engineered different pb slots, so each calls
// collectPaged with its own search builder.
export type ShareOptions = CollectOptions & { locale?: Locale };

export function collectSort(featureId: string, sort: SortKey, transport: Transport, opts: ShareOptions = {}) {
  const { locale, ...rest } = opts;
  return collectPaged((c) => buildListUrl(featureId, sort, c, locale), transport, { stabilize: true, ...rest });
}

export async function collectToken(featureId: string, token: string, transport: Transport, opts: ShareOptions = {}): Promise<Review[]> {
  const { locale, ...rest } = opts;
  const { reviews } = await collectPaged((c) => buildTokenUrl(featureId, token, c, locale), transport, { maxPages: 30, ...rest });
  return reviews;
}
