import { test, expect, describe } from 'bun:test';
import type { ChatTransport, UIMessageChunk } from 'ai';
import { normalizeQuestion, runAsk, type AskMessage, type AskView } from './index';

// A transport that answers each round with the given chunks, keeping what it was sent.
const transport = (...rounds: UIMessageChunk[][]) => {
  const sent: AskMessage[][] = [];
  const t: ChatTransport<AskMessage> = {
    sendMessages: async ({ messages }) => {
      sent.push(structuredClone(messages));
      const chunks = rounds.shift()!;
      return new ReadableStream({ start(c) { chunks.forEach((chunk) => c.enqueue(chunk)); c.close(); } });
    },
    reconnectToStream: async () => null,
  };
  return { t, sent };
};
const text = (id: string, ...deltas: string[]): UIMessageChunk[] =>
  [{ type: 'text-start', id }, ...deltas.map((delta) => ({ type: 'text-delta' as const, id, delta })), { type: 'text-end', id }];
const call = (toolCallId: string, query: string): UIMessageChunk => ({ type: 'tool-input-available', toolCallId, toolName: 'searchReviews', input: { query } });

describe('runAsk', () => {
  test('answers in one round when the model needs no Search', async () => {
    const { t, sent } = transport([{ type: 'start' }, ...text('a', 'Ye', 's.'), { type: 'finish' }]);
    const views: AskView[] = [];
    expect(await runAsk(t, 'q', async () => null, (v) => views.push(v))).toEqual({ searches: [], text: 'Yes.', done: true });
    expect(sent).toHaveLength(1);
    expect(views.map((v) => v.text)).toContain('Ye');
  });

  test('runs the Searches the model calls, then continues with their matches', async () => {
    const { t, sent } = transport(
      [{ type: 'start' }, { type: 'start-step' }, ...text('a', 'Let me check'), call('c1', 'dog OR Hund'), { type: 'finish-step' }, { type: 'finish' }],
      [{ type: 'start' }, { type: 'start-step' }, ...text('b', 'Yes, dogs are welcome.'), { type: 'finish-step' }, { type: 'finish' }],
    );
    const matches = { texts: ['[2024-01-01] dog friendly', '[2024-02-01] Hunde willkommen'], scorePct: 80, trustedReviews: 2 };
    const views: AskView[] = [];
    const settled = await runAsk(t, 'Dogs?', async (_q, onFound) => { onFound(1); return matches; }, (v) => views.push(v));

    expect(sent[1]?.at(-1)?.parts).toContainEqual(expect.objectContaining({ toolCallId: 'c1', state: 'output-available', output: { ...matches, found: 2 } }));
    // The draft written before searching gave way; the row climbed, then settled.
    expect(views.find((v) => v.searches.length)?.text).toBe('');
    expect(views.map((v) => v.searches[0]?.found)).toContain(1);
    expect(settled).toEqual({ searches: [{ query: 'dog OR Hund', found: 2, done: true, scorePct: 80, trustedReviews: 2 }], text: 'Yes, dogs are welcome.', done: true });
  });

  test('a Search the client cannot run goes back as an error, and its row says so', async () => {
    const { t, sent } = transport(
      [{ type: 'start' }, call('c1', 'wifi'), { type: 'finish' }],
      [{ type: 'start' }, ...text('a', 'Only part of the reviews could be checked.'), { type: 'finish' }],
    );
    const settled = await runAsk(t, 'Wifi?', async () => { throw new Error('no session'); }, () => {});
    expect(sent[1]?.at(-1)?.parts).toContainEqual(expect.objectContaining({ toolCallId: 'c1', state: 'output-error' }));
    expect(settled.searches).toEqual([{ query: 'wifi', found: null, done: true }]);
  });

  test('text keeps the searches array, so a painter can skip rebuilding its rows', async () => {
    const { t } = transport(
      [{ type: 'start' }, call('c1', 'wifi'), { type: 'finish' }],
      [{ type: 'start' }, ...text('a', 'a', 'b'), { type: 'finish' }],
    );
    const views: AskView[] = [];
    await runAsk(t, 'Wifi?', async () => ({ texts: ['[2024-01-01] fast wifi'], scorePct: 100, trustedReviews: 1 }), (v) => views.push(v));
    const [a, b] = views.filter((v) => v.text === 'a' || v.text === 'ab');
    expect(b?.searches).toBe(a?.searches);
  });

  test('a replayed Answer paints the Searches behind it and when it was written', async () => {
    const { t, sent } = transport([
      { type: 'start', messageMetadata: { answeredAt: 1234 } },
      call('c1', 'dog'),
      { type: 'tool-output-available', toolCallId: 'c1', output: { found: 3, scorePct: 90, trustedReviews: 3, texts: [] } },
      ...text('a', 'Yes.'),
      { type: 'finish' },
    ]);
    expect(await runAsk(t, 'Dogs?', async () => null, () => {})).toEqual({ searches: [{ query: 'dog', found: 3, done: true, scorePct: 90, trustedReviews: 3 }], text: 'Yes.', done: true, answeredAt: 1234 });
    expect(sent).toHaveLength(1);
  });

  test('a round with no Answer and no Search is cut off; an error says what went wrong', async () => {
    await expect(runAsk(transport([{ type: 'start' }, { type: 'finish' }]).t, 'q', async () => null, () => {})).rejects.toThrow('cut off');
    await expect(runAsk(transport([{ type: 'start' }, ...text('a', 'half'), { type: 'error', errorText: 'quota exceeded' }]).t, 'q', async () => null, () => {})).rejects.toThrow('quota exceeded');
  });

  test('normalizeQuestion ignores case, spacing and trailing punctuation', () => {
    expect(normalizeQuestion('  Dogs   ALLOWED?! ')).toBe('dogs allowed');
    expect(normalizeQuestion('Is it loud？')).toBe('is it loud');
    expect(normalizeQuestion('Wi-Fi speed.')).toBe('wi-fi speed');
  });
});
