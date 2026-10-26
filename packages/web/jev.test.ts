import { beforeEach, describe, expect, test } from 'bun:test';
import type { Summary } from '@truescore/gmaps-shared';
import { answersFor, setJevClient, stancesFor, withReceipts } from './jev';

// A fake Jev: answers each question by a rule over the review text inside it,
// and records every request so a test can see what was asked and how batched.
type Req = { state: any; questions: Record<string, any> };

let requests: Req[] = [];
let failNext = false;

const fake = (rule: (review: string, state: any, q: any) => any) => ({
  systemOne: (req: Req) => {
    requests.push(req);

    if (failNext) {
      failNext = false;

      return Promise.reject(new Error('boom')) as any;
    }

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

  // A review makes a point when it shares its key word; one prefers a rival when it says it would rather go there.
  const rule = (review: string, state: any) => (state.point
    ? { noul: review.includes(state.point.split(' ')[1].toLowerCase()) ? 0.9 : 0.1 }
    : { choice: /rather go to/.test(review) ? 'yes' : /rather stay/.test(review) ? 'no' : 'none' });

  test('a review Google hands over twice makes a point once', async () => {
    setJevClient(fake(rule));
    const checked = await withReceipts(summary(), { placeName: 'Aquarium', reviewTexts: ['[2026-09-01] penguins!', '[2026-09-01] penguins!', '[2026-09-02] the penguins again'] });
    expect(checked.highlights.map((h) => h.support)).toEqual([2]);
  });

  test('a rival stays when the reviews naming it, in full or by its longest word, prefer it', async () => {
    setJevClient(fake(rule));
    const reviewTexts = ['penguins a', 'penguins b', 'rather go to Rival Zoo', "I'd rather go to the Rival", 'Other Zoo: rather go to it', 'Other Zoo? I would rather stay here', 'Other Zoo, I would rather stay'];
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
