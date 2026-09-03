import { test, expect, describe } from 'bun:test';
import { buildLlmCall, readLlmResult, readLlmText, salvageSummary, toStrictSchema } from './llm-wire';

const SCHEMA = {
  type: 'object' as const,
  properties: {
    complaints: { type: 'array' as const, items: { type: 'string' as const } },
    praised: { type: 'array' as const, items: { type: 'string' as const } },
    conclusion: { type: 'string' as const },
    betterAlternative: { type: 'string' as const, nullable: true },
  },
  required: ['complaints', 'praised', 'conclusion'],
};

const bodyOf = (call: { init: RequestInit }) => JSON.parse(call.init.body as string);

describe('buildLlmCall', () => {
  test('OpenAI gets a strict json_schema and the popup reasoning effort', () => {
    const call = buildLlmCall('openai', 'k', 'prompt', SCHEMA, 'high');
    expect(call.url).toContain('api.openai.com');
    const body = bodyOf(call);
    expect(body.reasoning_effort).toBe('high');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect((call.init.headers as any).Authorization).toBe('Bearer k');
  });

  test('DeepSeek has no schema mode, so the shape goes into the prompt', () => {
    const call = buildLlmCall('deepseek', 'k', 'prompt', SCHEMA, 'low');
    const body = bodyOf(call);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.messages[0].content).toContain('"complaints"');
  });

  test('Gemini takes the schema natively and the key in the URL, not a header', () => {
    const call = buildLlmCall('gemini', 'secret-key', 'prompt', SCHEMA, 'low');
    expect(call.url).toContain('secret-key');
    expect((call.init.headers as any).Authorization).toBeUndefined();
    expect(bodyOf(call).generationConfig.responseSchema).toEqual(SCHEMA);
  });

  test('a free-form call asks for no structured output on any provider', () => {
    expect(bodyOf(buildLlmCall('openai', 'k', 'p', null, 'low')).response_format).toBeUndefined();
    expect(bodyOf(buildLlmCall('deepseek', 'k', 'p', null, 'low')).response_format).toBeUndefined();
    expect(bodyOf(buildLlmCall('gemini', 'k', 'p', null, 'low')).generationConfig.responseSchema).toBeUndefined();
  });
});

describe('toStrictSchema', () => {
  test('makes every property required and closes the object', () => {
    const strict = toStrictSchema(SCHEMA);
    expect(strict.required).toEqual(['complaints', 'praised', 'conclusion', 'betterAlternative']);
    expect(strict.additionalProperties).toBe(false);
  });

  test('nullable becomes a type union', () => {
    expect(toStrictSchema(SCHEMA).properties.betterAlternative).toEqual({ type: ['string', 'null'] });
  });
});

describe('readLlmText', () => {
  test('Gemini: skips thought parts and takes the last real one', () => {
    const data = { candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }, { text: 'answer' }] } }] };
    expect(readLlmText('gemini', data)).toBe('answer');
  });

  test("surfaces the provider's own error message rather than a generic one", () => {
    expect(() => readLlmText('openai', { error: { message: 'quota exceeded' } })).toThrow('quota exceeded');
    expect(() => readLlmText('gemini', { error: { message: 'bad key' } })).toThrow('bad key');
    expect(() => readLlmText('deepseek', {})).toThrow('Empty DeepSeek response');
  });
});

describe('readLlmResult', () => {
  const reply = (content: string) => ({ choices: [{ message: { content } }] });

  test('a complete reply parses', () => {
    const out = readLlmResult('openai', reply('{"praised":["a"],"complaints":[],"conclusion":"good"}'), SCHEMA);
    expect(out.praised).toEqual(['a']);
  });

  test('a truncated reply salvages instead of throwing away the summary', () => {
    // This was a bare JSON.parse: one cut-off bullet lost the whole summary.
    const out = readLlmResult('openai', reply('{"conclusion":"Solid.","praised":["battery","screen bright'), SCHEMA);
    expect(out.conclusion).toBe('Solid.');
    expect(out.praised).toEqual(['battery']);
    expect(out.complaints).toEqual([]);
  });

  test('a free-form call returns the text untouched', () => {
    expect(readLlmResult('openai', reply('not json at all'), null)).toBe('not json at all');
  });
});

describe('salvageSummary', () => {
  test('missing optional fields come back absent, not as garbage', () => {
    const out = salvageSummary('{"praised":["x"]');
    expect(out.conclusion).toBe('');
    expect(out.betterAlternative).toBeUndefined();
  });
});
