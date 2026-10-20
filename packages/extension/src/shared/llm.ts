import { DirectChatTransport, jsonSchema, ToolLoopAgent, type ChatTransport, type JSONSchema7, type LanguageModelUsage } from 'ai';
import { salvageString, salvageStringArray, searchesLeft, searchReviewsTool, writeObject, writeText, type AskMessage } from '@truescore/gmaps-shared';
import { modelCall } from '@truescore/gmaps-shared/models';
import { getActiveLLM } from './config';

// Every LLM call the extension makes itself (retail and book pages; Google Maps
// asks the server), on the popup's model and key, via AI SDK.

const PROVIDER_LABEL = { gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek', anthropic: 'Anthropic' };

// The popup key's day of summaries and Answers, counted: past RL_MAX the
// summary widgets stop offering Re-summarize.
const RL_KEY = 'ars-gemini-rate-limit';
export const RL_MAX = 20;

export const checkRateLimit = () => {
  let rl = JSON.parse(localStorage.getItem(RL_KEY) || '{"count":0,"resetAt":0}');
  if (Date.now() > rl.resetAt) rl = { count: 0, resetAt: Date.now() + 86400000 };
  return rl;
};

export const bumpRateLimit = () => {
  const rl = checkRateLimit();
  rl.count++;
  localStorage.setItem(RL_KEY, JSON.stringify(rl));
};

// The popup's provider and key, on that provider's settings (gmaps-shared/models.ts).
const activeModel = async () => {
  const { provider, key: apiKey, reasoningEffort } = await getActiveLLM();
  if (!apiKey) throw new Error(`No ${PROVIDER_LABEL[provider]} API key — set one in the TrueScore popup`);
  return modelCall(provider, { apiKey, reasoningEffort, browser: true });
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
// (authored strict: every property required, no extras). `onPartial` gets the
// text or object as far as it's written, each time it grows.
export const summarize = async (reviewTexts: string[], prompt: string, schema: JSONSchema7 | null, onPartial?: (partial: any) => void) => {
  const call = { ...await activeModel(), prompt: withReviews(prompt, reviewTexts) };
  if (!schema) {
    const { text, usage } = await writeText(call, onPartial);
    onUsage?.(usage);
    return text;
  }
  const { object, usage } = await writeObject({ ...call, schema: jsonSchema(schema) }, onPartial, (text) => salvageObject(text, schema));
  if (usage) onUsage?.(usage);
  return object;
};

const SEARCH_NOTE = `The reviews given are a sample; the rest can say otherwise. Unless the sample clearly settles the question, call searchReviews before answering: it searches every review. Check specifics such as what is allowed, accepted or charged even when the sample seems to answer them. Search the few words a review answering it would use, in English and in the language(s) the reviews are written in, with plurals and close synonyms, joined with " OR " (dog OR dogs OR Hund OR Hunde).`;
const SEARCH_DESCRIPTION = 'Search every review, not just the sample, for any of the terms. Returns how many reviews match (found); the net share of them rating 5★ over 1★ (scorePct, from -100 to 100, resting on trustedReviews rated ones — cite it when it helps); and the matches not already in the sample (reviews).';

// An Ask's model for runAsk, in-process: the site's `prompt` and the `sample`
// reviews as its instructions, and — when the page can Search — the
// searchReviews tool it answers; without one it answers in a single pass.
export const askTransport = async (prompt: string, sample: string[], canSearch: boolean) => new DirectChatTransport({
  agent: new ToolLoopAgent({
    ...await activeModel(),
    instructions: withReviews(canSearch ? `${prompt}\n\n${SEARCH_NOTE}` : prompt, sample),
    tools: canSearch ? { searchReviews: searchReviewsTool(sample, SEARCH_DESCRIPTION) } : {},
    prepareStep: ({ messages }) => (searchesLeft(messages) ? {} : { toolChoice: 'none' }),
  }),
}) as ChatTransport<AskMessage>;
