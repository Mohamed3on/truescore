import { parseOrSalvage, salvageString, salvageStringArray } from '@truescore/gmaps-shared';
import { DEEPSEEK_ENDPOINT, DEEPSEEK_MODEL, geminiEndpoint, OPENAI_ENDPOINT, OPENAI_MODEL, type LLMProvider, type ReasoningEffort } from './config';

// Turning a prompt into a provider's request, and a provider's reply back into
// an object. Split out of review-summary.ts so both halves are pure: the fetch
// is the caller's, which makes the wire translation testable — three providers'
// request shapes and three error paths that previously only ran against a live
// model with a live API key.

export const PROVIDER_LABEL: Record<LLMProvider, string> = { gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' };

// OpenAI strict structured output wants every property required and
// additionalProperties: false at each level; Gemini-style `nullable` becomes a
// type union. Schemas stay authored in the Gemini-friendly shape.
export const toStrictSchema = (s: any): any => {
  if (s?.type === 'object') {
    return {
      ...s,
      properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toStrictSchema(v)])),
      required: Object.keys(s.properties),
      additionalProperties: false,
    };
  }
  if (s?.type === 'array') return { ...s, items: toStrictSchema(s.items) };
  if (s?.nullable) {
    const { nullable, ...rest } = s;
    return { ...rest, type: [rest.type, 'null'] };
  }
  return s;
};

export type LlmCall = { url: string; init: RequestInit };

/**
 * OpenAI and DeepSeek both speak the OpenAI Chat Completions API; they differ
 * only in endpoint/model and how thinking + structured output are requested.
 * Luna takes a strict json_schema and the popup's reasoning effort; DeepSeek has
 * no native schema mode, so we ask for json_object and pin the shape into the
 * prompt, and keep it non-thinking (its thinking ladder was slower for no
 * quality gain — see web evals/latency.ts).
 */
export const buildLlmCall = (
  provider: LLMProvider,
  key: string,
  prompt: string,
  schema: any,
  reasoningEffort: ReasoningEffort,
): LlmCall => {
  if (provider === 'openai' || provider === 'deepseek') {
    const isDeepseek = provider === 'deepseek';
    const content = isDeepseek && schema
      ? `${prompt}\n\nReturn ONLY a JSON object matching this schema (no markdown, no extra keys):\n${JSON.stringify(schema)}`
      : prompt;
    return {
      url: isDeepseek ? DEEPSEEK_ENDPOINT : OPENAI_ENDPOINT,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: isDeepseek ? DEEPSEEK_MODEL : OPENAI_MODEL,
          messages: [{ role: 'user', content }],
          ...(isDeepseek
            ? { thinking: { type: 'disabled' }, max_tokens: 8192, ...(schema && { response_format: { type: 'json_object' } }) }
            : {
                reasoning_effort: reasoningEffort,
                max_completion_tokens: 32768,
                ...(schema && { response_format: { type: 'json_schema', json_schema: { name: 'summary', strict: true, schema: toStrictSchema(schema) } } }),
              }),
        }),
      },
    };
  }
  const generationConfig: any = { thinkingConfig: { thinkingLevel: 'MINIMAL' }, maxOutputTokens: 32768 };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }
  return {
    url: geminiEndpoint(key),
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
    },
  };
};

/** The model's text, or a thrown error carrying whatever the provider said. */
export const readLlmText = (provider: LLMProvider, data: any): string => {
  if (provider === 'gemini') {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const raw = parts.filter((p: any) => !p.thought).pop()?.text;
    if (!raw) throw new Error(data?.error?.message || 'Empty Gemini response');
    return raw;
  }
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error(data?.error?.message || `Empty ${PROVIDER_LABEL[provider]} response`);
  return raw;
};

export type StructuredSummary = {
  complaints: string[];
  praised: string[];
  conclusion: string;
  betterAlternative?: string;
};

/**
 * Salvage for the extension's summary shape. A structured call cut at the token
 * cap leaves invalid JSON, and this used to be a bare JSON.parse — the whole
 * summary was thrown away over a truncated final bullet. The server has salvaged
 * this failure for a while; the field readers are shared now, so both do.
 */
export const salvageSummary = (text: string): StructuredSummary => {
  const complaints = salvageStringArray(text, 'complaints');
  const praised = salvageStringArray(text, 'praised');
  console.warn(`[truescore] summary JSON truncated; salvaged ${praised.length} praised / ${complaints.length} complaints`);
  return {
    complaints,
    praised,
    conclusion: salvageString(text, 'conclusion') ?? '',
    betterAlternative: salvageString(text, 'betterAlternative'),
  };
};

/** Schema'd calls parse (salvaging a truncated reply); free-form calls pass through. */
export const readLlmResult = (provider: LLMProvider, data: any, schema: any): any => {
  const raw = readLlmText(provider, data);
  return schema ? parseOrSalvage(raw, salvageSummary) : raw;
};
