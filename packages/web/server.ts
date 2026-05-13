import { statsForReviews, textReviewsFor, type ChipMeta } from '@truescore/gmaps-shared';
import { resolvePlace } from './resolve';
import { scorePlace, fetchAllForSearch, type Review } from './gmaps';
import { summarize, ask } from './gemini';
import { fetchPreviewBundle, overallPctFromHistogram, type Histogram, type PreviewBundle } from './histogram';
import { harvestTokens, scoreHighlight, type Highlight } from './highlights';
import { cache, type CacheEntry } from './cache';
import index from './index.html';

const json = (v: any, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

// Extension-facing endpoints only — keeps Lookup/Summarize/etc. same-origin
// so a drive-by site can't trigger Google fetches or Gemini calls via the
// user's browser.
const corsJson = (v: any, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
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

const PORT = Number(process.env.PORT || 3000);

const previewInflight = new Map<string, Promise<PreviewBundle>>();
const revalidateInflight = new Map<string, Promise<void>>();
const highlightsRecomputeInflight = new Map<string, Promise<void>>();

const HIGHLIGHTS_DRIFT_THRESHOLD = 0.01;

async function recomputeHighlights(featureId: string, name: string, url: string): Promise<void> {
  const chips = await harvestTokens(url);
  if (!chips.length) return;
  const successes: Highlight[] = [];
  let failures = 0;
  await Promise.all(chips.map(async (chip) => {
    try {
      successes.push(await scoreHighlight(featureId, chip));
    } catch (e) {
      failures++;
      console.warn(`[recompute-highlights] ${name} (${featureId}): chip "${chip.label}" failed:`, e);
    }
  }));
  const totalFetched = successes.reduce((a, h) => a + (h.fetched ?? 0), 0);
  if (failures === 0 && totalFetched > 0) {
    await cache.putHighlights(featureId, successes);
    console.log(`[recompute-highlights] ${name} (${featureId}): ${successes.length}/${chips.length} chips, ${totalFetched} reviews`);
  } else {
    console.log(`[recompute-highlights] ${name} (${featureId}): not cached (${successes.length}/${chips.length} chips, ${failures} failed, ${totalFetched} reviews)`);
  }
}

// Stale-while-revalidate: re-fetch the preview, compare its total to the
// cached `totalReviewsAtCache`, and re-score if Google has new reviews.
// Highlights are recomputed in the background only when drift exceeds 1%.
function revalidate(featureId: string, name: string, resolvedUrl: string): Promise<void> {
  const existing = revalidateInflight.get(featureId);
  if (existing) return existing;
  const p = (async () => {
    const bundle = await getOrFetchPreviewBundle(featureId, resolvedUrl).catch(() => null);
    const histogram = bundle?.histogram ?? null;
    const currentTotal = histogram ? histogram.reduce((a, b) => a + b, 0) : null;
    if (currentTotal == null) return;
    const entry = cache.get(featureId);
    const prevTotal = entry?.totalReviewsAtCache;
    const hadHighlights = !!entry?.highlights?.length;
    if (entry && prevTotal === currentTotal) return; // still fresh
    const score = await scorePlace(featureId);
    await cache.putScore(featureId, name, score, currentTotal, resolvedUrl);
    console.log(`[revalidate] ${name}: total ${prevTotal ?? 'unset'} → ${currentTotal}, re-scored`);

    if (hadHighlights && prevTotal != null) {
      const drift = Math.abs(currentTotal - prevTotal) / prevTotal;
      if (drift > HIGHLIGHTS_DRIFT_THRESHOLD && !highlightsRecomputeInflight.has(featureId)) {
        const hp = recomputeHighlights(featureId, name, resolvedUrl)
          .catch((e) => console.error(`[recompute-highlights] ${name} (${featureId}):`, e))
          .finally(() => highlightsRecomputeInflight.delete(featureId));
        highlightsRecomputeInflight.set(featureId, hp);
      }
    }
  })().finally(() => revalidateInflight.delete(featureId));
  revalidateInflight.set(featureId, p);
  return p;
}

// Cache only on full success so the next request retries cleanly when any
// chip failed. The `closed` flag protects the cache write from being lost
// if the consumer aborts mid-stream — without it, the first failed enqueue
// would reject Promise.all before we could persist.
function streamHighlights(name: string, featureId: string, url: string, chips: ChipMeta[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const write = (obj: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); }
        catch { closed = true; }
      };

      write({ type: 'chips', chips });

      const successes: Highlight[] = [];
      let failures = 0;
      await Promise.all(chips.map(async (chip) => {
        try {
          const h = await scoreHighlight(featureId, chip);
          successes.push(h);
          write({ type: 'chip', highlight: h });
        } catch (e) {
          failures++;
          console.warn(`[highlights] ${name} (${featureId}): chip "${chip.label}" failed:`, e);
          write({ type: 'chip-error', token: chip.token, label: chip.label, error: friendlyError(e) });
        }
      }));

      const totalFetched = successes.reduce((a, h) => a + (h.fetched ?? 0), 0);
      const cacheable = failures === 0 && totalFetched > 0;
      if (cacheable) {
        await cache.putHighlights(featureId, successes);
      } else if (totalFetched === 0 && failures === 0) {
        console.warn(
          `[highlights] ${name} (${featureId}): all ${chips.length} chips fetched 0 reviews ` +
            `(likely upstream throttle). chips=[${chips.map((c) => c.label).join(', ')}] url=${url}`,
        );
      }
      const tag = failures
        ? `${successes.length}/${chips.length} ok, ${failures} failed`
        : `${chips.length} chips`;
      console.log(`[highlights] ${name} (${featureId}): ${tag}, ${totalFetched} reviews${cacheable ? '' : ' (not cached)'}`);

      write({ type: 'done', failures, totalFetched, cached: cacheable });
      if (!closed) controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson' },
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
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const write = (obj: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); }
        catch { closed = true; }
      };
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
      } catch (e) {
        console.error('[revalidate]', e);
      }
      if (!closed) controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

