import { createDeepSeek } from '@ai-sdk/deepseek';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';

// DeepSeek's JSON mode only promises valid JSON: on a long review set the
// object can come back the wrong shape, or keep quoting reviews until the token
// cap (2 of 15 runs in web evals/latency.ts). A strict tool call holds its
// arguments to the schema at about the same latency (0 of 15), so each
// schema'd generate call goes out as one and its arguments come back as the
// text generateObject parses — a cut-off reply still reaches salvage.
const strictJsonViaTool: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ type, params }) => {
    const format = params.responseFormat;
    if (type !== 'generate' || format?.type !== 'json' || !format.schema) return params;
    return {
      ...params,
      responseFormat: undefined,
      tools: [{ type: 'function', name: 'json', inputSchema: format.schema, strict: true }],
      toolChoice: { type: 'tool', toolName: 'json' },
    };
  },
  wrapGenerate: async ({ doGenerate, params }) => {
    const result = await doGenerate();
    if (params.toolChoice?.type !== 'tool' || params.toolChoice.toolName !== 'json') return result;
    return { ...result, content: result.content.map((part) => (part.type === 'tool-call' ? { type: 'text' as const, text: part.input } : part)) };
  },
};

// DeepSeek serves strict tool calls only on its beta endpoint.
export const deepseekModel = (apiKey: string | undefined, modelId: string) =>
  wrapLanguageModel({ model: createDeepSeek({ apiKey, baseURL: 'https://api.deepseek.com/beta' })(modelId), middleware: strictJsonViaTool });
