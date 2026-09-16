import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, generateText, jsonSchema, NoObjectGeneratedError, stepCountIs, streamText, tool, type JSONSchema7, type LanguageModel } from 'ai';
import { z } from 'zod';
import { salvageString, salvageStringArray, type AskSearch, type AskView, type SearchReviews } from '@truescore/gmaps-shared';
import { DEEPSEEK_MODEL, GEMINI_MODEL, getActiveLLM, OPENAI_MODEL } from './shared/config';

// Every LLM call the extension makes itself, on the popup's model and key, via
// AI SDK. Its own bundle (build.ts), imported on first use (shared/llm.ts) so
// page scripts don't carry the SDK.

const PROVIDER_LABEL = { gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' };

// Luna at the popup's reasoning effort; Gemini and DeepSeek non-thinking
// (DeepSeek's thinking ladder was slower for no quality gain — web evals/latency.ts).
const activeModel = async (): Promise<{ model: LanguageModel; providerOptions: Record<string, Record<string, any>>; maxOutputTokens: number }> => {
  const { provider, key: apiKey, reasoningEffort } = await getActiveLLM();
  if (!apiKey) throw new Error(`No ${PROVIDER_LABEL[provider]} API key — set one in the TrueScore popup`);
  if (provider === 'gemini') return { model: createGoogleGenerativeAI({ apiKey })(GEMINI_MODEL), providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } }, maxOutputTokens: 32768 };
  if (provider === 'deepseek') return { model: createDeepSeek({ apiKey })(DEEPSEEK_MODEL), providerOptions: { deepseek: { thinking: { type: 'disabled' } } }, maxOutputTokens: 8192 };
  return { model: createOpenAI({ apiKey })(OPENAI_MODEL), providerOptions: { openai: { reasoningEffort } }, maxOutputTokens: 32768 };
};

// Reviews arrive in the page's locale (amazon.es, booking.de, …), so without the
// English pin the model answers in that language. toWellFormed: site APIs can
// truncate text mid-emoji (Decathlon cuts titles at 30 UTF-16 units), and the
// lone surrogate left behind makes OpenAI reject the request body.
const withReviews = (prompt: string, reviewTexts: string[]) =>
  `${prompt}\n\nAlways respond in English, even if the reviews are written in another language.\n\nReviews:\n\n${reviewTexts.join('\n---\n')}`.toWellFormed();

// A structured reply cut off at the token cap isn't valid JSON: keep every
// field that made it rather than lose the whole summary.
export const salvageObject = (text: string, schema: JSONSchema7) =>
  Object.fromEntries(Object.entries(schema.properties ?? {}).map(([field, p]) =>
    [field, (p as JSONSchema7).type === 'array' ? salvageStringArray(text, field) : salvageString(text, field) ?? '']));

// One pass over the reviews: free-form text, or an object matching `schema`
// (authored strict: every property required, no extras).
export const summarize = async (reviewTexts: string[], prompt: string, schema: JSONSchema7 | null) => {
  const call = { ...await activeModel(), prompt: withReviews(prompt, reviewTexts) };
  if (!schema) return (await generateText(call)).text;
  try {
    return (await generateObject({ ...call, schema: jsonSchema(schema) })).object;
  } catch (e) {
    if (NoObjectGeneratedError.isInstance(e) && e.text) return salvageObject(e.text, schema);
    throw e;
  }
};

// Rounds of Searches before the model must answer, as on Google Maps (web/llm.ts).
const SEARCH_ROUNDS_MAX = 2;
const SEARCH_HITS_MAX = 100;

const SEARCH_NOTE = `The reviews given are a sample. When they don't settle the question, call searchReviews before answering: it searches every review. Search the few words a review answering it would use, in English and in the language(s) the reviews are written in, with plurals and close synonyms, joined with " OR " (dog OR dogs OR Hund OR Hunde). When the sample settles it, just answer.`;
const SEARCH_FAILED = `Search is unavailable right now. Answer from the sample, and say you could only check part of the reviews.`;

// Ask `prompt` of the `sample` reviews, streaming every change to `onView`. The
// model may call searchReviews, run through the page's own `search` as a row,
// before it answers. Resolves to the settled view.
export const streamAsk = async (sample: string[], prompt: string, search: SearchReviews, onView: (v: AskView) => void, abortSignal: AbortSignal): Promise<AskView> => {
  let view: AskView = { searches: [], text: '', done: false };
  const paint = (next: Partial<AskView>) => onView((view = { ...view, ...next }));
  const setRow = (i: number, patch: Partial<AskSearch>) =>
    paint({ searches: view.searches.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const seen = new Set(sample);
  const searchReviews = tool({
    description: 'Search every review, not just the sample, for any of the terms. Returns how many reviews match (found); the net share of them rating 5★ over 1★ (scorePct, from -100 to 100, resting on trustedReviews rated ones — cite it when it helps); and the matches not already in the sample (reviews).',
    inputSchema: z.object({ query: z.string().describe('Terms joined with " OR "') }),
    // Text the model wrote before searching gives way to the Answer after.
    execute: async ({ query }) => {
      const i = view.searches.length;
      paint({ text: '', searches: [...view.searches, { query, found: 0, done: false }] });
      const m = await search(query, (found) => setRow(i, { found })).catch(() => null);
      setRow(i, m ? { found: m.texts.length, done: true, scorePct: m.scorePct, trustedReviews: m.trustedReviews } : { found: null, done: true });
      return m
        ? { found: m.texts.length, scorePct: m.scorePct, trustedReviews: m.trustedReviews, reviews: m.texts.filter((t) => !seen.has(t)).slice(0, SEARCH_HITS_MAX) }
        : SEARCH_FAILED;
    },
  });

  const result = streamText({
    ...await activeModel(),
    prompt: withReviews(`${prompt}\n\n${SEARCH_NOTE}`, sample),
    tools: { searchReviews },
    stopWhen: stepCountIs(SEARCH_ROUNDS_MAX + 1),
    prepareStep: ({ stepNumber }) => (stepNumber === SEARCH_ROUNDS_MAX ? { toolChoice: 'none' } : {}),
    abortSignal,
  });
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') paint({ text: view.text + part.text });
    else if (part.type === 'error') throw part.error;
  }
  const text = (await result.text).trim();
  if (!text) throw new Error('No answer came back — try again');
  paint({ text, done: true });
  return view;
};
