import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';

type Call = Parameters<MockLanguageModelV4['doGenerate']>[0];

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

// A model for tests (llm.setModel), so the server's model-calling code runs
// with no paid calls: each call, whole or streamed, gets `reply`'s text. A
// structured call is told apart by `fields`, the properties its schema asks
// for (none for plain text). A reply that throws fails the call.
export const fakeModel = (reply: (fields: string[], call: Call) => string | Promise<string>) => {
  const answer = (call: Call) =>
    reply(call.responseFormat?.type === 'json' ? Object.keys((call.responseFormat.schema as { properties?: object } | undefined)?.properties ?? {}) : [], call);

  return new MockLanguageModelV4({
    doGenerate: async (call) => ({ content: [{ type: 'text', text: await answer(call) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
    doStream: async (call) => {
      const text = await answer(call);

      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: text },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ]),
      };
    },
  });
};
