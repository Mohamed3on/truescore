import {
  askViewOf,
  countAnswers,
  MAX_JUDGED,
  questionOf,
  statsForReviews,
  textReviewsFor,
  type AskMessage,
  type AskRequest,
  type CachedResponse,
  type Chip,
  type ChipMeta,
  type ContributeRequest,
  type ContributeResponse,
  type HighlightEvent,
  type HighlightSummaryRequest,
  type HighlightSummaryResponse,
  type HighlightsRequest,
  type HighlightsResponse,
  type HistogramRequest,
  type HistogramResponse,
  type LookupEvent,
  type LookupRequest,
  type LookupScore,
  type PlacesResponse,
  type ReceiptsRequest,
  type ReceiptsResponse,
  type SearchEvent,
  type SearchRequest,
  type StanceRequest,
  type StanceResponse,
  type Summary,
  type SummarizeRequest,
  type SummarizeResponse,
} from '@truescore/gmaps-shared';
import type { BunRequest, Serve, Server } from 'bun';
import { resolvePlace } from './resolve';
import { mapsCredsStatus, mapsSessionHealthy, onThrottledScrape, startMintTimer, renewSession } from './maps-creds';
import { scorePlace, fetchAllForSearch, type ScoreResult } from './gmaps';
import { createUIMessageStream, createUIMessageStreamResponse, isStaticToolUIPart } from 'ai';
import { summarize, ask, parseProvider, parseReasoningEffort } from './llm';
import { fetchPreviewBundle, histogramTotal, overallPctFromHistogram, type Histogram, type PreviewBundle } from './histogram';
import { harvestTokens, harvestQuick, scoreHighlight, type Harvest } from './highlights';
import { answerKey, cache, type CachedAnswer, type CacheEntry } from './cache';
import { logEvent } from './events';
import { createInflight } from './inflight';
import index from './index.html';
import login from './login.html';
import { errStatus, NoReviews, resolveSubject, type Subject } from './summary-subject';
import { answersFor, hasReceipts, jevAvailable, mentioning, preferredCount, stanceOfReviews, stancesFor, supportFor, withReceipts } from './jev';

const json = (v: any, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Extension-facing endpoints. CORS is open so any extension content script can
// reach us; we don't expose anything that could be abused as a Google-proxy on
// behalf of a drive-by site (the heavy /api/lookup path still requires a same-
// origin POST). Stateless `reviews`-in-body endpoints below also need this.
const corsJson = (v: any, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
  });
const corsOptions = () => new Response(null, {
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-truescore-key',
    'Access-Control-Max-Age': '86400',
  },
});

// A shared password keeps the API to the people it's been given to: the web app
// sends the cookie it gets by signing in at /login, the extension a header.
// Unset (local dev) leaves everything open.
const PASSWORD = process.env.TRUESCORE_PASSWORD;
const PASSWORD_COOKIE = 'truescore-key';
const authed = (req: BunRequest) =>
  !PASSWORD || req.headers.get('x-truescore-key') === PASSWORD || req.cookies.get(PASSWORD_COOKIE) === PASSWORD;

// Every /api route but its CORS preflight needs the password, so a route added
// later is locked without anyone remembering to. The seed-secret routes keep
// their own check.
const SEED_ROUTES = new Set(['/api/maps-creds', '/api/maps-creds/renew']);
type Handler = (req: BunRequest, server: Server<undefined>) => Response | Promise<Response>;
const lock = (handler: Handler): Handler => (req, server) =>
  authed(req) ? handler(req, server) : corsJson({ error: 'TrueScore password required' }, 401);
function lockApi<R extends string>(routes: Serve.Routes<undefined, R>): Serve.Routes<undefined, R> {
  const all = routes as unknown as Record<string, Handler | Record<string, Handler>>;
  for (const [path, route] of Object.entries(all)) {
    if (!path.startsWith('/api/') || SEED_ROUTES.has(path)) continue;
    if (typeof route === 'function') all[path] = lock(route);
    else for (const [method, handler] of Object.entries(route)) if (method !== 'OPTIONS') route[method] = lock(handler);
  }
  return routes;
}

// Where /session sends a signed-in browser: back to the page that sent it to
// /login, never off this site.
const nextPath = (req: Request) => {
  const next = new URL(new URL(req.url).searchParams.get('next') ?? '/', 'https://truescore.invalid');
  return next.origin === 'https://truescore.invalid' ? next.pathname + next.search : '/';
};

// Translate proxy / upstream errors into something users can act on, instead
// of surfacing raw "googleFetch 502 for https://…" strings. Unknown errors
// pass through so the chip tooltip still has useful detail in dev.
function friendlyError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const status = m.match(/googleFetch (\d+)/)?.[1];
  if (status === '429') return 'Google is throttling — try again in a moment';
  if (status === '502' || status === '522' || status === '524') return 'Google is busy upstream — try again';
  if (status === '503') return 'Google maps is unavailable right now';
  if (status && status.startsWith('5')) return `Google returned ${status} — try again`;
  if (m.includes('preview URL not found')) return "Google didn't return a preview for this place";
  return m;
}
const errBody = (e: unknown) => ({ error: friendlyError(e) });

// A kept Answer, streamed as a fresh one would be: its Searches, then its text,
// with when it was written.
const replayAnswer = ({ answer, searches, ts }: CachedAnswer) => createUIMessageStream<AskMessage>({
  execute: ({ writer }) => {
    writer.write({ type: 'start', messageMetadata: { answeredAt: ts } });
    searches.forEach(({ query, found, scorePct = 0, trustedReviews = 0 }, i) => {
      writer.write({ type: 'tool-input-available', toolCallId: `${i}`, toolName: 'searchReviews', input: { query } });
      writer.write({ type: 'tool-output-available', toolCallId: `${i}`, output: { found: found ?? 0, scorePct, trustedReviews, texts: [] } });
    });
    writer.write({ type: 'text-start', id: 'answer' });
    writer.write({ type: 'text-delta', id: 'answer', delta: answer });
    writer.write({ type: 'text-end', id: 'answer' });
  },
});
const mapsUrlFor = (featureId: string) => `https://www.google.com/maps?q=&ftid=${featureId}`;

