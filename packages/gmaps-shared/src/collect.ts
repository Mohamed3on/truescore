import {
  buildListReq,
  buildTokenReq,
  parseReviewsResponse,
  scorePct,
  type Locale,
  type MapsCreds,
  type MapsReq,
  type Review,
  type SortKey,
} from './index';

// One transport per package — googleFetch (proxy + cookies) on the server, a
// tab-session fetch in the extension. The shared loop never knows which; the
// optional AbortSignal lets a caller (the extension) pause a sort to free the
// shared google.com connection for highlight fetches.
export type Transport = (url: string, init?: { signal?: AbortSignal; method?: string; body?: string; headers?: Record<string, string> }) => Promise<string>;

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
  reqFor: (cursor: string) => MapsReq,
  transport: Transport,
  opts: CollectOptions = {},
): Promise<{ reviews: Review[]; nextCursor: string | null }> {
  const { startCursor = '', maxPages = Infinity, stabilize = false, signal, onPage } = opts;
  const collected = new Map<string, Review>();
  let cursor = startCursor;
  let lastPct: number | null = null;
  for (let index = 0; index < maxPages; index++) {
    const { url, init } = reqFor(cursor);
    const { reviews, nextCursor } = parseReviewsResponse(await transport(url, { signal, ...init }));
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

// creds are required, not optional: the legacy GET endpoint is retired, so every
// sort/token fetch replays the batchexecute RPC with a captured, session-bound
// bgkey. The type enforces it — callers resolve creds before calling. (Review
// search isn't here: the two packages own their own search builder.)
export type ShareOptions = CollectOptions & { locale?: Locale; creds: MapsCreds };

const withHl = (creds: MapsCreds, locale?: Locale): MapsCreds => ({ ...creds, hl: creds.hl ?? locale?.hl });

export function collectSort(featureId: string, sort: SortKey, transport: Transport, opts: ShareOptions) {
  const { locale, creds, ...rest } = opts;
  const c2 = withHl(creds, locale);
  return collectPaged((c) => buildListReq(featureId, sort, c2, c), transport, { stabilize: true, ...rest });
}

export async function collectToken(featureId: string, token: string, transport: Transport, opts: ShareOptions): Promise<Review[]> {
  const { locale, creds, ...rest } = opts;
  const c2 = withHl(creds, locale);
  const { reviews } = await collectPaged((c) => buildTokenReq(featureId, token, c2, c), transport, { maxPages: 30, ...rest });
  return reviews;
}

// OR-search fan-out: run one paged search per term in parallel and union the
// results, deduped by reviewId — the kernel both packages' search paths would
// otherwise duplicate above collectPaged (cf. collectToken). The caller passes
// `reqFor(term, cursor)` (a batchexecute request with its captured creds baked
// in). `onMerged`, if given, fires after every page with the running union so a
// caller can stream progress; the union grows incrementally from each page, and
// the snapshot spread is paid only when a caller is listening. A plain
// (single-term) query is just the N=1 case.
export async function collectSearchTerms(
  terms: string[],
  reqFor: (term: string, cursor: string) => MapsReq,
  transport: Transport,
  onMerged?: (merged: Review[]) => void,
): Promise<Review[]> {
  const union = new Map<string, Review>();
  await Promise.all(
    terms.map((term) =>
      collectPaged((c) => reqFor(term, c), transport, {
        maxPages: 30,
        onPage: (_running, { pageReviews }) => {
          for (const r of pageReviews) union.set(r.reviewId, r);
          onMerged?.([...union.values()]);
        },
      }),
    ),
  );
  return [...union.values()];
}
