import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, generateText, NoObjectGeneratedError, streamText, tool, type ModelMessage, type ToolResultPart } from 'ai';
import { z } from 'zod';
import { LLM_PROVIDERS, REASONING_EFFORTS, type AskEvent, type AskSearchResult, type Summary, type SummaryHighlight, type Provider, type ReasoningEffort } from '@truescore/gmaps-shared';
import { cleanItems, salvageStructured } from './summary-parse';
import { removalNote, type Subject } from './summary-subject';

export type { Summary, SummaryHighlight, Provider, ReasoningEffort, Subject };

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
    // GPT-5.6 Luna (the fast/cheap 5.6 tier), low reasoning effort. 2026-08-10
    // ladder evals (latency.ts + the bjjfanatics pin-escapes payload): judged
    // quality is identical from low through xhigh on both summary shapes, but
    // high/xhigh burn 20-60x the reasoning tokens for 2-8x the latency (82s and
    // 156s on a 44K-token payload vs 18s at low) — so keep the cheapest
    // thinking level. Beats nano:low on quality (4.7 vs 4.0) at ~2x its latency.
    //
    // Explicit prompt caching: GPT-5.6's default (implicit) mode bills a cache
    // write at 1.25x input on every request, at the end of the prompt, which
    // a call with a different ending never reads — so summaries and varied
    // questions paid 25% more for nothing. Explicit mode writes only at a
    // `promptCacheBreakpoint` we place (ask() puts one after the Sample).
    model: openai('gpt-5.6-luna'),
    providerOptions: { openai: { reasoningEffort: 'low', promptCacheOptions: { mode: 'explicit' as const } } },
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
// ignore reasoningEffort (it's gpt-5.6-luna only).
export const parseReasoningEffort = (v: unknown): ReasoningEffort | undefined =>
  typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v) ? (v as ReasoningEffort) : undefined;
export const parseProvider = (v: unknown): Provider | undefined =>
  typeof v === 'string' && (LLM_PROVIDERS as readonly string[]).includes(v) ? (v as Provider) : undefined;

const providerFor = (provider: Provider, effort?: ReasoningEffort) =>
  effort && provider === 'openai'
    ? { model: PROVIDERS.openai.model, providerOptions: { openai: { ...PROVIDERS.openai.providerOptions.openai, reasoningEffort: effort } } }
    : PROVIDERS[provider];

const active = (): Provider => {
  const p = process.env.LLM_PROVIDER;
  return p && (LLM_PROVIDERS as readonly string[]).includes(p) ? (p as Provider) : 'gemini';
};

