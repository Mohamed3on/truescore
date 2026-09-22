import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { DirectChatTransport, generateObject, generateText, jsonSchema, NoObjectGeneratedError, ToolLoopAgent, type ChatTransport, type JSONSchema7, type LanguageModel, type LanguageModelUsage } from 'ai';
import { salvageString, salvageStringArray, searchesLeft, searchReviewsTool, type AskMessage } from '@truescore/gmaps-shared';
import { deepseekModel } from '@truescore/gmaps-shared/deepseek';
import { DEEPSEEK_MODEL, GEMINI_MODEL, getActiveLLM, OPENAI_MODEL } from './config';

// Every LLM call the extension makes itself (retail and book pages; Google Maps
// asks the server), on the popup's model and key, via AI SDK.

const PROVIDER_LABEL = { gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' };

// Luna at the popup's reasoning effort; Gemini and DeepSeek non-thinking
// (DeepSeek's thinking ladder was slower for no quality gain — web evals/latency.ts).
const activeModel = async (): Promise<{ model: LanguageModel; providerOptions: Record<string, Record<string, any>>; maxOutputTokens: number }> => {
  const { provider, key: apiKey, reasoningEffort } = await getActiveLLM();
  if (!apiKey) throw new Error(`No ${PROVIDER_LABEL[provider]} API key — set one in the TrueScore popup`);
  if (provider === 'gemini') return { model: createGoogleGenerativeAI({ apiKey })(GEMINI_MODEL), providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } }, maxOutputTokens: 32768 };
  if (provider === 'deepseek') return { model: deepseekModel(apiKey, DEEPSEEK_MODEL), providerOptions: { deepseek: { thinking: { type: 'disabled' } } }, maxOutputTokens: 8192 };
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

// web/evals/bjjfanatics.ts hooks this to collect token usage; the extension
// never sets it.
let onUsage: ((usage: LanguageModelUsage) => void) | undefined;
export const setOnUsage = (fn: typeof onUsage) => { onUsage = fn; };

// One pass over the reviews: free-form text, or an object matching `schema`
// (authored strict: every property required, no extras).
export const summarize = async (reviewTexts: string[], prompt: string, schema: JSONSchema7 | null) => {
  const call = { ...await activeModel(), prompt: withReviews(prompt, reviewTexts) };
  if (!schema) {
    const { text, usage } = await generateText(call);
    onUsage?.(usage);
    return text;
  }
  try {
    const { object, usage } = await generateObject({ ...call, schema: jsonSchema(schema) });
    onUsage?.(usage);
    return object;
  } catch (e) {
    if (NoObjectGeneratedError.isInstance(e) && e.text) return salvageObject(e.text, schema);
    throw e;
  }
};

const SEARCH_NOTE = `The reviews given are a sample. When they don't settle the question, call searchReviews before answering: it searches every review. Search the few words a review answering it would use, in English and in the language(s) the reviews are written in, with plurals and close synonyms, joined with " OR " (dog OR dogs OR Hund OR Hunde). When the sample settles it, just answer.`;
const SEARCH_DESCRIPTION = 'Search every review, not just the sample, for any of the terms. Returns how many reviews match (found); the net share of them rating 5★ over 1★ (scorePct, from -100 to 100, resting on trustedReviews rated ones — cite it when it helps); and the matches not already in the sample (reviews).';

// An Ask's model for runAsk, in-process: the site's `prompt` and the `sample`
// reviews as its instructions, and the searchReviews tool the page answers.
export const askTransport = async (prompt: string, sample: string[]) => new DirectChatTransport({
  agent: new ToolLoopAgent({
    ...await activeModel(),
    instructions: withReviews(`${prompt}\n\n${SEARCH_NOTE}`, sample),
    tools: { searchReviews: searchReviewsTool(sample, SEARCH_DESCRIPTION) },
    prepareStep: ({ messages }) => (searchesLeft(messages) ? {} : { toolChoice: 'none' }),
  }),
}) as ChatTransport<AskMessage>;
