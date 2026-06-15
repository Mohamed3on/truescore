import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, generateText, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import { LLM_PROVIDERS, REASONING_EFFORTS, type Summary, type SummaryHighlight, type Provider, type ReasoningEffort } from '@truescore/gmaps-shared';
import { cleanItems, salvageStructured } from './summary-parse';

export type { Summary, SummaryHighlight, Provider, ReasoningEffort };

// The providers all run the same prompts and schema so the models are directly
// comparable (see evals/compare.ts). LLM_PROVIDER=gemini|openai|deepseek picks
// the active one; defaults to Gemini. The google provider reads GEMINI_API_KEY
// (this repo's name for it), not the SDK default GOOGLE_GENERATIVE_AI_API_KEY;
// deepseek reads DEEPSEEK_API_KEY.
const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });

export const PROVIDERS = {
  gemini: {
    model: google('gemini-3-flash-preview'),
    providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' as const } } },
  },
  openai: {
    // Low reasoning effort — about as fast as no reasoning while still thinking
    // a little; medium/high roughly double nano's latency (see evals/latency.ts).
    model: openai('gpt-5.4-nano'),
    providerOptions: { openai: { reasoningEffort: 'low' } },
  },
  deepseek: {
    // V4 Flash, non-thinking: ties nano/flash on latency+quality at a fraction
    // of the cost (evals/latency.ts). Its thinking ladder runs 2.5-7x slower
    // for no quality gain, so it stays disabled. No native JSON-schema output —
    // the SDK injects the schema into the prompt (compat mode), which the
    // summarize() salvage path already tolerates.
    model: deepseek('deepseek-v4-flash'),
    providerOptions: { deepseek: { thinking: { type: 'disabled' as const } } },
  },
};

// Validate untrusted request-body overrides against the canonical wire lists
// (gmaps-shared/wire.ts): the server only honors a configured provider/effort,
// never one injected from the body. Unset → active() default. Gemini/DeepSeek
// ignore reasoningEffort (it's gpt-5.4-nano only).
export const parseReasoningEffort = (v: unknown): ReasoningEffort | undefined =>
  typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v) ? (v as ReasoningEffort) : undefined;
export const parseProvider = (v: unknown): Provider | undefined =>
  typeof v === 'string' && (LLM_PROVIDERS as readonly string[]).includes(v) ? (v as Provider) : undefined;

const providerFor = (provider: Provider, effort?: ReasoningEffort) =>
  effort && provider === 'openai'
    ? { model: PROVIDERS[provider].model, providerOptions: { openai: { reasoningEffort: effort } } }
    : PROVIDERS[provider];

const active = (): Provider => {
  const p = process.env.LLM_PROVIDER;
  return p && (LLM_PROVIDERS as readonly string[]).includes(p) ? (p as Provider) : 'gemini';
};

// evals/compare.ts hooks this to collect per-call token usage; the server
// never sets it.
type UsageEvent = { provider: Provider; call: string; inputTokens: number; outputTokens: number };
let onUsage: ((u: UsageEvent) => void) | undefined;
export const setOnUsage = (fn: typeof onUsage) => { onUsage = fn; };
const report = (provider: Provider, call: string, u: { inputTokens?: number; outputTokens?: number }) =>
  onUsage?.({ provider, call, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 });

const NOTES = `On factual disagreements (price, hours), trust the more recent review. Reviews come first; fold in general knowledge where they're silent.`;

// Deliberately shape-only (plus the sentiment enum): an eval'd attempt to move
// the field instructions into .describe() + min/max bounds regressed both
// providers — nano leaked reasoning into items and named cities as
// alternatives, gemini's highlights shrank and valueForMoney came back
// Infinity. Field semantics live in structuredPrompt; content hygiene
// (dedupe, junk tokens) in cleanItems.
const HIGHLIGHTS_SCHEMA = z.object({
  highlights: z.array(
    z.object({
      text: z.string(),
      sentiment: z.enum(['positive', 'negative', 'neutral']),
    }),
  ),
  items: z.array(z.string()),
  alternatives: z.array(z.string()),
  valueForMoney: z.number().int(),
});

const reviewBlock = (texts: string[]) => texts.join('\n\n');

const subjectOf = (place: string, filter?: string) => {
  const p = place || 'this place';
  return filter ? `"${filter}" at ${p}` : p;
};

