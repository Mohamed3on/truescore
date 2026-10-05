import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';

// DeepSeek's JSON mode only promises valid JSON: on a long review set the
// object can come back the wrong shape, or keep quoting reviews until the token
// cap (2 of 15 runs in web evals/latency.ts). A strict tool call holds its
// arguments to the schema at about the same latency (0 of 15), so each
// schema'd generate call goes out as one and its arguments come back as the
// text generateObject parses — a cut-off reply still reaches salvage. Streamed,
// the arguments arrive as the text streamObject reads, as they're written.
const asText = (part: LanguageModelV4StreamPart): LanguageModelV4StreamPart | null => {
  if (part.type === 'tool-input-start') return { type: 'text-start', id: part.id };
  if (part.type === 'tool-input-delta') return { type: 'text-delta', id: part.id, delta: part.delta };
  if (part.type === 'tool-input-end') return { type: 'text-end', id: part.id };
  return part.type === 'tool-call' ? null : part;
};
export const strictJsonViaTool: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params }) => {
    const format = params.responseFormat;
    if (format?.type !== 'json' || !format.schema) return params;
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
  wrapStream: async ({ doStream, params }) => {
    const result = await doStream();
    if (params.toolChoice?.type !== 'tool' || params.toolChoice.toolName !== 'json') return result;
    return {
      ...result,
      stream: result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          const text = asText(part);
          if (text) controller.enqueue(text);
        },
      })),
    };
  },
};

// DeepSeek serves strict tool calls only on its beta endpoint.
export const deepseekModel = (apiKey: string | undefined, modelId: string) =>
  wrapLanguageModel({ model: createDeepSeek({ apiKey, baseURL: 'https://api.deepseek.com/beta' })(modelId), middleware: strictJsonViaTool });
