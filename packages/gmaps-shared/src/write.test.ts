import { expect, test } from 'bun:test';
import { jsonSchema } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { writeObject, writeText } from './write';

// What a model streams, as the AI SDK types it.
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish: StreamPart = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage };
const streaming = (parts: StreamPart[]) => new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...parts]) }) });
const text = (deltas: string[]): StreamPart[] => [{ type: 'text-start', id: 't' }, ...deltas.map((delta): StreamPart => ({ type: 'text-delta', id: 't', delta })), { type: 'text-end', id: 't' }, finish];

test('a streamed text grows to what the call wrote', async () => {
  const seen: string[] = [];
  const { text: whole } = await writeText({ model: streaming(text(['Good ', 'food'])), prompt: 'p' }, (t) => seen.push(t));
  expect([seen, whole]).toEqual([['Good ', 'Good food'], 'Good food']);
});

test('a streamed text that fails throws its own error, not "no output"', async () => {
  const model = streaming([{ type: 'error', error: new Error('Incorrect API key') }]);
  await expect(writeText({ model, prompt: 'p' }, () => {})).rejects.toThrow('Incorrect API key');
});

test('a streamed object is read as it is written', async () => {
  const seen: unknown[] = [];
  const schema = jsonSchema<{ verdict: string }>({ type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false });
  const { object } = await writeObject({ model: streaming(text(['{"verdict":"Go', 'od"}'])), prompt: 'p', schema }, (p) => seen.push(p));
  expect(object).toEqual({ verdict: 'Good' });
  expect(seen).toContainEqual({ verdict: 'Go' });
});

const schema = jsonSchema<{ verdict: string; items: string[] }>({ type: 'object', properties: { verdict: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } }, required: ['verdict', 'items'], additionalProperties: false });
const keepVerdict = (cut: string) => ({ verdict: cut.match(/"verdict":"([^"]*)"/)?.[1] ?? '', items: [] });
const whole = (reply: string) => new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: reply }], finishReason: { unified: 'length', raw: 'length' }, usage, warnings: [] }) });

test('an object cut off at the cap keeps what made it, whole or streamed', async () => {
  const cut = '{"verdict":"Good","items":["bra';
  expect((await writeObject({ model: whole(cut), prompt: 'p', schema }, undefined, keepVerdict)).object).toEqual({ verdict: 'Good', items: [] });
  expect((await writeObject({ model: streaming(text([cut])), prompt: 'p', schema }, () => {}, keepVerdict)).object).toEqual({ verdict: 'Good', items: [] });
});

test('a failed object call throws its own error, salvage or not', async () => {
  const model = streaming([{ type: 'error', error: new Error('Incorrect API key') }]);
  await expect(writeObject({ model, prompt: 'p', schema }, () => {}, keepVerdict)).rejects.toThrow('Incorrect API key');
});