// Structured-output mode mangles markdown prose (Gemini strips \n\n inside
// string fields), so the prose verdict and structured highlights run as two
// parallel calls. Input tokens overlap on the review block; output is clean
// both ways.
export async function summarize(placeName: string, reviewTexts: string[], filterQuery?: string, provider: Provider = active(), reasoningEffort?: ReasoningEffort): Promise<Summary> {
  const { model, providerOptions } = providerFor(provider, reasoningEffort);
  const subject = subjectOf(placeName, filterQuery);
  const block = reviewBlock(reviewTexts);

  const verdictPrompt = `${block}\n\n---\n\nWrite a concise verdict on ${subject}: what stands out and whether it's worth it. Keep it about this place: only point to another place when many reviewers repeatedly name the same one as better — never a place they say is worse or that this place beats — and a one-off mention stays out, since alternatives are surfaced separately. Mention caveats only if the reviews raise real ones — don't invent them. **Bold** specifics. Markdown prose, no headings or bullets. Max 120 words.

${NOTES}`;

  const structuredPrompt = `${block}\n\n---\n\nExtract highlights about ${subject} and rate value for money 1-5 from pricing mentions.

Each highlight: text (one concrete line, ≤20 words, specifics over adjectives), sentiment (positive/negative/neutral).

Also list items: up to 6 concrete things reviewers single out as what this place is known for — animals, exhibits, rides, dishes, products, a viewpoint, a named feature, anything specific people come for. Give each as a short label-search keyword biased toward recall: the term is searched against all reviews, so prefer the broadest word reviewers actually repeat — a term only one or two reviews contain makes a useless chip. One word when possible; drop prices, sizes, and qualifiers ("brunch menu €14" → "brunch", "Western Lowland Gorilla" → "gorilla"). Spell normally — never glue words together ("patatas bravas" → "bravas", not "patatasbravas"). Split a compound like "salmon avocado toast" into "salmon", "avocado". Keep a phrase only when the bare word is too ambiguous to search ("dirty" alone catches "dirty table", so "dirty burger"; "dulce de leche", not "leche"). Skip generic qualities every place has — service, staff, cleanliness, value. These must be things at THIS place. Empty list if nothing specific stands out.

Separately, list alternatives: proper names of OTHER places reviewers say are BETTER than this one — somewhere they'd rather go because it beats this place (common when they call this place overrated). Better only: skip any place mentioned as worse, or that reviewers say this place beats. Can be anywhere — a nearby swap or a better one in another city/country, not just local substitutes. Names only — never put these in items, since a place named as a better alternative is not a feature of this one. Use the short name reviewers actually write ("BrunchIt", not "BrunchIt Café & Terrace") so searching mentions of it matches. Empty list if reviewers name none.

${NOTES}`;

  const [verdict, structured] = await Promise.all([
    generateText({ model, providerOptions, maxOutputTokens: 1024, prompt: verdictPrompt }).then((r) => {
      report(provider, 'verdict', r.usage);
      return r.text;
    }),
    generateObject({ model, providerOptions, maxOutputTokens: 8192, schema: HIGHLIGHTS_SCHEMA, prompt: structuredPrompt })
      .then((r) => {
        report(provider, 'structured', r.usage);
        return { ...r.object, items: cleanItems(r.object.items), alternatives: cleanItems(r.object.alternatives) };
      })
      .catch((e) => {
        if (NoObjectGeneratedError.isInstance(e) && e.text) return salvageStructured(e.text);
        throw e;
      }),
  ]);
  return { verdict: verdict.trim(), ...structured };
}

export async function ask(placeName: string, reviewTexts: string[], question: string, filterQuery?: string, provider: Provider = active(), reasoningEffort?: ReasoningEffort): Promise<string> {
  const { model, providerOptions } = providerFor(provider, reasoningEffort);
  const prompt = `${reviewBlock(reviewTexts)}\n\n---\n\nAnswer about ${subjectOf(placeName, filterQuery)} using the reviews. Be concise. Name specifics (prices, hours, names) when relevant. Quote reviewer phrasing inline ("...") when it directly answers. If reviewers disagree or don't cover it, say so.

${NOTES}

Question: ${question}`;
  const r = await generateText({ model, providerOptions, maxOutputTokens: 32768, prompt });
  report(provider, 'ask', r.usage);
  return r.text;
}
