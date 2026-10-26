import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Review, Summary } from '@truescore/gmaps-shared';
import { cache } from './cache';
import { checkedSummary } from './checked-summary';
import { fakeModel } from './fake-model';
import type { ScoreResult } from './gmaps';
import { setJevClient } from './jev';
import { setModel } from './llm';

// The model writes one verdict, one penguin bullet with "penguins" as its item,
// and "penguin" as that item's alias, once `aliasesDue` lets it.
let aliasesDue: Promise<void> = Promise.resolve();
let modelCalls = 0;

const model = fakeModel(async (fields) => {
  modelCalls++;

  if (!fields.length) return 'Worth it for the **penguins**.';

  if (fields.includes('highlights')) return JSON.stringify({ highlights: [{ text: 'The penguins are a favourite', sentiment: 'positive' }], items: ['penguins'], alternatives: [], valueForMoney: null });
  await aliasesDue;

  return JSON.stringify({ items: [{ name: 'penguins', aliases: ['penguin'] }] });
});

// Jev: a review makes the point when it mentions penguins.
let jevCalls = 0;

const jev = {
  systemOne: (req: { questions: Record<string, { instructions?: any }> }) => {
    jevCalls++;
    const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { noul: /penguin/.test(q.instructions.review) ? 0.9 : 0.1 }]));

    return Promise.resolve({ answers, usage: { input_tokens: 1, output_tokens: 0 }, model: 'jev-test' });
  },
};

beforeEach(() => { aliasesDue = Promise.resolve(); modelCalls = jevCalls = 0; setModel(model); setJevClient(jev); });

afterEach(() => { setModel(null); setJevClient(null); });

let n = 0;
const review = (text: string): Review => ({ reviewId: `r${++n}`, stars: 5, reviewerReviewCount: 10, timestamp: null, text });

// A Place this server looked up, its reviews fresh to Jev's memo.
const place = async () => {
  const featureId = `0x${++n}:0x1`;
  const reviews = [review(`loved the penguins ${n}`), review(`penguins! ${n}`), review(`parking was hard ${n}`)];
  const score: ScoreResult = { featureId, totalReviews: 3, trustedReviews: 3, scorePct: 90, relevant: { totalReviews: 3, trustedReviews: 3, scorePct: 90 }, newest: { totalReviews: 3, trustedReviews: 3, scorePct: 90 }, reviews };
  await cache.putScore(featureId, 'Aquarium', score, 3);

  return { featureId, reviews };
};

const unchecked: Summary = { verdict: 'Kept from before Jev.', highlights: [{ text: 'The penguins are a favourite', sentiment: 'positive' }] };

test("a Chip's or a Search's Summary never overwrites the Place's", async () => {
  const { featureId, reviews } = await place();
  await cache.putSummary(featureId, unchecked);
  await checkedSummary({ featureId, entry: cache.get(featureId), of: { chip: { token: 'tk', label: 'penguins', reviews } } });
  const search = { query: 'penguins', totalReviews: 3, trustedReviews: 3, scorePct: 90, reviews, ts: Date.now() };
  await cache.putSearch(featureId, 'penguins', search);
  await checkedSummary({ featureId, entry: cache.get(featureId), of: { search, keep: true } });
  const entry = cache.get(featureId)!;
  expect(entry.summary).toEqual(unchecked);
  expect(entry.highlightSummaries?.tk?.verdict).toBe('Worth it for the **penguins**.');
  expect(entry.searches?.penguins?.summary?.verdict).toBe('Worth it for the **penguins**.');
});

test('a cached Summary without Receipts is checked once and saved', async () => {
  const { featureId } = await place();
  await cache.putSummary(featureId, unchecked);
  const first = await checkedSummary({ featureId, entry: cache.get(featureId) });
  expect(first).toMatchObject({ cached: true, summary: { highlights: [{ support: 2 }] } });
  expect(cache.get(featureId)!.summary!.highlights[0]!.support).toBe(2);
  const reads = jevCalls;
  const again = await checkedSummary({ featureId, entry: cache.get(featureId) });
  expect([again.cached, again.summary.highlights[0]!.support, jevCalls, modelCalls]).toEqual([true, 2, reads, 0]);
});

test("a Place's aliases landing after its Summary are saved", async () => {
  const { featureId } = await place();
  let land!: () => void;
  aliasesDue = new Promise((go) => { land = go; });
  const { summary, cached, later } = await checkedSummary({ featureId, entry: cache.get(featureId) });
  expect([cached, summary.aliases, cache.get(featureId)!.summary!.aliases]).toEqual([false, undefined, undefined]);
  land();
  expect(await later).toEqual({ penguins: ['penguin'] });
  expect(cache.get(featureId)!.summary).toMatchObject({ verdict: 'Worth it for the **penguins**.', aliases: { penguins: ['penguin'] } });
});

test('a failed Summary keeps the Search results already saved', async () => {
  const { featureId, reviews } = await place();
  const search = { query: 'penguins', totalReviews: 3, trustedReviews: 3, scorePct: 90, reviews, ts: Date.now() };
  await cache.putSearch(featureId, 'penguins', search);
  setModel(fakeModel(() => { throw new Error('model down'); }));
  await expect(checkedSummary({ featureId, entry: cache.get(featureId), of: { search, keep: true } })).rejects.toThrow('model down');
  expect(cache.get(featureId)!.searches?.penguins).toEqual(search);
});