// A Score as a lookup streams it (see LookupScore): the reviews stay here, only
// the newest one's date goes out. Google review timestamps come in microseconds.
const lookupScore = ({ reviews, ...score }: ScoreResult): LookupScore => {
  const latest = reviews.reduce((max, r) => Math.max(max, r.timestamp ?? 0), 0);
  return { ...score, latestReviewTs: latest ? (latest > 1e14 ? Math.floor(latest / 1000) : latest) : null };
};

// NDJSON streaming response. The producer pushes one JSON object per line via
// `write`; if it throws, we emit a final `{type:'error'}` event so the client
// always gets a defined terminus. The `closed` flag silently swallows writes
// after the consumer aborts so partial sends never throw downstream.
function ndjsonStream<E extends { type: string }>(producer: (write: (event: E) => void) => Promise<void>, headers?: Record<string, string>): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const enqueue = (obj: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); }
        catch { closed = true; }
      };
      // Producer writes are checked against the event union E; the catch emits
      // the `error` variant every union carries, through the untyped enqueue.
      const write: (event: E) => void = enqueue;
      try {
        await producer(write);
      } catch (e) {
        console.error('[stream]', e);
        enqueue({ type: 'error', error: friendlyError(e) });
      }
      if (!closed) controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', ...headers } });
}

const PORT = Number(process.env.PORT || 3000);

const previewInflight = createInflight<PreviewBundle>();
const revalidateInflight = createInflight<void>();
const highlightsRecomputeInflight = createInflight<void>();
const warmChipsInflight = createInflight<Harvest>();

const HIGHLIGHTS_DRIFT_THRESHOLD = 0.01;

// Get a place's topic chips: the set the lookup's preview already cached if
// present, else harvest them. The preview RPC only serves the chips ~15-20% of
// the time (random per request), but the tokens are stable, so the harvest is
// single-flight per place and persistent, and records its outcome (recordHarvest).
// `quick` leads with one quick round, for a caller that hasn't tried one. Shared by
// a cold lookup (started the moment its preview lands without chips), the
// /api/highlights background warm (fire-and-forget while the client re-polls the
// 202 `pending`) and the drift recompute, so all dedup and self-cache through one
// primitive.
function ensureChips(featureId: string, name: string, quick = false): Promise<Harvest> {
  const cached = cache.get(featureId)?.chipMeta;
  if (cached?.length) return Promise.resolve({ chips: cached, ok: true });
  return warmChipsInflight.run(featureId, async () => {
    const url = mapsUrlFor(featureId);
    const first = quick ? await harvestQuick(url) : undefined;
    const harvest = first?.chips.length ? first : await harvestTokens(url);
    await recordHarvest(featureId, harvest);
    const { chips, ok } = harvest;
    const outcome = chips.length
      ? `cached ${chips.length} chips`
      : ok
        ? 'no chips after warm — marked topic-less'
        : 'warm failed (no usable preview response) — not marked, will retry';
    console.log(`[warm-chips] ${name} (${featureId}): ${outcome}`);
    return harvest;
  });
}

// A hit caches the stable tokens, a *clean* miss stamps the entry topic-less so we
// stop re-warming it. A harvest that never got a usable preview response (proxy
// down, cookie jar expired, Google throttling) is NOT recorded: stamping it would
// sell a transient outage as "this place has no topics" for the next six hours.
// A no-op until the place has a row — see streamFreshLookup.
const recordHarvest = (featureId: string, { chips, ok }: Harvest): Promise<void> =>
  chips.length || ok ? cache.recordChipWarm(featureId, chips) : Promise.resolve();

// A chip as a lookup ships it: its counts, not its reviews or their stances.
const slimChip = ({ reviews: _r, stances: _s, ...rest }: Chip) => rest;

// Chips and summaries cached before Jev read them are read now, once, and kept —
// by /api/highlights and /api/summarize, which a lookup leaves them to (see
// streamCachedLookup), so they first paint with their counts and receipts.
async function chipsWithStance(featureId: string, chips: Chip[]): Promise<Chip[]> {
  if (!jevAvailable() || chips.every((c) => c.stance)) return chips;
  const read = await Promise.all(chips.map(async (c) => (c.stance || !c.reviews ? c : { ...c, ...(await stanceOfReviews(c.label, c.reviews)) })));
  if (read.every((c) => c.stance)) await cache.putHighlights(featureId, read);
  return read;
}
async function summaryWithReceipts(summary: Summary, subject: Subject | null, keep: (s: Summary) => Promise<void>): Promise<Summary> {
  if (hasReceipts(summary) || !subject || !jevAvailable()) return summary;
  const checked = await withReceipts(summary, subject);
  if (hasReceipts(checked)) await keep(checked);
  return checked;
}
const cachedSubject = (entry: CacheEntry, reviews = entry.score?.reviews): Subject | null =>
  reviews?.length ? { placeName: entry.name, reviewTexts: textReviewsFor(reviews), removedReviews: entry.meta?.removedReviews } : null;