function getOrFetchPreviewBundle(featureId: string, url: string): Promise<PreviewBundle> {
  const existing = cache.get(featureId);
  if (existing?.histogram && existing.meta && cache.histogramFresh(existing)) {
    return Promise.resolve({ histogram: existing.histogram, meta: existing.meta });
  }
  const inflight = previewInflight.get(featureId);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const bundle = await fetchPreviewBundle(url);
      await cache.putPreviewBundle(featureId, bundle);
      return bundle;
    } finally {
      previewInflight.delete(featureId);
    }
  })();
  previewInflight.set(featureId, p);
  return p;
}

Bun.serve({
  port: PORT,
  routes: {
    '/': index,
    '/api/lookup': {
      POST: async (req) => {
        try {
          const { url } = await req.json();
          const { featureId, name, resolvedUrl } = await resolvePlace(url);

          const cached = cache.get(featureId);
          if (cached) return streamCachedLookup(featureId, name, resolvedUrl, cached);

          // Run preview fetch in parallel with the score scrape.
          const bundlePromise = getOrFetchPreviewBundle(featureId, resolvedUrl)
            .catch((e) => { console.error('[preview]', e); return { histogram: null, meta: {} } as PreviewBundle; });
          const t0 = Date.now();
          const score = await scorePlace(featureId);
          const { histogram, meta } = await bundlePromise;
          const currentTotal = histogram ? histogram.reduce((a, b) => a + b, 0) : null;
          await cache.putScore(featureId, name, score, currentTotal, resolvedUrl);
          return json({
            name,
            score,
            summary: undefined,
            histogram,
            overallPct: histogram ? overallPctFromHistogram(histogram) : null,
            meta,
            resolvedUrl,
            fetchMs: Date.now() - t0,
            cached: false,
          });
        } catch (e) {
          console.error('[lookup]', e);
          return json(errBody(e), 400);
        }
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
        });
      },
    },
    // Extension uploads what it just generated so the next visitor (any
    // client) gets the cached summary/highlights without recompute. Creates
    // a stub entry if the server has never seen this place; revalidate fills
    // in the score next time /api/lookup runs.
    '/api/contribute': {
      POST: async (req) => {
        try {
          const { featureId, name, summary, highlights, highlightSummaries } = await req.json() as {
            featureId: string;
            name: string;
            summary?: any;
            highlights?: any[];
            highlightSummaries?: Record<string, any>;
          };
          if (!featureId || !name) return corsJson({ error: 'missing featureId or name' }, 400);
          if (!summary && !highlights && !highlightSummaries) return corsJson({ error: 'nothing to contribute' }, 400);
          await cache.putContribution(featureId, name, { summary, highlights, highlightSummaries });
          return corsJson({ ok: true });
        } catch (e) {
          console.error('[contribute]', e);
          return corsJson(errBody(e), 400);
        }
      },
      OPTIONS: () => new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      }),
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
        return json({ places });
      },
    },
    '/api/histogram': {
      POST: async (req) => {
        try {
          const { featureId } = await req.json();
          const entry = cache.get(featureId);
          if (!entry) return json({ error: 'look up the place first' }, 404);
          const url = entry.resolvedUrl ?? mapsUrlFor(featureId);
          const { histogram } = await getOrFetchPreviewBundle(featureId, url);
          if (!histogram) return json({ error: 'histogram unavailable' }, 500);
          return json({ histogram, overallPct: overallPctFromHistogram(histogram), cached: cache.histogramFresh(entry) });
        } catch (e) {
          console.error('[histogram]', e);
          return json(errBody(e), 400);
        }
      },
    },
    '/api/summarize': {
      POST: async (req) => {
        try {
          const { featureId, force } = await req.json() as { featureId: string; force?: boolean };
          const entry = cache.get(featureId);
          if (!entry) return json({ error: 'look up the place first' }, 404);
          if (entry.summary && !force) return json({ summary: entry.summary, cached: true });
          const summary = await summarize(entry.name, textReviewsFor(entry.score.reviews));
          await cache.putSummary(featureId, summary);
          return json({ summary, cached: false });
        } catch (e) {
          console.error('[summarize]', e);
          return json(errBody(e), 400);
        }
      },
    },
    '/api/highlights': {
      POST: async (req) => {
        let featureId = '';
        try {
          const body = await req.json() as { featureId: string; force?: boolean };
          featureId = body.featureId;
          const entry = cache.get(featureId);
          if (!entry) return json({ error: 'look up the place first' }, 404);
          if (entry.highlights && !body.force) return json({ highlights: entry.highlights, cached: true });
          const url = entry.resolvedUrl ?? mapsUrlFor(featureId);
          const chips = await harvestTokens(url);
          if (!chips.length) {
            console.warn(`[highlights] ${entry.name} (${featureId}): preview returned no chips after retries — ${url}`);
            return json({ error: "Google didn't return any topic chips for this place" }, 404);
          }
          return streamHighlights(entry.name, featureId, url, chips);
        } catch (e) {
          const entry = featureId ? cache.get(featureId) : null;
          console.error(`[highlights] ${entry?.name ?? '?'} (${featureId || '?'}):`, e);
          return json(errBody(e), 400);
        }
      },
    },
    '/api/highlight-summary': {
      POST: async (req) => {
        try {
          const { featureId, token, force } = await req.json() as { featureId: string; token: string; force?: boolean };
          const entry = cache.get(featureId);
          if (!entry) return json({ error: 'look up the place first' }, 404);
          const highlight = entry.highlights?.find((h) => h.token === token);
          if (!highlight) return json({ error: 'highlight not found, refresh highlights' }, 404);
          const cached = entry.highlightSummaries?.[token];
          if (cached && !force) return json({ summary: cached, label: highlight.label, cached: true });
          const reviewTexts = textReviewsFor(highlight.reviews ?? []);
          if (!reviewTexts.length) return json({ error: 'no review text available for this highlight' }, 400);
          const summary = await summarize(entry.name, reviewTexts, highlight.label);
          await cache.putHighlightSummary(featureId, token, summary);
          return json({ summary, label: highlight.label, cached: false });
        } catch (e) {
          console.error('[highlight-summary]', e);
          return json(errBody(e), 400);
        }
      },
    },
    '/api/search': {
      POST: async (req) => {
        try {
          const { featureId, query, force, summarize: doSummarize } = await req.json() as {
            featureId: string;
            query: string;
            force?: boolean;
            summarize?: boolean;
          };
          const term = (query ?? '').trim();
          if (!term) return json({ error: 'empty query' }, 400);
          const entry = cache.get(featureId);
          if (!entry) return json({ error: 'look up the place first' }, 404);

          const key = term.toLowerCase();
          const cached = entry.searches?.[key];
          if (cached && !force && (!doSummarize || cached.summary)) {
            return json({ result: cached, cached: true });
          }

          let result = cached && !force ? cached : null;
          if (!result) {
            const reviews = await fetchAllForSearch(featureId, term);
            result = { query: term, ...statsForReviews(reviews), reviews, ts: Date.now() };
          }

          if (doSummarize && (!result.summary || force)) {
            const reviewTexts = textReviewsFor(result.reviews);
            if (reviewTexts.length) {
              result.summary = await summarize(entry.name, reviewTexts, term);
            }
          }

          await cache.putSearch(featureId, term, result);
          return json({ result, cached: false });
        } catch (e) {
          console.error('[search]', e);
          return json(errBody(e), 400);
        }
      },
    },
    '/api/ask': {
      POST: async (req) => {
        try {
          const { featureId, question } = await req.json();
          const entry = cache.get(featureId);
          if (!entry) return json({ error: 'look up the place first' }, 404);
          const answer = await ask(entry.name, textReviewsFor(entry.score.reviews), question);
          return json({ answer });
        } catch (e) {
          console.error('[ask]', e);
          return json(errBody(e), 400);
        }
      },
    },
  },
  development: { hmr: false, console: true },
});

console.log(`[truescore-web] http://localhost:${PORT}`);
