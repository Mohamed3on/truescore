import { expect, test } from 'bun:test';
import { jsonSchema, streamObject, wrapLanguageModel } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { strictJsonViaTool } from './deepseek';

test('a streamed object reads the strict tool call as it is written', async () => {
  let sent: any;
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: async (params) => {
        sent = params;
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-input-start', id: 'c1', toolName: 'json' },
            { type: 'tool-input-delta', id: 'c1', delta: '{"verdict":"Go' },
            { type: 'tool-input-delta', id: 'c1', delta: 'od"}' },
            { type: 'tool-input-end', id: 'c1' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'json', input: '{"verdict":"Good"}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
          ] as any),
        };
      },
    }),
    middleware: strictJsonViaTool,
  });
  const stream = streamObject({ model, schema: jsonSchema<{ verdict: string }>({ type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false }), prompt: 'p' });
  const partials: string[] = [];
  for await (const p of stream.partialObjectStream) partials.push(p.verdict ?? '');
  expect(await stream.object).toEqual({ verdict: 'Good' });
  expect(partials).toContain('Go');
  expect(sent.responseFormat).toBeUndefined();
  expect(sent.toolChoice).toEqual({ type: 'tool', toolName: 'json' });
});