// Score every chip in parallel: collect successes, count failures, and cache
// whatever succeeded. A set missing a chip that threw is stored as short, so
// it's re-scored rather than served as the place's topics (see putHighlights).
// Optional hooks let the streaming caller emit an NDJSON event as each chip resolves.
async function scoreChips(
  featureId: string,
  name: string,
  chips: ChipMeta[],
  hooks?: { onChip?: (h: Chip) => void; onError?: (chip: ChipMeta, e: unknown) => void },
): Promise<{ successes: Chip[]; failures: number; totalFetched: number; cached: boolean }> {
  const successes: Chip[] = [];
  let failures = 0;
  await Promise.all(chips.map(async (chip) => {
    try {
      const h = await scoreHighlight(featureId, chip);
      successes.push(h);
      hooks?.onChip?.(h);
    } catch (e) {
      failures++;
      console.warn(`[highlights] ${name} (${featureId}): chip "${chip.label}" failed:`, e);
      hooks?.onError?.(chip, e);
    }
  }));
  const totalFetched = successes.reduce((a, h) => a + (h.fetched ?? 0), 0);
  const cached = totalFetched > 0;
  if (cached) await cache.putHighlights(featureId, successes);
  return { successes, failures, totalFetched, cached };
}

// Always harvest chips off the canonical /maps?q=&ftid=… URL. The share-link
// redirect target carries a session fingerprint (shh/lucs/g_ep/skid) that
// pushes Google's preview RPC into A-B buckets where the chip slot is empty —
// retries thrash and sometimes give up. The bare ftid URL avoids that.
async function recomputeHighlights(featureId: string, name: string): Promise<void> {
  const { chips } = await ensureChips(featureId, name);
  if (!chips.length) return;
  const { successes, failures, totalFetched, cached } = await scoreChips(featureId, name, chips);
  const tag = `${successes.length}/${chips.length} chips, ${totalFetched} reviews${failures ? `, ${failures} failed` : ''}`;
  console.log(`[recompute-highlights] ${name} (${featureId}): ${cached ? tag : `not cached (${tag})`}`);
}

// Stale-while-revalidate: re-fetch the preview, compare its total to the
// cached `totalReviewsAtCache`, and re-score if Google has new reviews.
// Highlights are recomputed in the background only when drift exceeds 1%.
function revalidate(featureId: string, name: string, resolvedUrl: string): Promise<void> {
  return revalidateInflight.run(featureId, async () => {
    const bundle = await getOrFetchPreviewBundle(featureId).catch(() => null);
    const histogram = bundle?.histogram ?? null;
    const currentTotal = histogram ? histogramTotal(histogram) : null;
    if (currentTotal == null) return;
    const entry = cache.get(featureId);
    const prevTotal = entry?.totalReviewsAtCache;
    const hadHighlights = !!entry?.highlights?.length;
    // Skip the re-scrape when the entry is both fresh (histogram total unchanged)
    // and usable (not a throttled 0-review scrape); otherwise re-scrape.
    if (entry && cache.scoreFresh(entry, currentTotal) && cache.scoreUsable(entry, currentTotal)) return;
    const score = await scorePlace(featureId);
    // putScore returns false when it rejects a throttled (empty) scrape — keep the
    // prior entry and let the next request retry.
    if (!(await cache.putScore(featureId, name, score, currentTotal, resolvedUrl))) {
      console.warn(`[revalidate] ${name} (${featureId}): re-scrape got ${score.totalReviews} (relevant ${score.relevant.totalReviews}, newest ${score.newest.totalReviews}) vs histogram ${currentTotal} — keeping prior entry (likely throttle)`);
      logEvent('throttle', { where: 'revalidate', name, fid: featureId, histogram: currentTotal });
      onThrottledScrape();
      return;
    }
    console.log(`[revalidate] ${name}: total ${prevTotal ?? 'unset'} → ${currentTotal}, re-scored`);

    if (hadHighlights && prevTotal != null) {
      const drift = Math.abs(currentTotal - prevTotal) / prevTotal;
      // run() no-ops if a recompute is already in flight; streamCachedLookup
      // peeks the same key to await it. The catch keeps that await from throwing.
      if (drift > HIGHLIGHTS_DRIFT_THRESHOLD) {
        highlightsRecomputeInflight.run(featureId, () =>
          recomputeHighlights(featureId, name).catch((e) =>
            console.error(`[recompute-highlights] ${name} (${featureId}):`, e)));
      }
    }
  });
}

// A harvest warms for ~75-100s, and Cloudflare cuts a response idle for 100s.
const HIGHLIGHTS_HEARTBEAT_MS = 20_000;

// Chips still being harvested (a client that asked to `wait`) hold the stream open
// first, a `pending` line now and every heartbeat; a harvest that finds none ends it.
function streamHighlights(name: string, featureId: string, url: string, chips: ChipMeta[] | Promise<ChipMeta[]>): Response {
  return ndjsonStream<HighlightEvent>(async (write) => {
    if (!Array.isArray(chips)) {
      write({ type: 'pending' });
      const heartbeat = setInterval(() => write({ type: 'pending' }), HIGHLIGHTS_HEARTBEAT_MS);
      chips = await chips.finally(() => clearInterval(heartbeat));
      if (!chips.length) return;
    }
    write({ type: 'chips', chips });
    const { successes, failures, totalFetched, cached } = await scoreChips(featureId, name, chips, {
      onChip: (h) => write({ type: 'chip', highlight: h }),
      onError: (chip, e) => write({ type: 'chip-error', token: chip.token, label: chip.label, error: friendlyError(e) }),
    });
    if (!cached && failures === 0) {
      console.warn(
        `[highlights] ${name} (${featureId}): all ${chips.length} chips fetched 0 reviews ` +
          `(likely upstream throttle). chips=[${chips.map((c) => c.label).join(', ')}] url=${url}`,
      );
    }
    const tag = failures
      ? `${successes.length}/${chips.length} ok, ${failures} failed`
      : `${chips.length} chips`;
    console.log(`[highlights] ${name} (${featureId}): ${tag}, ${totalFetched} reviews${cached ? '' : ' (not cached)'}`);
    write({ type: 'done', failures, totalFetched, cached });
  });
}

