import { resolvePlace } from './resolve';
import { scorePlace, fetchAllForSearch, type Review } from './gmaps';
import { summarize, ask } from './gemini';
import { fetchPreviewBundle, overallPctFromHistogram, type Histogram, type PreviewBundle } from './histogram';
import { harvestTokens, scoreHighlights } from './highlights';
import { cache } from './cache';
import index from './index.html';

const json = (v: any, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const errBody = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
const mapsUrlFor = (featureId: string) => `https://www.google.com/maps?q=&ftid=${featureId}`;

const PORT = Number(process.env.PORT || 3000);

const previewInflight = new Map<string, Promise<PreviewBundle>>();
const revalidateInflight = new Map<string, Promise<void>>();

// Stale-while-revalidate: re-fetch the preview, compare its total to the
// cached `totalReviewsAtCache`, and re-score if Google has new reviews.
function revalidate(featureId: string, name: string, resolvedUrl: string): Promise<void> {
  const existing = revalidateInflight.get(featureId);
  if (existing) return existing;
  const p = (async () => {
    const bundle = await getOrFetchPreviewBundle(featureId, resolvedUrl).catch(() => null);
    const histogram = bundle?.histogram ?? null;
    const currentTotal = histogram ? histogram.reduce((a, b) => a + b, 0) : null;
    if (currentTotal == null) return;
    const entry = cache.get(featureId);
    if (entry && entry.totalReviewsAtCache === currentTotal) return; // still fresh
    const score = await scorePlace(featureId);
    await cache.putScore(featureId, name, score, currentTotal, resolvedUrl);
    console.log(`[revalidate] ${name}: total ${entry?.totalReviewsAtCache ?? 'unset'} → ${currentTotal}, re-scored`);
  })().finally(() => revalidateInflight.delete(featureId));
  revalidateInflight.set(featureId, p);
  return p;
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
      await cache.putPreviewBundle(featureId, bundle.histogram, bundle.meta);
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
          if (cached) {
            void cache.touch(featureId).catch((e) => console.error('[touch]', e));
            // Stale-while-revalidate: serve cache immediately, refresh in background.
            void revalidate(featureId, name, resolvedUrl).catch((e) => console.error('[revalidate]', e));
            return json({
              name: cached.name,
              score: cached.score,
              summary: cached.summary,
              histogram: cached.histogram,
              overallPct: cached.histogram ? overallPctFromHistogram(cached.histogram) : null,
              meta: cached.meta,
              resolvedUrl: cached.resolvedUrl ?? mapsUrlFor(featureId),
              cached: true,
            });
          }

          // Cold path: nothing cached. Fetch preview (histogram + meta) in parallel with score scrape.
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
    '/api/places': {
      GET: () => {
        const now = Date.now();
        const DAY_MS = 24 * 60 * 60 * 1000;
        const places = cache.all()
          .map((e) => {
            const lastAccessTs = e.lastAccessTs ?? e.scoreTs;
            const accessCount = e.accessCount ?? 1;
            const days = (now - lastAccessTs) / DAY_MS;
            const frecency = accessCount * Math.pow(0.5, days / 30);
            return {
              featureId: e.featureId,
              name: e.name,
              scorePct: e.score.scorePct,
              resolvedUrl: e.resolvedUrl ?? mapsUrlFor(e.featureId),
              lastAccessTs,
              frecency,
            };
          })
          .sort((a, b) => b.frecency - a.frecency)
          .map(({ frecency, ...rest }) => rest);
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
          const reviewTexts = entry.score.reviews.map((r) => r.text).filter((t) => t.length > 30);
          const summary = await summarize(entry.name, reviewTexts.slice(0, 100));
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
          const tokens = await harvestTokens(url);
          if (!tokens.length) {
            console.warn(`[highlights] ${entry.name} (${featureId}): preview returned no chips — ${url}`);
            return json({ error: 'no highlights found for this place' }, 404);
          }
          const scored = await scoreHighlights(featureId, tokens);
          const totalFetched = scored.reduce((a, h) => a + (h.fetched ?? 0), 0);
          // Skip caching when every chip came back empty — likely a transient
          // upstream hiccup. 404 lets the next request retry.
          if (!totalFetched) {
            console.warn(
              `[highlights] ${entry.name} (${featureId}): all ${scored.length} chips fetched 0 reviews ` +
              `(likely upstream throttle). chips=[${scored.map((h) => h.label).join(', ')}] url=${url}`,
            );
            return json({ error: 'no highlights found for this place' }, 404);
          }
          console.log(`[highlights] ${entry.name} (${featureId}): ${scored.length} chips, ${totalFetched} reviews`);
          await cache.putHighlights(featureId, scored);
          return json({ highlights: scored, cached: false });
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
          const reviewTexts = (highlight.reviews ?? []).map((r) => r.text).filter((t) => t.length > 30);
          if (reviewTexts.length === 0) return json({ error: 'no review text available for this highlight' }, 400);
          const summary = await summarize(entry.name, reviewTexts.slice(0, 100), highlight.label);
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
            let trusted = 0, score = 0;
            const TRUSTED = 3;
            for (const r of reviews) {
              if (r.reviewerReviewCount < TRUSTED) continue;
              trusted++;
              if (r.stars === 5) score++;
              else if (r.stars === 1) score--;
            }
            result = {
              query: term,
              totalReviews: reviews.length,
              trustedReviews: trusted,
              scorePct: trusted ? Math.round((score / trusted) * 100) : 0,
              reviews,
              ts: Date.now(),
            };
          }

          if (doSummarize && (!result.summary || force)) {
            const reviewTexts = result.reviews.map((r) => r.text).filter((t) => t.length > 30);
            if (reviewTexts.length > 0) {
              result.summary = await summarize(entry.name, reviewTexts.slice(0, 100), term);
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
          const reviewTexts = entry.score.reviews.map((r) => r.text).filter((t) => t.length > 30);
          const answer = await ask(entry.name, reviewTexts.slice(0, 100), question);
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
