import { test, expect, describe, afterEach } from 'bun:test';
import { normalizeQuestion, runAsk, type AskView } from './index';

const ndjson = (...events: object[]) =>
  new Response(events.map((e) => JSON.stringify(e) + '\n').join(''), { headers: { 'content-type': 'application/x-ndjson' } });

describe('runAsk', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  // Serves the given responses in order and records every request body.
  const serve = (...responses: Response[]) => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return responses.shift()!;
    }) as unknown as typeof fetch;
    return bodies;
  };

  test('answers in one round when the model needs no Search', async () => {
    serve(ndjson({ type: 'delta', text: 'Ye' }, { type: 'delta', text: 's.' }, { type: 'answer', answer: 'Yes.' }));
    const views: AskView[] = [];
    expect(await runAsk('/api/ask', { question: 'q' }, async () => null, (v) => views.push(v))).toBe('Yes.');
    expect(views.map((v) => v.text)).toEqual(['Ye', 'Yes.', 'Yes.']);
    expect(views.at(-1)?.done).toBe(true);
  });

  test('runs the requested Searches and asks again with the history and their matches', async () => {
    const history = [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'searchReviews', input: { query: 'dog OR Hund' } }] }];
    const bodies = serve(
      ndjson({ type: 'delta', text: 'Let me check' }, { type: 'search', searches: [{ id: 'c1', query: 'dog OR Hund' }], history }),
      ndjson({ type: 'delta', text: 'Yes' }, { type: 'answer', answer: 'Yes, dogs are welcome.' }),
    );
    const matches = { texts: ['[2024-01-01] dog friendly', '[2024-02-01] Hunde willkommen'], scorePct: 80, trustedReviews: 2 };
    const views: AskView[] = [];
    const answer = await runAsk('/api/ask', { question: 'Dogs?' }, async (_q, onFound) => { onFound(1); return matches; }, (v) => views.push(v));

    expect(answer).toBe('Yes, dogs are welcome.');
    expect(bodies[1]).toEqual({ question: 'Dogs?', history, results: [{ id: 'c1', matches }] });
    // The draft written before searching gave way; the row climbed, then settled.
    expect(views.find((v) => v.searches.length)?.text).toBe('');
    expect(views.map((v) => v.searches[0]?.found)).toContain(1);
    expect(views.at(-1)).toEqual({ searches: [{ query: 'dog OR Hund', found: 2, done: true, scorePct: 80, trustedReviews: 2 }], text: 'Yes, dogs are welcome.', done: true });
  });

  test('a Search the client cannot run goes back as null', async () => {
    const bodies = serve(
      ndjson({ type: 'search', searches: [{ id: 'c1', query: 'wifi' }], history: [] }),
      ndjson({ type: 'answer', answer: 'Only part of the reviews could be checked.' }),
    );
    const views: AskView[] = [];
    await runAsk('/api/ask', { question: 'Wifi?' }, async () => { throw new Error('no session'); }, (v) => views.push(v));
    expect(bodies[1].results).toEqual([{ id: 'c1', matches: null }]);
    expect(views.at(-1)?.searches).toEqual([{ query: 'wifi', found: null, done: true }]);
  });

  test('a delta keeps the searches array, so a painter can skip rebuilding its rows', async () => {
    serve(
      ndjson({ type: 'search', searches: [{ id: 'c1', query: 'wifi' }], history: [] }),
      ndjson({ type: 'delta', text: 'a' }, { type: 'delta', text: 'b' }, { type: 'answer', answer: 'ab' }),
    );
    const views: AskView[] = [];
    await runAsk('/api/ask', { question: 'Wifi?' }, async () => ({ texts: ['[2024-01-01] fast wifi'], scorePct: 100, trustedReviews: 1 }), (v) => views.push(v));
    const [a, b] = views.filter((v) => v.text === 'a' || v.text === 'ab');
    expect(b?.searches).toBe(a?.searches);
  });

  test('a replayed Answer paints the Searches behind it and when it was written', async () => {
    const searches = [{ query: 'dog', found: 3, done: true, scorePct: 90, trustedReviews: 3 }];
    serve(ndjson({ type: 'answer', answer: 'Yes.', searches, answeredAt: 1234 }));
    const views: AskView[] = [];
    await runAsk('/api/ask', { question: 'Dogs?' }, async () => null, (v) => views.push(v));
    expect(views.at(-1)).toEqual({ searches, text: 'Yes.', done: true, answeredAt: 1234 });
  });

  test('normalizeQuestion ignores case, spacing and trailing punctuation', () => {
    expect(normalizeQuestion('  Dogs   ALLOWED?! ')).toBe('dogs allowed');
    expect(normalizeQuestion('Is it loud？')).toBe('is it loud');
    expect(normalizeQuestion('Wi-Fi speed.')).toBe('wi-fi speed');
  });

  test('a stream that ends with neither an answer nor a Search is an error', async () => {
    serve(ndjson({ type: 'delta', text: 'half' }));
    await expect(runAsk('/api/ask', { question: 'q' }, async () => null, () => {})).rejects.toThrow('cut off');
  });
});