// Cache-hit lookups stream NDJSON: first event is the cached payload (rendered
// instantly), then we await revalidate and emit a `refreshed` event if the
// score moved. That way the freshness label / score / histogram update in
// place without the user needing to refresh.
function streamCachedLookup(featureId: string, name: string, resolvedUrl: string, cached: CacheEntry): Response {
  void cache.touch(featureId).catch((e) => console.error('[touch]', e));
  // A throttle-shortened set is withheld rather than painted, so the client's
  // normal "no chips yet" path re-scores it instead of settling for the remnant.
  // So are chips and a summary Jev hasn't read yet: the client's no-chips and
  // no-summary paths fetch them through routes that read them first, so a star
  // share or an unchecked bullet never paints only to be replaced.
  const unread = jevAvailable();
  const slimHighlights = cache.highlightsServable(cached) && !(unread && cached.highlights!.some((h) => !h.stance)) ? cached.highlights?.map(slimChip) : undefined;
  const summary = cached.summary && !(unread && !hasReceipts(cached.summary)) ? cached.summary : undefined;
  const cachedScoreTs = cached.scoreTs ?? 0;
  const cachedHighlightsTs = cached.highlightsTs ?? 0;
  return ndjsonStream<LookupEvent>(async (write) => {
    write({
      type: 'lookup',
      name: cached.name,
      score: lookupScore(cached.score),
      summary,
      highlights: slimHighlights,
      histogram: cached.histogram,
      overallPct: cached.histogram ? overallPctFromHistogram(cached.histogram) : null,
      meta: cached.meta,
      resolvedUrl: cached.resolvedUrl ?? mapsUrlFor(featureId),
      cached: true,
    });
    try {
      await revalidate(featureId, name, resolvedUrl);
      const fresh = cache.get(featureId);
      if (fresh && (fresh.scoreTs ?? 0) > cachedScoreTs) {
        write({
          type: 'refreshed',
          name: fresh.name,
          score: lookupScore(fresh.score),
          histogram: fresh.histogram,
          overallPct: fresh.histogram ? overallPctFromHistogram(fresh.histogram) : null,
          meta: fresh.meta,
          resolvedUrl: fresh.resolvedUrl ?? mapsUrlFor(featureId),
        });
      }
      // If revalidate kicked off a highlights recompute (drift > 1%), keep
      // the stream open until it lands so the chips stay in sync with the
      // refreshed score. Recompute is in-flight only on actual drift, so
      // this path is rare and otherwise zero-cost.
      const hp = highlightsRecomputeInflight.peek(featureId);
      if (hp) {
        await hp;
        const post = cache.get(featureId);
        if (post?.highlights?.length && (post.highlightsTs ?? 0) > cachedHighlightsTs) {
          write({
            type: 'highlights-refreshed',
            highlights: post.highlights.map(slimChip),
          });
        }
      }
    } catch (e) {
      console.error('[revalidate]', e);
    }
  });
}

// Cache-miss lookups stream progressively: `place` immediately after resolve
// (so the page header swaps in), `preview` whenever the preview RPC lands
// (histogram + meta — usually well before the score scrape), `score-progress`
// after each scorePlace page (relevant/newest paginating in parallel), and
// `score` once both sorts settle. The client renders each chunk in place.
function streamFreshLookup(featureId: string, name: string, resolvedUrl: string, cached?: CacheEntry): Response {
  return ndjsonStream<LookupEvent>(async (write) => {
    write({ type: 'place', name, featureId, resolvedUrl });
    // Rehydrate: an extension already scored this place and contributed the
    // numbers, so paint them now rather than leaving the panel empty for the
    // length of a full scrape. The scrape below still runs and overwrites.
    if (cached?.contributedScore) {
      write({ type: 'provisional', score: cached.contributedScore, contributedAt: cached.contributedScoreTs ?? 0 });
    }
    const t0 = Date.now();

    // Run preview in parallel with the score scrape, but emit each as soon as
    // it lands instead of awaiting both. Preview failures degrade to a
    // null-histogram event so the client clears its loading skeleton.
    const previewPromise = getOrFetchPreviewBundle(featureId)
      .then((bundle) => {
        write({
          type: 'preview',
          histogram: bundle.histogram,
          overallPct: bundle.histogram ? overallPctFromHistogram(bundle.histogram) : null,
          meta: bundle.meta,
        });
        return bundle;
      })
      .catch((e) => {
        console.error('[preview]', e);
        write({ type: 'preview', histogram: null, overallPct: null, meta: {} });
        return { histogram: null, meta: {}, chips: [] } as PreviewBundle;
      });

    // The preview carries the topic chips only ~15-20% of the time, and harvesting
    // them otherwise waited for the whole scrape — the client asks /api/highlights
    // after `score`. Start the harvest the moment the preview lands without them,
    // wherever /api/highlights would harvest. Tokens only: scoring them stays behind
    // the score, the guard against caching a throttled or capped session's chips. A
    // harvest that lands before putScore creates the row has nothing to record into,
    // so it's recorded below.
    let harvested: Harvest | undefined;
    void previewPromise.then(({ chips }) => {
      if (chips.length || (cached && (cache.highlightsServable(cached) || cache.chipWarmedEmpty(cached)))) return;
      return ensureChips(featureId, name, true).then((h) => { harvested = h; });
    }).catch((e) => console.error(`[warm-chips] ${name} (${featureId}):`, e));

    const score = await scorePlace(featureId, (partial) => {
      write({ type: 'score-progress', score: partial });
    });
    const bundle = await previewPromise;
    const currentTotal = bundle.histogram ? histogramTotal(bundle.histogram) : null;
    // putScore rejects a throttled scrape — 0 reviews while the histogram shows
    // the place has them, or one sort empty — so the next lookup retries instead
    // of caching it. Genuinely review-less places have currentTotal 0 and still
    // cache. The client is told, so it doesn't paint the throttle as a score.
    const throttled = !(await cache.putScore(featureId, name, score, currentTotal, resolvedUrl));
    if (throttled) {
      console.warn(`[lookup] ${name} (${featureId}): scraped ${score.totalReviews} (relevant ${score.relevant.totalReviews}, newest ${score.newest.totalReviews}) but histogram has ${currentTotal} — not caching (likely throttle)`);
      logEvent('throttle', { where: 'lookup', name, fid: featureId, histogram: currentTotal });
      onThrottledScrape();
    } else if (!cached) {
      // The preview landed before putScore created this place's row, so its
      // putPreviewBundle had nothing to patch — persist it now the row exists, and
      // a chip harvest that landed first likewise.
      await cache.putPreviewBundle(featureId, bundle);
      if (harvested) await recordHarvest(featureId, harvested);
    }
    write({ type: 'score', score: lookupScore(score), fetchMs: Date.now() - t0, throttled });
  });
}

