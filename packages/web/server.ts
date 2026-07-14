import {
  statsForReviews,
  textReviewsFor,
  type AskRequest,
  type AskResponse,
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
  type PlacesResponse,
  type SearchEvent,
  type SearchRequest,
  type SummarizeRequest,
  type SummarizeResponse,
} from '@truescore/gmaps-shared';
import { resolvePlace } from './resolve';
import { applySeed, loadPersistedSeed, mapsCredsStatus, mapsSessionHealthy, startMintTimer, renewSession } from './maps-creds';
import { scorePlace, fetchAllForSearch } from './gmaps';
import { summarize, ask, parseProvider, parseReasoningEffort } from './llm';
import { fetchPreviewBundle, histogramTotal, overallPctFromHistogram, type Histogram, type PreviewBundle } from './histogram';
import { harvestTokens, harvestQuick, scoreHighlight } from './highlights';
import { cache, type CacheEntry } from './cache';
import { logEvent } from './events';
import { createInflight } from './inflight';
import index from './index.html';

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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  },
});

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
const mapsUrlFor = (featureId: string) => `https://www.google.com/maps?q=&ftid=${featureId}`;

// NDJSON streaming response. The producer pushes one JSON object per line via
// `write`; if it throws, we emit a final `{type:'error'}` event so the client
// always gets a defined terminus. The `closed` flag silently swallows writes
// after the consumer aborts so partial sends never throw downstream.
function ndjsonStream<E extends { type: string }>(producer: (write: (event: E) => void) => Promise<void>): Response {
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
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

const PORT = Number(process.env.PORT || 3000);

const previewInflight = createInflight<PreviewBundle>();
const revalidateInflight = createInflight<void>();
const highlightsRecomputeInflight = createInflight<void>();
const warmChipsInflight = createInflight<ChipMeta[]>();

const HIGHLIGHTS_DRIFT_THRESHOLD = 0.01;

// Get a place's topic chips: the set the lookup's preview already cached if
// present, else harvest them. The preview RPC only serves the chips ~15-20% of
// the time (random per request), but the tokens are stable, so the harvest is
// single-flight per place and persistent, and records its outcome — a hit caches
// the stable tokens, a miss stamps the entry topic-less so we stop re-warming it.
// Shared by the /api/highlights background warm (fire-and-forget while the client
// re-polls the 202 `pending`) and the drift recompute, so both dedup and
// self-cache through one primitive.
function ensureChips(featureId: string, name: string): Promise<ChipMeta[]> {
  const cached = cache.get(featureId)?.chipMeta;
  if (cached?.length) return Promise.resolve(cached);
  return warmChipsInflight.run(featureId, async () => {
    const chips = await harvestTokens(mapsUrlFor(featureId));
    await cache.recordChipWarm(featureId, chips);
    console.log(`[warm-chips] ${name} (${featureId}): ${chips.length ? `cached ${chips.length} chips` : 'no chips after warm — marked topic-less'}`);
    return chips;
  });
}

// Score every chip in parallel: collect successes, count failures, and cache
// whatever succeeded — even on partial failure, so one transient chip error
// doesn't discard the rest and force a full re-scrape next time. Optional hooks
// let the streaming caller emit an NDJSON event as each chip resolves.
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
  const chips = await ensureChips(featureId, name);
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
      console.warn(`[revalidate] ${name} (${featureId}): re-scrape got 0 vs histogram ${currentTotal} — keeping prior entry (likely throttle)`);
      logEvent('throttle', { where: 'revalidate', name, fid: featureId, histogram: currentTotal });
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

// Cache whatever chips succeeded, even on partial failure, so one transient chip
// error doesn't discard the rest and force a full re-scrape next lookup.
function streamHighlights(name: string, featureId: string, url: string, chips: ChipMeta[]): Response {
  return ndjsonStream<HighlightEvent>(async (write) => {
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
  const slimHighlights = cached.highlights?.map(({ reviews: _r, ...rest }) => rest);
  const cachedScoreTs = cached.scoreTs ?? 0;
  const cachedHighlightsTs = cached.highlightsTs ?? 0;
  return ndjsonStream<LookupEvent>(async (write) => {
    write({
      type: 'lookup',
      name: cached.name,
      score: cached.score,
      summary: cached.summary,
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
          score: fresh.score,
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
            highlights: post.highlights.map(({ reviews: _r, ...rest }) => rest),
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
function streamFreshLookup(featureId: string, name: string, resolvedUrl: string): Response {
  return ndjsonStream<LookupEvent>(async (write) => {
    write({ type: 'place', name, featureId, resolvedUrl });
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

    const score = await scorePlace(featureId, (partial) => {
      write({ type: 'score-progress', score: partial });
    });
    const bundle = await previewPromise;
    const currentTotal = bundle.histogram ? histogramTotal(bundle.histogram) : null;
    // putScore rejects a throttled (0-review) scrape when the histogram shows the
    // place has reviews, so the next lookup retries instead of caching the empty
    // result. Genuinely review-less places have currentTotal 0 and still cache.
    if (!(await cache.putScore(featureId, name, score, currentTotal, resolvedUrl))) {
      console.warn(`[lookup] ${name} (${featureId}): scraped 0 but histogram has ${currentTotal} — not caching (likely throttle)`);
      logEvent('throttle', { where: 'lookup', name, fid: featureId, histogram: currentTotal });
    }
    write({ type: 'score', score, fetchMs: Date.now() - t0 });
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

// Restore the last seeded session before serving, so a deploy/restart doesn't blank
// reviews until the first mint lands. Then start the hands-off mint timer: a
// stealth-cloaked headless browser captures a fresh anonymous bgkey — on boot if
// credless, and on a timer well inside the session's ~day life.
await loadPersistedSeed();
startMintTimer();

Bun.serve({
  port: PORT,
  routes: {
    '/': index,
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
          // highlights still load from cache right after the score settles).
          if (cached?.scoreTs) return streamCachedLookup(featureId, name, resolvedUrl, cached);
          return streamFreshLookup(featureId, name, resolvedUrl);
        } catch (e) {
          console.error(`[lookup] ${e instanceof Error ? e.message : e}`);
          return json(errBody(e), 400);
        }
      },
    },
    // The extension seeds a live logged-in session here: its captured bgkey +
    // matching Google cookies, paired so the server can replay batchexecute
    // (the legacy endpoint is retired and the server can't mint a bgkey itself).
    // Off unless TRUESCORE_SEED_SECRET is set; creds are held in memory only.
    '/api/maps-creds': {
      // Liveness probe: when was the session last seeded, how stale is it now.
      // Same secret as POST so it never leaks session-liveness publicly.
      GET: (req) => {
        const secret = process.env.TRUESCORE_SEED_SECRET;
        if (!secret) return json({ error: 'seeding disabled' }, 404);
        if (req.headers.get('x-truescore-seed') !== secret) return json({ error: 'forbidden' }, 403);
        return json(mapsCredsStatus());
      },
      POST: async (req) => {
        const secret = process.env.TRUESCORE_SEED_SECRET;
        if (!secret) return json({ error: 'seeding disabled' }, 404);
        if (req.headers.get('x-truescore-seed') !== secret) return json({ error: 'forbidden' }, 403);
        try {
          const { bgkey, bgbind, sessionId, at, cookies } = (await req.json()) as Record<string, string>;
          if (!bgkey || !bgbind || !sessionId || !at || !cookies) return json({ error: 'incomplete creds' }, 400);
          await applySeed({ bgkey, bgbind, sessionId, at, cookies });
          return json({ ok: true });
        } catch (e) {
          return json(errBody(e), 400);
        }
      },
    },
    // Public health for the web client's reseed banner: whether the server has a
    // usable Maps session right now. Just a boolean — no secret, no timing.
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
          highlights: entry.highlights,
          highlightSummaries: entry.highlightSummaries,
        } satisfies CachedResponse);
      },
    },
    // Extension uploads what it just generated so the next visitor (any
    // client) gets the cached summary/highlights without recompute. Creates
    // a stub entry if the server has never seen this place; revalidate fills
    // in the score next time /api/lookup runs.
    '/api/contribute': {
      POST: async (req) => {
        try {
          const { featureId, name, summary, highlights, highlightSummaries } = await req.json() as ContributeRequest;
          if (!featureId || !name) return corsJson({ error: 'missing featureId or name' }, 400);
          if (!summary && !highlights && !highlightSummaries) return corsJson({ error: 'nothing to contribute' }, 400);
          await cache.putContribution(featureId, name, { summary, highlights, highlightSummaries });
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
            scorePct: e.score.scorePct,
            resolvedUrl: e.resolvedUrl ?? mapsUrlFor(e.featureId),
            lastAccessTs: e.lastAccessTs ?? e.scoreTs,
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
          if (!filter && entry?.summary && !force) return corsJson({ summary: entry.summary, cached: true } satisfies SummarizeResponse);

          const placeName = entry?.name ?? body.name ?? '';
          // Pre-formatted reviewTexts win (extension already ran textReviewsFor
          // on the local scrape and shouldn't have to ship the full Review[]).
          // Falling back to cache lets the web caller keep its old shape.
          const reviewTexts = body.reviewTexts ?? (entry?.score ? textReviewsFor(entry.score.reviews) : null);
          if (!reviewTexts?.length) return corsJson({ error: 'no reviews — look up the place first or pass reviewTexts in the body' }, 404);

          const summary = await summarize(placeName, reviewTexts, filter, parseProvider(body.provider), parseReasoningEffort(body.reasoningEffort));
          if (!filter && entry) await cache.putSummary(featureId, summary);
          return corsJson({ summary, cached: false } satisfies SummarizeResponse);
        } catch (e) {
          console.error('[summarize]', e);
          return corsJson(errBody(e), 400);
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
          if (entry.highlights && !body.force) return json({ highlights: entry.highlights, cached: true } satisfies HighlightsResponse);
          const url = mapsUrlFor(featureId);

          // Chips already in hand (a prior harvest, or the lookup's preview) — score + stream.
          if (entry.chipMeta?.length) return streamHighlights(entry.name, featureId, url, entry.chipMeta);
          // A recent background warm came back empty → the place genuinely has no topics.
          if (cache.chipWarmedEmpty(entry)) return json({ error: "Google didn't return any topic chips for this place" }, 404);

          // Fast path: one quick harvest round (skip if a background warm is already running).
          if (!warmChipsInflight.peek(featureId)) {
            const chips = await harvestQuick(url);
            if (chips.length) {
              await cache.recordChipWarm(featureId, chips);
              return streamHighlights(entry.name, featureId, url, chips);
            }
          }
          // Still nothing — harvest persistently in the background and have the client re-poll.
          // Bind just the name, not the whole entry, so the ~minute-long warm closure
          // doesn't pin the cached review arrays for its lifetime.
          const name = entry.name;
          void ensureChips(featureId, name).catch((e) => console.error(`[warm-chips] ${name} (${featureId}):`, e));
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
            const label = entry?.highlights?.find((h) => h.token === token)?.label ?? body.label ?? '';
            return corsJson({ summary: cached, label, cached: true } satisfies HighlightSummaryResponse);
          }

          const highlight = entry?.highlights?.find((h) => h.token === token);
          const label = highlight?.label ?? body.label;
          if (!label) return corsJson({ error: 'missing label (and no cached highlight)' }, 400);
          const placeName = entry?.name ?? body.name ?? '';
          const reviewTexts = body.reviewTexts ?? (highlight?.reviews ? textReviewsFor(highlight.reviews) : null);
          if (!reviewTexts?.length) return corsJson({ error: 'no review text — pass reviewTexts in the body or run highlights first' }, 400);

          const summary = await summarize(placeName, reviewTexts, label);
          if (entry) await cache.putHighlightSummary(featureId, token, summary);
          return corsJson({ summary, label, cached: false } satisfies HighlightSummaryResponse);
        } catch (e) {
          console.error('[highlight-summary]', e);
          return corsJson(errBody(e), 400);
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
          if (!entry) return json({ error: 'look up the place first' }, 404);

          const key = term.toLowerCase();
          const cached = entry.searches?.[key];
          const doSummarize = !!body.summarize;
          const force = !!body.force;
          const placeName = entry.name;

          return ndjsonStream<SearchEvent>(async (write) => {
            try {
              if (cached && !force && (!doSummarize || cached.summary)) {
                write({ type: 'search', result: cached, cached: true });
                return;
              }

              let result = cached && !force ? cached : null;
              if (!result) {
                const reviews = await fetchAllForSearch(featureId, term, (_, rs) => {
                  const stats = statsForReviews(rs);
                  write({ type: 'search-progress', query: term, ...stats });
                });
                result = { query: term, ...statsForReviews(reviews), reviews, ts: Date.now() };
              }
              write({ type: 'search', result, cached: false });

              if (doSummarize && (!result.summary || force)) {
                const reviewTexts = textReviewsFor(result.reviews);
                if (reviewTexts.length) {
                  result.summary = await summarize(placeName, reviewTexts, term);
                  write({ type: 'search-summary', summary: result.summary });
                }
              }
              await cache.putSearch(featureId, term, result);
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
    // CORS-allowed. Web caller passes `{ featureId, question }` and we read
    // entry.score.reviews from cache; the extension passes `{ name, reviews,
    // question }` directly so the answer comes from the maps-tab's local
    // review scrape, no need to round-trip the place through /api/lookup.
    '/api/ask': {
      POST: async (req) => {
        try {
          const body = await req.json() as AskRequest;
          const { featureId, question } = body;
          if (!question) return corsJson({ error: 'missing question' }, 400);

          const entry = featureId ? cache.get(featureId) : null;
          const placeName = entry?.name ?? body.name ?? '';
          const reviewTexts = body.reviewTexts ?? (entry?.score ? textReviewsFor(entry.score.reviews) : null);
          if (!reviewTexts?.length) return corsJson({ error: 'no reviews — look up the place first or pass reviewTexts in the body' }, 404);

          const answer = await ask(placeName, reviewTexts, question, body.filter?.trim() || undefined, parseProvider(body.provider), parseReasoningEffort(body.reasoningEffort));
          return corsJson({ answer } satisfies AskResponse);
        } catch (e) {
          console.error('[ask]', e);
          return corsJson(errBody(e), 400);
        }
      },
      OPTIONS: corsOptions,
    },
  },
  development: { hmr: false, console: true },
});

console.log(`[truescore-web] http://localhost:${PORT}`);