// evals/compare.ts hooks this to collect per-call token usage; the server
// never sets it.
type UsageEvent = { provider: Provider; call: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
let onUsage: ((u: UsageEvent) => void) | undefined;
export const setOnUsage = (fn: typeof onUsage) => { onUsage = fn; };
const report = (provider: Provider, call: string, u: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }) =>
  onUsage?.({
    provider, call, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.inputTokenDetails?.cacheReadTokens ?? 0, cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
  });

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
//
// `removedReviews` on the subject (Google's takedown notice) is appended to both
// prompts via removalNote so the verdict is weighed as survivor-only; the model
// only speaks of it when the surviving text corroborates it (the UI already
// shows Google's banner).
export async function summarize({ placeName, reviewTexts, removedReviews }: Subject, filterQuery?: string, provider: Provider = active(), reasoningEffort?: ReasoningEffort): Promise<Summary> {
  const { model, providerOptions } = providerFor(provider, reasoningEffort);
  const subject = subjectOf(placeName, filterQuery);
  const block = reviewBlock(reviewTexts);
  const removal = removalNote(removedReviews);

  const verdictPrompt = `${block}\n\n---\n\nWrite a concise verdict on ${subject}: what stands out and whether it's worth it. Keep it about this place: only point to another place when many reviewers repeatedly name the same one as better — never a place they say is worse or that this place beats — and a one-off mention stays out, since alternatives are surfaced separately. Mention caveats only if the reviews raise real ones — don't invent them. **Bold** specifics. Markdown prose, no headings or bullets. Max 120 words.

${NOTES}${removal ? `\n\n${removal}` : ''}`;

  const structuredPrompt = `${block}\n\n---\n\nExtract highlights about ${subject} and rate value for money 1-5 from pricing mentions.

Each highlight: text (one concrete line, ≤20 words, specifics over adjectives), sentiment (positive/negative/neutral).

Also list items: up to 6 concrete things reviewers single out as what this place is known for — animals, exhibits, rides, dishes, products, a viewpoint, a named feature, anything specific people come for. Give each as a short label-search keyword biased toward recall: the term is searched against all reviews, so prefer the broadest word reviewers actually repeat — a term only one or two reviews contain makes a useless chip. One word when possible; drop prices, sizes, and qualifiers ("brunch menu €14" → "brunch", "Western Lowland Gorilla" → "gorilla"). Spell normally — never glue words together ("patatas bravas" → "bravas", not "patatasbravas"). Split a compound like "salmon avocado toast" into "salmon", "avocado". Keep a phrase only when the bare word is too ambiguous to search ("dirty" alone catches "dirty table", so "dirty burger"; "dulce de leche", not "leche"). Skip generic qualities every place has — service, staff, cleanliness, value. These must be things at THIS place. Empty list if nothing specific stands out.

Separately, list alternatives: proper names of OTHER places reviewers say are BETTER than this one — somewhere they'd rather go because it beats this place (common when they call this place overrated). Better only: skip any place mentioned as worse, or that reviewers say this place beats. Can be anywhere — a nearby swap or a better one in another city/country, not just local substitutes. Names only — never put these in items, since a place named as a better alternative is not a feature of this one. Use the short name reviewers actually write ("BrunchIt", not "BrunchIt Café & Terrace") so searching mentions of it matches. Empty list if reviewers name none.

${NOTES}${removal ? `\n\n${removal} If they do, add one negative highlight for it.` : ''}`;

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

// A Search's matches beyond the Sample, capped so a common word on a big place
// can't flood the context (texts arrive longest-first, the most substantive).
const SEARCH_HITS_MAX = 100;
// Rounds of Searches before the model must answer.
const SEARCH_ROUNDS_MAX = 2;

const SEARCH_NOTE = `The reviews given are a sample. When they don't settle the question, call searchReviews before answering: it searches every review of this place. Search the few words a review answering it would use, in English and in the language(s) the reviews are written in, with plurals and close synonyms, joined with " OR " (dog OR dogs OR Hund OR Hunde). When the sample settles it, just answer.`;
const SEARCH_FAILED = `Search is unavailable right now. Answer from the sample, and say you could only check part of the reviews.`;

// What every Ask shares leads the prompt — these instructions and the tool —
// then the place's Sample, closed by a cache breakpoint; only the scope and
// question vary after it. Each round and each new question on a place then
// reads everything up to the Sample back from the provider's prompt cache.
const ASK_INSTRUCTIONS = `Answer the question about the place using its reviews. Be concise. Name specifics (prices, hours, names) when relevant. Quote reviewer phrasing inline ("...") when it directly answers. If reviewers disagree or don't cover it, say so.

${NOTES}

${SEARCH_NOTE}`;
const CACHE_BREAKPOINT = { openai: { promptCacheBreakpoint: { mode: 'explicit' as const } } };

// No `execute`: calling it ends the round, and the call goes to the client,
// which runs the Search its own way and answers with the next request.
const searchReviews = tool({
  description: 'Search every review of this place, not just the sample, for any of the terms. Returns how many reviews match (found); their TrueScore (scorePct: the net share of trusted reviewers rating 5★ over 1★, from -100 to 100, resting on trustedReviews of them — cite it when it helps); and the matches not already in the sample (reviews).',
  inputSchema: z.object({ query: z.string().describe('Terms joined with " OR "') }),
});

export type AskRound = { question: string; history: ModelMessage[]; results: AskSearchResult[] };
export type AskOptions = { filterQuery?: string; provider?: Provider; reasoningEffort?: ReasoningEffort; abortSignal?: AbortSignal };

// One round of an Ask. The model either writes the Answer — streamed as deltas,
// then settled — or calls for Searches: `search` hands the client the calls and
// the round's messages, which come back verbatim as `history` with the matches
// as `results`, appended here as tool results. Nothing is kept between rounds.
export async function ask({ placeName, reviewTexts, removedReviews }: Subject, { question, history, results }: AskRound, emit: (e: AskEvent) => void, { filterQuery, provider = active(), reasoningEffort, abortSignal }: AskOptions = {}): Promise<void> {
  const { model, providerOptions } = providerFor(provider, reasoningEffort);
  const removal = removalNote(removedReviews);
  const seen = new Set(reviewTexts);
  const past: ModelMessage[] = results.length
    ? [...history, {
      role: 'tool',
      content: results.map(({ id, matches: m }): ToolResultPart => ({
        type: 'tool-result', toolCallId: id, toolName: 'searchReviews',
        output: m
          ? { type: 'json', value: { found: m.texts.length, scorePct: m.scorePct, trustedReviews: m.trustedReviews, reviews: m.texts.filter((t) => !seen.has(t)).slice(0, SEARCH_HITS_MAX) } }
          : { type: 'error-text', value: SEARCH_FAILED },
      })),
    }]
    : history;
  const searched = past.filter((m) => m.role === 'tool').length;

  const result = streamText({
    model, providerOptions, maxOutputTokens: 32768, abortSignal,
    instructions: ASK_INSTRUCTIONS,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: reviewBlock(reviewTexts), providerOptions: CACHE_BREAKPOINT },
        { type: 'text', text: `\n\n---\n\n${removal ? `${removal}\n\n` : ''}About: ${subjectOf(placeName, filterQuery)}\n\nQuestion: ${question}` },
      ],
    }, ...past],
    tools: { searchReviews },
    toolChoice: searched < SEARCH_ROUNDS_MAX ? 'auto' : 'none',
  });
  for await (const part of result.stream) {
    if (part.type === 'text-delta') emit({ type: 'delta', text: part.text });
    else if (part.type === 'error') throw part.error;
  }
  report(provider, 'ask', await result.usage);

  const calls = (await result.toolCalls).filter((c) => !c.dynamic);
  if (calls.length) {
    emit({ type: 'search', searches: calls.map((c) => ({ id: c.toolCallId, query: c.input.query })), history: [...past, ...await result.responseMessages] });
    return;
  }
  const answer = (await result.text).trim();
  if (!answer) throw new Error('No answer came back — try again');
  emit({ type: 'answer', answer });
}
