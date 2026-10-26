import { test, expect, describe, mock, beforeEach } from 'bun:test';
import type { ChatTransport, UIMessageChunk } from 'ai';
import type { AskMessage, AskView } from '@truescore/gmaps-shared';
import * as realJev from './jev';

// Jev's answer read, faked: every match says yes. The rest of the module stays
// real (module mocks are process-wide).
const readFor: Array<[string, string[]]> = [];

mock.module('./jev', () => ({
  ...realJev,
  readAnswers: async (question: string, texts: string[]) => {
    readFor.push([question, texts]);

    return texts.map(() => 'yes');
  },
}));

const { askReviews } = await import('./review-ask');
const { findQA } = await import('./qa-history');
const { checkRateLimit } = await import('./llm');

// A chat transport that answers each round with the given chunks.
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

const text = (id: string, delta: string): UIMessageChunk[] => [{ type: 'text-start', id }, { type: 'text-delta', id, delta }, { type: 'text-end', id }];
const call = (toolCallId: string, query: string): UIMessageChunk => ({ type: 'tool-input-available', toolCallId, toolName: 'searchReviews', input: { query } });
const matches = { texts: ['[2024-01-01] dogs welcome', '[2024-02-01] brought our dog'], scorePct: 100, trustedReviews: 2 };

beforeEach(() => { localStorage.clear(); readFor.length = 0; });

describe('askReviews', () => {
  test("each Search's matches get Jev's read, and the settled view keeps it", async () => {
    const { t } = transport(
      [{ type: 'start' }, call('c1', 'dog OR dogs'), { type: 'finish' }],
      [{ type: 'start' }, ...text('a', 'Yes, dogs are welcome.'), { type: 'finish' }],
    );

    let painted: Map<string, unknown> | undefined;

    const view = await askReviews({
      question: 'Dogs?', transport: async () => t, search: async () => matches, live: () => true,
      mount: (reads) => {
        painted = reads;

        return () => {};
      },
    });

    expect(readFor).toEqual([['Dogs?', matches.texts]]);
    expect(painted?.get('dog OR dogs')).toEqual({ yes: 2, no: 0, unclear: 0, none: 0 });
    expect(view.searches).toEqual([{ query: 'dog OR dogs', done: true, found: 2, scorePct: 100, trustedReviews: 2, answers: { yes: 2, no: 0, unclear: 0, none: 0 } }]);
  });

  test('leaving stops the Ask: its stream is aborted and nothing more is painted', async () => {
    // The Answer's first words, then the rest a moment later — unless aborted first.
    let signal: AbortSignal | undefined;

    const t: ChatTransport<AskMessage> = {
      sendMessages: async ({ abortSignal }) => {
        signal = abortSignal;

        return new ReadableStream({
          start(c) {
            for (const chunk of [{ type: 'start' }, { type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'Half' }] satisfies UIMessageChunk[]) c.enqueue(chunk);
            abortSignal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
            setTimeout(() => { if (!abortSignal?.aborted) c.enqueue({ type: 'text-delta', id: 'a', delta: ' and more' }); }, 5);
          },
        });
      },
      reconnectToStream: async () => null,
    };

    let live = true;
    const texts: string[] = [];

    // The user leaves once the first words are on screen.
    const run = askReviews({ question: 'Dogs?', transport: async () => t, live: () => live, qaKey: 'ask-test', mount: () => (v) => {
      texts.push(v.text);

      if (v.text) live = false;
    } });

    await expect(run).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    expect(texts.at(-1)).toBe('Half');
    expect(findQA('ask-test', 'Dogs?')).toBeUndefined();
  });

  test('a kept Answer replays with its Searches and calls no model', async () => {
    const first = transport(
      [{ type: 'start' }, call('c1', 'dog'), { type: 'finish' }],
      [{ type: 'start' }, ...text('a', 'Yes.'), { type: 'finish' }],
    );

    await askReviews({ question: 'Dogs allowed?', transport: async () => first.t, search: async () => matches, live: () => true, mount: () => () => {}, qaKey: 'ask-test' });

    let asked = false;
    const views: AskView[] = [];

    const replay = await askReviews({
      question: 'dogs allowed', transport: async () => {
        asked = true;

        return first.t;
      }, live: () => true,
      mount: () => (v) => views.push(v), qaKey: 'ask-test',
    });

    expect(asked).toBe(false);
    expect(views).toEqual([replay]);
    expect(replay).toMatchObject({ text: 'Yes.', done: true, searches: [{ query: 'dog', found: 2, answers: { yes: 2 } }] });
    expect(replay.answeredAt).toBeNumber();
  });

  test('with no Search it answers in one pass, kept and counted', async () => {
    const { t, sent } = transport([{ type: 'start' }, ...text('a', 'Fits true to size.'), { type: 'finish' }]);
    let canSearch: boolean | undefined;
    const before = checkRateLimit().count;

    const view = await askReviews({
      question: 'Sizing?', transport: async (can) => {
        canSearch = can;

        return t;
      }, live: () => true,
      mount: () => () => {}, qaKey: 'ask-test', limited: true,
    });

    expect(canSearch).toBe(false);
    expect(sent).toHaveLength(1);
    expect(view.text).toBe('Fits true to size.');
    expect(findQA('ask-test', 'sizing')?.a).toBe('Fits true to size.');
    expect(checkRateLimit().count).toBe(before + 1);
  });
});
