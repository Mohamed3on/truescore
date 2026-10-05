import { expect, test } from 'bun:test';
import { jsonSchema } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { writeObject, writeText } from './write';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage };
const streaming = (parts: unknown[]) => new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...parts] as any) }) });
const text = (deltas: string[]) => [{ type: 'text-start', id: 't' }, ...deltas.map((delta) => ({ type: 'text-delta', id: 't', delta })), { type: 'text-end', id: 't' }, finish];

test('a streamed text grows to what the call wrote', async () => {
  const seen: string[] = [];
  const { text: whole } = await writeText({ model: streaming(text(['Good ', 'food'])), prompt: 'p' }, (t) => seen.push(t));
  expect([seen, whole]).toEqual([['Good ', 'Good food'], 'Good food']);
});

test('a streamed text that fails throws its own error, not "no output"', async () => {
  const model = streaming([{ type: 'error', error: new Error('Incorrect API key') }]);
  expect(writeText({ model, prompt: 'p' }, () => {})).rejects.toThrow('Incorrect API key');
});

test('a streamed object is read as it is written', async () => {
  const seen: unknown[] = [];
  const schema = jsonSchema<{ verdict: string }>({ type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false });
  const { object } = await writeObject({ model: streaming(text(['{"verdict":"Go', 'od"}'])), prompt: 'p', schema }, (p) => seen.push(p));
  expect(object).toEqual({ verdict: 'Good' });
  expect(seen).toContainEqual({ verdict: 'Go' });
});