function getOrFetchPreviewBundle(featureId: string): Promise<PreviewBundle> {
  const existing = cache.get(featureId);
  if (existing?.histogram && existing.meta && cache.histogramFresh(existing)) {
    return Promise.resolve({ histogram: existing.histogram, meta: existing.meta, chips: existing.chipMeta ?? [] });
  }
  return previewInflight.run(featureId, async () => {
    const bundle = await fetchPreviewBundle(mapsUrlFor(featureId));
    await cache.putPreviewBundle(featureId, bundle);
    return bundle;
  });
}

// The hands-off mint (maps-minter): a fresh anonymous session on boot, then on a timer
// well inside the session's ~day life.
startMintTimer();

Bun.serve({
  port: PORT,
  // Bun drops a connection that sits silent for 10s by default, and an LLM call
  // routinely thinks longer than that before its first byte — prod logged the
  // drop a few times a month. Cloudflare's 100s origin read timeout is the real
  // ceiling, so outlast it rather than cut in first.
  idleTimeout: 120,
  routes: lockApi({
    '/': index,
    '/login': login,
    // The sign-in form's POST: a right password gets the cookie for a year.
    '/session': {
      POST: async (req) => {
        if ((await req.formData()).get('password') !== PASSWORD) return json({ error: 'wrong password' }, 401);
        req.cookies.set(PASSWORD_COOKIE, PASSWORD, { maxAge: 365 * 86400, httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
        return new Response(null, { status: 303, headers: { Location: nextPath(req) } });
      },
    },
    '/api/lookup': {
      POST: async (req) => {
        try {
          const { url } = await req.json() as LookupRequest;
          const { featureId, name, resolvedUrl } = await resolvePlace(url);
          const cached = cache.get(featureId);
          // A contribution-only stub (scoreTs 0) carries the extension's summary +
          // highlights but a placeholder 0-review score the server never computed.
          // Serving it cached paints "0 reviews" until revalidate lands — route it to
          // the fresh path so the score scrapes first (the contributed summary +
          // highlights still load from cache right after the score settles). A
          // throttle-cut score cached before putScore refused them goes fresh too.
          if (cached?.scoreTs && cache.scoreUsable(cached, cached.totalReviewsAtCache)) return streamCachedLookup(featureId, name, resolvedUrl, cached);
          return streamFreshLookup(featureId, name, resolvedUrl, cached);
        } catch (e) {
          console.error(`[lookup] ${e instanceof Error ? e.message : e}`);
          return json(errBody(e), 400);
        }
      },
    },
    // Session status, behind TRUESCORE_SEED_SECRET. Seeding it from the extension
    // is retired: every request is now signed by the session's own BotGuard VM
    // (maps-minter), and a session captured in someone's browser can't be signed here.
    '/api/maps-creds': {
      // Liveness probe: when was the session last seeded, how stale is it now.
      // Same secret as POST so it never leaks session-liveness publicly.
      GET: (req) => {
        const secret = process.env.TRUESCORE_SEED_SECRET;
        if (!secret) return json({ error: 'seeding disabled' }, 404);
        if (req.headers.get('x-truescore-seed') !== secret) return json({ error: 'forbidden' }, 403);
        return json(mapsCredsStatus());
      },
      POST: () => json({ error: 'seeding retired: the server mints and signs its own session' }, 410),
    },
    // Health for the web client's reseed banner: whether the server has a usable
    // Maps session right now. Just a boolean — no timing. Its 401 sends the web
    // client to /login.
    '/api/session-health': {
      GET: () => json({ healthy: mapsSessionHealthy() }),
    },
    // Force a fresh mint now (testing / manual recovery). Behind the seed secret
    // since it launches a browser through the proxy.
    '/api/maps-creds/renew': {
      POST: async (req) => {
        const secret = process.env.TRUESCORE_SEED_SECRET;
        if (!secret) return json({ error: 'seeding disabled' }, 404);
        if (req.headers.get('x-truescore-seed') !== secret) return json({ error: 'forbidden' }, 403);
        const ok = await renewSession('manual', true);
        return json({ ok, ...mapsCredsStatus() });
      },
    },
    // Read-only cache peek for the extension: returns summary/highlights/etc
    // if the place was already looked up via the web. Never triggers compute.
    '/api/cached': {
      GET: (req) => {
        const featureId = new URL(req.url).searchParams.get('featureId');
        if (!featureId) return corsJson({ error: 'missing featureId' }, 400);
        const entry = cache.get(featureId);
        if (!entry) return corsJson({ found: false }, 404);
        return corsJson({
          found: true,
          summary: entry.summary,
          highlights: cache.highlightsServable(entry) ? entry.highlights : undefined,
          highlightSummaries: entry.highlightSummaries,
        } satisfies CachedResponse);
      },
      // The password header makes the extension's GET a preflighted one.
      OPTIONS: corsOptions,
    },
    // Extension uploads what it just generated so the next visitor (any
    // client) gets the cached summary/highlights without recompute. Creates
    // a stub entry if the server has never seen this place; revalidate fills
    // in the score next time /api/lookup runs.
    '/api/contribute': {
      POST: async (req) => {
        try {
          const { featureId, name, summary, highlights, highlightSummaries, score } = await req.json() as ContributeRequest;
          if (!featureId || !name) return corsJson({ error: 'missing featureId or name' }, 400);
          if (!summary && !highlights && !highlightSummaries && !score) return corsJson({ error: 'nothing to contribute' }, 400);
          await cache.putContribution(featureId, name, { summary, highlights, highlightSummaries, score });
          return corsJson({ ok: true } satisfies ContributeResponse);
        } catch (e) {
          console.error('[contribute]', e);
          return corsJson(errBody(e), 400);
        }
      },
      OPTIONS: corsOptions,
    },
    '/api/places': {
      GET: () => {
        const places = cache.all()
          .map((e) => ({
            featureId: e.featureId,
            name: e.name,
            scorePct: e.scorePct,
            adjusted: e.adjusted,
            resolvedUrl: e.resolvedUrl ?? mapsUrlFor(e.featureId),
            lastAccessTs: e.lastAccessTs,
          }))
          .sort((a, b) => b.lastAccessTs - a.lastAccessTs);
        return json({ places } satisfies PlacesResponse);
      },
    },
    '/api/histogram': {
      POST: async (req) => {
        try {
          const { featureId } = await req.json() as HistogramRequest;
          const entry = cache.get(featureId);
          if (!entry) return json({ error: 'look up the place first' }, 404);
          const { histogram, meta } = await getOrFetchPreviewBundle(featureId);
          if (!histogram) {
            console.warn(`[histogram] unavailable for ${entry.name} (${featureId}) — preview ${Object.keys(meta).length ? 'returned a place card without the rating histogram block' : 'fetch returned no place data (geo/A-B bucket or throttle)'}`);
            return json({ error: 'histogram unavailable' }, 500);
          }
          return json({ histogram, overallPct: overallPctFromHistogram(histogram), cached: cache.histogramFresh(entry) } satisfies HistogramResponse);
        } catch (e) {
          console.error('[histogram]', e);
          return json(errBody(e), 400);
        }
      },
    },
    // CORS-allowed. Web calls with just `{ featureId, force? }` and we use
    // cached entry.score.reviews. The extension calls with `{ featureId,
    // name, reviews }` (the maps-tab content script already has them) and we
    // use those directly — same Gemini work, but no need for the server to
    // have scraped the place first.
    '/api/summarize': {
      POST: async (req) => {
        try {
          const body = await req.json() as SummarizeRequest;
          const featureId = body.featureId;
          if (!featureId) return corsJson({ error: 'missing featureId' }, 400);

          const entry = cache.get(featureId);
          const force = !!body.force;
          const filter = body.filter?.trim() || undefined;
          // Only the unfiltered place summary participates in the persisted
          // cache; filtered topic summaries are per-callsite and shouldn't
          // overwrite the canonical entry.summary slot.
          if (!filter && entry?.summary && !force) {
            const summary = await summaryWithReceipts(entry.summary, cachedSubject(entry), (s) => cache.putSummary(featureId, s));
            return corsJson({ summary, cached: true } satisfies SummarizeResponse);
          }

          const subject = resolveSubject({
            entry, name: body.name, reviewTexts: body.reviewTexts, reviews: entry?.score?.reviews, removedReviews: body.removedReviews,
            hint: 'look up the place first or pass reviewTexts in the body',
          });

          // Its receipts are read before it's returned: a bullet never shows only to be dropped.
          const summary = await withReceipts(await summarize(subject, filter, parseProvider(body.provider), parseReasoningEffort(body.reasoningEffort)), subject);
          if (!filter && entry) await cache.putSummary(featureId, summary);
          return corsJson({ summary, cached: false } satisfies SummarizeResponse);
        } catch (e) {
          // No reviews to summarize is the caller's 404, not a server fault.
          if (!(e instanceof NoReviews)) console.error('[summarize]', e);
          return corsJson(errBody(e), errStatus(e));
        }
      },
      OPTIONS: corsOptions,
    },
    '/api/highlights': {
      POST: async (req) => {
        let featureId = '';
        try {
          const body = await req.json() as HighlightsRequest;
          featureId = body.featureId;
          const entry = cache.get(featureId);
          if (!entry) return json({ error: 'look up the place first' }, 404);
          // One chip's reviews, for a client opening it: only ever a cache read.
          if (body.token) return json({ highlights: entry.highlights?.filter((h) => h.token === body.token), cached: true } satisfies HighlightsResponse);
          // `.length`, not truthiness: an empty contributed array must fall through
          // to a harvest, not pin the row blank forever. A set the throttle cut
          // short falls through the same way, so the missing topics come back.
          if (cache.highlightsServable(entry) && !body.force) return json({ highlights: await chipsWithStance(featureId, entry.highlights!), cached: true } satisfies HighlightsResponse);
          const url = mapsUrlFor(featureId);

          // Chips already in hand (a prior harvest, or the lookup's preview) — score + stream.
          if (entry.chipMeta?.length) return streamHighlights(entry.name, featureId, url, entry.chipMeta);
          // A recent background warm came back empty → the place genuinely has no
          // topics. `force` (the REFRESH button) re-harvests anyway: it's the only
          // way out if the stamp was wrong, and it's user-initiated so the cost is theirs.
          if (cache.chipWarmedEmpty(entry) && !body.force) return json({ error: "Google didn't return any topic chips for this place" }, 404);

          // Fast path: one quick harvest round (skip if a background warm — or a cold
          // lookup's harvest — is already running).
          if (!warmChipsInflight.peek(featureId)) {
            const { chips } = await harvestQuick(url);
            if (chips.length) {
              await cache.recordChipWarm(featureId, chips);
              return streamHighlights(entry.name, featureId, url, chips);
            }
          }
          // Still nothing — harvest persistently in the background. A client that asked
          // to `wait` is held through it and gets the chips the moment they land; any
          // other re-polls the 202.
          // Bind just the name, not the whole entry, so the ~minute-long warm closure
          // doesn't pin the cached review arrays for its lifetime.
          const name = entry.name;
          const harvest = ensureChips(featureId, name);
          if (body.wait) return streamHighlights(name, featureId, url, harvest.then((h) => h.chips));
          void harvest.catch((e) => console.error(`[warm-chips] ${name} (${featureId}):`, e));
          return json({ pending: true } satisfies HighlightsResponse, 202);
        } catch (e) {
          const entry = featureId ? cache.get(featureId) : null;
          console.error(`[highlights] ${entry?.name ?? '?'} (${featureId || '?'}):`, e);
          return json(errBody(e), 400);
        }
      },
    },
    // CORS-allowed. Same dual-mode pattern as /api/summarize: the web caller
    // omits `reviews`/`label` and we pull both from the cached highlight;
    // the extension passes them directly so we can summarize chips on places
    // the server has never scraped.
    '/api/highlight-summary': {
      POST: async (req) => {
        try {
          const body = await req.json() as HighlightSummaryRequest;
          const { featureId, token, force } = body;
          if (!featureId || !token) return corsJson({ error: 'missing featureId or token' }, 400);

          const entry = cache.get(featureId);
          const cached = entry?.highlightSummaries?.[token];
          if (cached && !force) {
            const chip = entry?.highlights?.find((h) => h.token === token);
            const summary = await summaryWithReceipts(cached, entry && cachedSubject(entry, chip?.reviews), (s) => cache.putHighlightSummary(featureId, token, s));
            return corsJson({ summary, label: chip?.label ?? body.label ?? '', cached: true } satisfies HighlightSummaryResponse);
          }

          const highlight = entry?.highlights?.find((h) => h.token === token);
          const label = highlight?.label ?? body.label;
          if (!label) return corsJson({ error: 'missing label (and no cached highlight)' }, 400);
          const subject = resolveSubject({
            entry, name: body.name, reviewTexts: body.reviewTexts, reviews: highlight?.reviews,
            hint: 'pass reviewTexts in the body or run highlights first',
          });

          const summary = await withReceipts(await summarize(subject, label, parseProvider(body.provider), parseReasoningEffort(body.reasoningEffort)), subject);
          if (entry) await cache.putHighlightSummary(featureId, token, summary);
          return corsJson({ summary, label, cached: false } satisfies HighlightSummaryResponse);
        } catch (e) {
          if (!(e instanceof NoReviews)) console.error('[highlight-summary]', e);
          return corsJson(errBody(e), errStatus(e));
        }
      },
      OPTIONS: corsOptions,
    },
    // Streams: `search-progress` per page (running stats + review list), then
    // `search` with the settled result, then `search-summary` if requested.
    // Cache hits emit a single `search` event so the client uses one consumer.
    '/api/search': {
      POST: async (req) => {
        let featureId = '';
        let term = '';
        try {
          const body = await req.json() as SearchRequest;
          featureId = body.featureId;
          term = (body.query ?? '').trim();
          if (!term) return json({ error: 'empty query' }, 400);
          const entry = cache.get(featureId);
          const doSummarize = !!body.summarize;
          // A summary needs the place's row (its name, its removal notice); a search
          // alone doesn't, and the extension searches places this server never looked up.
          if (!entry && doSummarize) return json({ error: 'look up the place first' }, 404);

          const key = term.toLowerCase();
          const prior = entry?.searches?.[key];
          const cached = cache.searchServable(prior) ? prior : undefined;
          const force = !!body.force;

          return ndjsonStream<SearchEvent>(async (write) => {
            try {
              if (cached && !force && (!doSummarize || cached.summary) && (cached.stance || !jevAvailable())) {
                write({ type: 'search', result: cached, cached: true });
                return;
              }

              let result = cached && !force ? cached : null;
              if (!result) {
                const reviews = await fetchAllForSearch(featureId, term, (_, rs) => {
                  const stats = statsForReviews(rs);
                  write({ type: 'search-progress', query: term, ...stats });
                }, force);
                result = { query: term, ...statsForReviews(reviews), reviews, ts: Date.now() };
              }
              // What the matches say about the query, read before the result first shows.
              if (!result.stance) result = { ...result, ...(await stanceOfReviews(term, result.reviews)) };
              write({ type: 'search', result, cached: false });

              // Persist the scrape BEFORE summarizing: the search is the
              // expensive half, and a failed summary used to throw past this and
              // discard it, so the next request paid for the whole thing again.
              // Not while the session is unhealthy: a stale page mid-pagination
              // cuts a search short without failing it. (putSearch itself
              // refuses an empty result.)
              const cacheable = mapsSessionHealthy();
              if (cacheable) await cache.putSearch(featureId, term, result);

              if (entry && doSummarize && (!result.summary || force)) {
                const reviewTexts = textReviewsFor(result.reviews);
                if (reviewTexts.length) {
                  const subject = { placeName: entry.name, reviewTexts, removedReviews: entry.meta?.removedReviews };
                  result.summary = await withReceipts(await summarize(subject, term, parseProvider(body.provider), parseReasoningEffort(body.reasoningEffort)), subject);
                  write({ type: 'search-summary', summary: result.summary });
                  if (cacheable) await cache.putSearch(featureId, term, result);
                }
              }
            } catch (e) {
              console.error(`[search] "${term}" (${featureId}):`, e);
              write({ type: 'error', error: friendlyError(e) });
            }
          });
        } catch (e) {
          console.error('[search]', e);
          return json(errBody(e), 400);
        }
      },
    },
    // Jev's read of texts a client already holds — the extension's own searches
    // and chips, an Ask's matches (see StanceRequest). 503 when Jev is off, and
    // the caller keeps the display it had.
    '/api/stance': {
      POST: async (req) => {
        try {
          const body = await req.json() as StanceRequest;
          const texts = (Array.isArray(body.texts) ? body.texts : []).filter((t): t is string => typeof t === 'string').slice(0, MAX_JUDGED);
          const question = body.question?.trim(), topic = body.topic?.trim();
          if (!question && !topic) return corsJson({ error: 'missing topic or question' }, 400);
          const answers = question ? await answersFor(question, texts) : null;
          const stances = question ? null : await stancesFor(topic!, texts);
          if (!answers && !stances) return corsJson({ error: 'unavailable' } satisfies StanceResponse, 503);
          return corsJson((answers ? { answers } : { stances: stances! }) satisfies StanceResponse);
        } catch (e) {
          console.error('[stance]', e);
          return corsJson(errBody(e), 400);
        }
      },
      OPTIONS: corsOptions,
    },
    // Which of the texts a summary was built from make each of its points, and
    // how many prefer each rival it names — for summaries the extension writes
    // itself (see ReceiptsRequest). 503 when Jev is off.
    '/api/receipts': {
      POST: async (req) => {
        try {
          const body = await req.json() as ReceiptsRequest;
          const strings = (v: unknown) => (Array.isArray(v) ? v : []).filter((t): t is string => typeof t === 'string');
          const points = strings(body.points), texts = strings(body.texts).slice(0, MAX_JUDGED), rivals = strings(body.rivals);
          const [support, preferredBy] = await Promise.all([
            supportFor(points, texts),
            Promise.all(rivals.map((r) => preferredCount(body.place ?? '', r, mentioning(texts, r)))),
          ]);
          if (!support || preferredBy.some((n) => n == null)) return corsJson({ error: 'unavailable' } satisfies ReceiptsResponse, 503);
          return corsJson({ support, preferredBy: preferredBy as number[] } satisfies ReceiptsResponse);
        } catch (e) {
          console.error('[receipts]', e);
          return corsJson(errBody(e), 400);
        }
      },
      OPTIONS: corsOptions,
    },
    // CORS-allowed. Web caller passes `{ featureId, messages }` and we read
    // entry.score.reviews from cache; the extension passes `{ name, reviewTexts,
    // messages }` directly so the answer comes from the maps-tab's local review
    // scrape, no need to round-trip the place through /api/lookup. Streams one
    // round of the Ask (see AskMessage): when the model calls for Searches, the
    // client runs them its own way and sends the Ask back with their matches —
    // the server keeps nothing between rounds, and a client leaving mid-answer
    // stops the model.
    '/api/ask': {
      POST: async (req) => {
        try {
          const body = await req.json() as AskRequest;
          const { featureId, messages = [] } = body;
          const question = questionOf(messages);
          if (!question) return corsJson({ error: 'missing question' }, 400);

          const entry = featureId ? cache.get(featureId) : undefined;
          const subject = resolveSubject({
            entry, name: body.name, reviewTexts: body.reviewTexts, reviews: entry?.score?.reviews, removedReviews: body.removedReviews,
            hint: 'look up the place first or pass reviewTexts in the body',
          });
          const key = answerKey(body.filter, question);
          const headers = { 'Access-Control-Allow-Origin': '*' };

          // The same question of the same scope within a day replays its Answer.
          const replay = entry && !body.force && messages.length === 1 ? entry.answers?.[key] : undefined;
          if (cache.answerServable(replay)) return createUIMessageStreamResponse({ headers, stream: replayAnswer(replay) });

          const result = await ask(subject, messages, {
            filterQuery: body.filter?.trim() || undefined,
            provider: parseProvider(body.provider),
            reasoningEffort: parseReasoningEffort(body.reasoningEffort),
            abortSignal: req.signal,
          });
          return result.toUIMessageStreamResponse({
            headers,
            originalMessages: messages,
            onError: friendlyError,
            // Only a clean Answer is worth replaying: every Search it asked for ran.
            onFinish: async ({ responseMessage, finishReason, isAborted }) => {
              const { text, searches } = askViewOf(responseMessage);
              if (!entry || !featureId || isAborted || finishReason !== 'stop' || !text.trim() || !searches.every((s) => s.done && s.found != null)) return;
              // A replay's rows show what their matches say to the question, as the
              // live rows did: read now (the client's own read of them is memoised).
              const calls = responseMessage.parts.filter(isStaticToolUIPart);
              const answered = await Promise.all(searches.map(async (s, i) => {
                const call = calls[i];
                const texts = call?.state === 'output-available' ? call.output.texts.slice(0, MAX_JUDGED) : [];
                const answers = texts.length ? await answersFor(question, texts) : null;
                return answers ? { ...s, answers: countAnswers(answers) } : s;
              }));
              await cache.putAnswer(featureId, key, { answer: text.trim(), searches: answered, ts: Date.now() });
            },
          });
        } catch (e) {
          console.error('[ask]', e);
          return corsJson(errBody(e), errStatus(e));
        }
      },
      OPTIONS: corsOptions,
    },
  }),
  development: { hmr: false, console: true },
});

console.log(`[truescore-web] http://localhost:${PORT}`);
