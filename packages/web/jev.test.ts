import { beforeEach, describe, expect, test } from 'bun:test';
import type { Review, Summary } from '@truescore/gmaps-shared';
import { answersFor, setJevClient, stanceOfReviews, stancesFor, withReceipts } from './jev';

// A fake Jev: answers each question by a rule over the review text inside it,
// and records every request so a test can see what was asked and how batched.
type Req = { state: any; questions: Record<string, any> };
let requests: Req[] = [];
let failNext = false;
const fake = (rule: (review: string, state: any, q: any) => any) => ({
  systemOne: (req: Req) => {
    requests.push(req);
    if (failNext) { failNext = false; return Promise.reject(new Error('boom')) as any; }
    const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, rule(q.instructions.review, req.state, q)]));
    return Promise.resolve({ answers, usage: { input_tokens: 100, output_tokens: 0 }, model: 'jev-test' }) as any;
  },
});
const stanceRule = (review: string) => ({ choice: /bad|awful/.test(review) ? 'complain' : /great|good/.test(review) ? 'praise' : 'off' });

let n = 0;
const uniq = (s: string) => `${s} #${++n}`; // fresh texts per test, past the shared memo

beforeEach(() => { requests = []; failNext = false; setJevClient(fake(stanceRule)); });

describe('stancesFor', () => {
  test('one question per review, the review inside it, the topic alone in the state, ≤20 a request', async () => {
    const texts = Array.from({ length: 45 }, (_, i) => uniq(i % 2 ? 'great parking' : 'bad parking'));
    const stances = await stancesFor('parking', texts);
    expect(stances).toHaveLength(45);
    expect(stances![0]).toBe('complain');
    expect(stances![1]).toBe('praise');
    expect(requests.map((r) => Object.keys(r.questions).length)).toEqual([20, 20, 5]);
    expect(requests[0]!.state).toEqual({ topic: 'parking' });
    expect(requests[0]!.questions.r0.instructions.review).toBe(texts[0]);
  });

  test('a judgement made once is never asked again', async () => {
    const texts = [uniq('great view'), uniq('bad view')];
    await stancesFor('view', texts);
    requests = [];
    expect(await stancesFor('view', [...texts].reverse())).toEqual(['complain', 'praise']);
    expect(requests).toHaveLength(0);
  });

  test('two callers after the same reviews at once pay for them once', async () => {
    const texts = [uniq('great coffee'), uniq('awful coffee')];
    const [a, b] = await Promise.all([stancesFor('coffee', texts), stancesFor('coffee', texts)]);
    expect(a).toEqual(['praise', 'complain']);
    expect(b).toEqual(a);
    expect(requests).toHaveLength(1);
  });

  test('a failed request gives null, never a partial count, and pauses Jev', async () => {
    failNext = true;
    expect(await stancesFor('staff', [uniq('great staff')])).toBeNull();
    expect(await stancesFor('staff', [uniq('great staff')])).toBeNull();
    expect(requests).toHaveLength(1);
  });

  test('without a key there is nothing to ask', async () => {
    setJevClient(null);
    expect(await stancesFor('staff', [uniq('great staff')])).toBeNull();
  });
});

describe('stanceOfReviews', () => {
  const review = (text: string, reviewerReviewCount = 10): Review => ({ reviewId: uniq('id'), stars: 5, reviewerReviewCount, timestamp: null, text });

  test('reads the trusted reviews with text — the ones TrueScore counts — keyed by reviewId', async () => {
    const reviews = [review(uniq('great parking')), review(uniq('bad parking')), review(uniq('awful parking'), 1), review('')];
    const result = await stanceOfReviews('parking', reviews);
    expect(result!.stance).toEqual({ praise: 1, complain: 1, mixed: 0, off: 0 });
    expect(result!.stances).toEqual({ [reviews[0]!.reviewId]: 'praise', [reviews[1]!.reviewId]: 'complain' });
    expect(result!.of).toBeUndefined();
  });

  test('nothing readable reads as no mentions', async () => {
    expect(await stanceOfReviews('parking', [review(uniq('great parking'), 1)])).toEqual({ stance: { praise: 0, complain: 0, mixed: 0, off: 0 }, stances: {} });
  });
});

describe('answersFor', () => {
  test('asks the question, not a topic', async () => {
    setJevClient(fake((r) => ({ choice: /no dogs/.test(r) ? 'no' : 'yes' })));
    expect(await answersFor('Are dogs allowed?', [uniq('dogs welcome'), uniq('no dogs inside')])).toEqual(['yes', 'no']);
    expect(requests[0]!.state).toEqual({ question: 'Are dogs allowed?' });
  });
});

describe('withReceipts', () => {
  const summary = (alternatives: string[] = []): Summary => ({
    verdict: 'v',
    highlights: [{ text: 'The penguins are a favourite', sentiment: 'positive' }, { text: 'Parking is a nightmare', sentiment: 'negative' }],
    alternatives,
  });
  // A review makes a point when it shares its key word.
  const pointRule = (review: string, state: any) => ({
    noul: state.point ? (review.includes(state.point.split(' ')[1].toLowerCase()) ? 0.9 : 0.1) : /rather go to Rival/.test(review) ? 0.9 : 0.1,
  });

  test('bullets carry their support and quotes; fewer than two supporters drops one', async () => {
    setJevClient(fake(pointRule));
    const reviewTexts = ['[2026-09-01] loved the penguins', '[undated] penguins!', '[2026-09-02] parking was hard', '[2026-09-01] loved the penguins'];
    const checked = await withReceipts(summary(), { placeName: 'Aquarium', reviewTexts });
    expect(checked.highlights).toEqual([{ text: 'The penguins are a favourite', sentiment: 'positive', support: 2, quotes: ['loved the penguins', 'penguins!'] }]);
  });

  test('a rival stays only when two reviews say they would rather go there', async () => {
    setJevClient(fake(pointRule));
    const reviewTexts = ['penguins a', 'penguins b', 'rather go to Rival Zoo', "I'd rather go to Rival Zoo", 'Other Zoo was fine'];
    const checked = await withReceipts(summary(['Rival Zoo', 'Other Zoo']), { placeName: 'Aquarium', reviewTexts });
    expect(checked.alternatives).toEqual(['Rival Zoo']);
    expect(checked.preferredBy).toEqual({ 'Rival Zoo': 2 });
  });

  test('unchanged when Jev cannot check it', async () => {
    setJevClient(null);
    const s = summary(['Rival Zoo']);
    expect(await withReceipts(s, { placeName: 'Aquarium', reviewTexts: ['x'] })).toBe(s);
  });
});
