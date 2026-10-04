import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { convertToModelMessages, generateObject, generateText, NoObjectGeneratedError, streamObject, streamText } from 'ai';
import { z } from 'zod';
import { LLM_PROVIDERS, questionOf, REASONING_EFFORTS, searchesLeft, searchReviewsTool, type AskMessage, type Summary, type SummaryHighlight, type Provider, type ReasoningEffort } from '@truescore/gmaps-shared';
import { deepseekModel } from '@truescore/gmaps-shared/deepseek';
import { capItems, MAX_SCORED_ITEMS, salvageStructured } from './summary-parse';
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

export const PROVIDERS = {
  gemini: {
    model: google('gemini-3-flash-preview'),
    providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' as const } } },
  },
  openai: {
    // GPT-6 Luna (the fast/cheap GPT-6 tier), low reasoning effort. 2026-09-22
    // evals against GPT-5.6 Luna at low (gpt-6-sol judge): its summaries are
    // terser but beat 5.6's 26-6 once grounding counts the weight of evidence
    // (5.6's extra detail overstated consensus), 1.5-3x faster at about half
    // the cost; Ask quality matches. Medium effort brought back 5.6's
    // latency for no gain, and 5.6's ladder showed high/xhigh burning 20-60x
    // the reasoning tokens for no quality gain — so keep the cheapest level.
    //
    // Explicit prompt caching: Luna's default (implicit) mode bills a cache
    // write at 1.25x input on every request, at the end of the prompt, which
    // a call with a different ending never reads — so summaries and varied
    // questions paid 25% more for nothing. Explicit mode writes only at a
    // `promptCacheBreakpoint` we place (ask() puts one after the Sample).
    model: openai('gpt-6-luna'),
    providerOptions: { openai: { reasoningEffort: 'low', promptCacheOptions: { mode: 'explicit' as const } } },
  },
  deepseek: {
    // V4.1 Flash, non-thinking. V4 Flash tied nano/flash on latency+quality at
    // a fraction of the cost (evals/latency.ts) and its thinking ladder ran
    // 2.5-7x slower for no quality gain, so it stays disabled. Structured
    // output goes through a strict tool call (gmaps-shared/deepseek.ts).
    model: deepseekModel(process.env.DEEPSEEK_API_KEY, 'deepseek-flash'),
    providerOptions: { deepseek: { thinking: { type: 'disabled' as const } } },
  },
};

// Validate untrusted request-body overrides against the canonical wire lists
// (gmaps-shared/wire.ts): the server only honors a configured provider/effort,
// never one injected from the body. Unset → active() default. Gemini/DeepSeek
// ignore reasoningEffort (it's gpt-6-luna only).
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
// Infinity. Field semantics and content hygiene (no duplicates, no placeholder
// entries) live in structuredRequest's prompt; the code only caps the fan-out (capItems).
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

// The structured half of summarize(): its exact prompt, schema and output cap.
// evals/latency.ts times this same request across models.
export const structuredRequest = ({ placeName, reviewTexts, removedReviews }: Subject, filterQuery?: string) => {
  const removal = removalNote(removedReviews);
  return {
    maxOutputTokens: 8192,
    schema: HIGHLIGHTS_SCHEMA,
    prompt: `${reviewBlock(reviewTexts)}\n\n---\n\nExtract highlights about ${subjectOf(placeName, filterQuery)} and rate value for money 1-5 from pricing mentions.

Each highlight: text (one concrete line, ≤20 words, specifics over adjectives), sentiment (positive/negative/neutral).

Also list items: up to ${MAX_SCORED_ITEMS} concrete things reviewers single out as what this place is known for — animals, exhibits, rides, dishes, products, a viewpoint, a named feature, anything specific people come for. Give each as a short label-search keyword biased toward recall: the term is searched against all reviews, so prefer the broadest word reviewers actually repeat — a term only one or two reviews contain makes a useless chip. One word when possible; drop prices, sizes, and qualifiers ("brunch menu €14" → "brunch", "Western Lowland Gorilla" → "gorilla"). Spell normally — never glue words together ("patatas bravas" → "bravas", not "patatasbravas"). Split a compound like "salmon avocado toast" into "salmon", "avocado". Keep a phrase only when the bare word is too ambiguous to search ("dirty" alone catches "dirty table", so "dirty burger"; "dulce de leche", not "leche"). Skip generic qualities every place has — service, staff, cleanliness, value. These must be things at THIS place. Empty list if nothing specific stands out.

Separately, list alternatives: proper names of OTHER places reviewers say are BETTER than this one — somewhere they'd rather go because it beats this place (common when they call this place overrated). Better only: skip any place mentioned as worse, or that reviewers say this place beats. Can be anywhere — a nearby swap or a better one in another city/country, not just local substitutes. Names only — never put these in items, since a place named as a better alternative is not a feature of this one. Use the short name reviewers actually write ("BrunchIt", not "BrunchIt Café & Terrace") so searching mentions of it matches. Empty list if reviewers name none.

In both lists each entry appears once — no duplicates or spelling variants of the same term — and an empty list is an empty array with no placeholder entry.

${NOTES}${removal ? `\n\n${removal} If they do, add one negative highlight for it.` : ''}`,
  };
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

  const [verdict, structured] = await Promise.all([
    generateText({ model, providerOptions, maxOutputTokens: 1024, prompt: verdictPrompt }).then((r) => {
      report(provider, 'verdict', r.usage);
      return r.text;
    }),
    generateObject({ model, providerOptions, ...structuredRequest({ placeName, reviewTexts, removedReviews }, filterQuery) })
      .then((r) => {
        report(provider, 'structured', r.usage);
        return { ...r.object, items: capItems(r.object.items), alternatives: capItems(r.object.alternatives) };
      })
      .catch((e) => {
        if (NoObjectGeneratedError.isInstance(e) && e.text) return salvageStructured(e.text);
        throw e;
      }),
  ]);
  return { verdict: verdict.trim(), ...structured };
}

const SEARCH_NOTE = `The reviews given are a sample. When they don't settle the question, call searchReviews before answering: it searches every review of this place. Search the few words a review answering it would use, in English and in the language(s) the reviews are written in, with plurals and close synonyms, joined with " OR " (dog OR dogs OR Hund OR Hunde). When the sample settles it, just answer.`;

// What every Ask shares leads the prompt — these instructions and the tool —
// then the place's Sample, closed by a cache breakpoint; only the scope and
// question vary after it. Each round and each new question on a place then
// reads everything up to the Sample back from the provider's prompt cache.
const ASK_INSTRUCTIONS = `Answer the question about the place using its reviews. Be concise. Name specifics (prices, hours, names) when relevant. Quote reviewer phrasing inline ("...") when it directly answers. If reviewers disagree or don't cover it, say so.

${NOTES}

${SEARCH_NOTE}`;
const CACHE_BREAKPOINT = { openai: { promptCacheBreakpoint: { mode: 'explicit' as const } } };

const SEARCH_DESCRIPTION = 'Search every review of this place, not just the sample, for any of the terms. Returns how many reviews match (found); their TrueScore (scorePct: the net share of trusted reviewers rating 5★ over 1★, from -100 to 100, resting on trustedReviews of them — cite it when it helps); and the matches not already in the sample (reviews).';

export type AskOptions = { filterQuery?: string; provider?: Provider; reasoningEffort?: ReasoningEffort; abortSignal?: AbortSignal };

// One round of an Ask (see AskMessage): the model streams the Answer, or calls
// for Searches, which end the round.
export async function ask({ placeName, reviewTexts, removedReviews }: Subject, messages: AskMessage[], { filterQuery, provider = active(), reasoningEffort, abortSignal }: AskOptions = {}) {
  const { model, providerOptions } = providerFor(provider, reasoningEffort);
  const removal = removalNote(removedReviews);
  const tools = { searchReviews: searchReviewsTool(reviewTexts, SEARCH_DESCRIPTION) };
  const history = await convertToModelMessages(messages.slice(1), { tools });
  return streamText({
    model, providerOptions, maxOutputTokens: 32768, abortSignal,
    instructions: ASK_INSTRUCTIONS,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: reviewBlock(reviewTexts), providerOptions: CACHE_BREAKPOINT },
        { type: 'text', text: `\n\n---\n\n${removal ? `${removal}\n\n` : ''}About: ${subjectOf(placeName, filterQuery)}\n\nQuestion: ${questionOf(messages)}` },
      ],
    }, ...history],
    tools,
    toolChoice: searchesLeft(history) ? 'auto' : 'none',
    onFinish: ({ usage }) => report(provider, 'ask', usage),
  });
}

// ---- A Reddit Thread's Options (the Tally, CONTEXT.md) ----

// Shape-only like HIGHLIGHTS_SCHEMA: what each field holds lives in the prompt.
const OPTIONS_SCHEMA = z.object({
  options: z.array(z.object({
    name: z.string(),
    aliases: z.array(z.string()),
    titles: z.array(z.object({ name: z.string(), aliases: z.array(z.string()) })),
  })),
});
export type ThreadOption = z.infer<typeof OPTIONS_SCHEMA>['options'][number];

// The listing call's exact prompt, schema and output cap. The model only names
// the Options and how the thread writes them; it never counts. Jev reads every
// comment naming one (web/tally.ts), so a title's aliases must not repeat its
// maker's, or every mention of the maker would be read as one of the title.
export const optionsRequest = (question: string, comments: string[]) => ({
  maxOutputTokens: 8192,
  schema: OPTIONS_SCHEMA,
  prompt: `Question:\n${question}\n\n---\n\nAnswers:\n\n${comments.join('\n\n')}\n\n---\n\nList the Options these answers recommend or warn against: the things the asker could choose, such as a product, a course, a place or a service. Include one even if a single answer names it, and one they only warn against.

Use two levels when the answers name makers: each Option is the maker (a brand, a creator, a company) and its titles are the specific products, courses or models named under it. A thing with no maker named in the thread is an Option of its own, with no titles. Name a title only when the answers give the product a name of its own ("WH-1000XM5", "QuietComfort Ultra"); a description ("their wireless pair", "the double one") is not a title. Give each name in its usual full form ("Sony"; "WH-1000XM5").

aliases: every other way the answers write it, exactly as written: first names, surnames, nicknames, abbreviations, misspellings, partial titles ("Sonys", "Soni"; "XM5", "1000xm5"), so that searching for any of them finds every answer speaking of it. Skip variants that differ only in capital letters or punctuation ("sony", "Sony's", "WH 1000XM5"): the search already matches those. A title's aliases never include its maker's name alone, and an alias that could just as well mean another Option or title (a first name two of them share, a title two makers both use) is left out.

Not Options: stores and marketplaces, general advice ("try before you buy"), kinds of thing ("wireless ones", "an open-back pair"), or the asker's own situation. Each Option and title once.`,
});

// Streams the listing: each Option goes to `onOption` once the model has moved
// on to the next one (the last when the list ends), so counting it can start
// while the rest are still being written.
export async function listOptions(question: string, comments: string[], onOption: (o: Partial<ThreadOption>) => void, provider: Provider = active(), reasoningEffort?: ReasoningEffort): Promise<ThreadOption[]> {
  const { model, providerOptions } = providerFor(provider, reasoningEffort);
  const listing = streamObject({ model, providerOptions, ...optionsRequest(question, comments) });
  let sent = 0;
  for await (const partial of listing.partialObjectStream) {
    const options = partial.options ?? [];
    while (sent < options.length - 1) onOption(options[sent++] as Partial<ThreadOption>);
  }
  const { options } = await listing.object;
  while (sent < options.length) onOption(options[sent++]!);
  report(provider, 'options', await listing.usage);
  return options;
}

// Why people back or warn against each Option, in a line, written only from
// the comments that name it (the ones Jev reads), so it can't stray from the
// Tally beside it. Reasons, never counts. One field per
// Option, under its key: given a list, the model wrote one line per course and
// every line after it landed on the next Option.
// Each comment goes in once, numbered, and each Option lists the numbers of
// the comments naming it: a comment naming three Options isn't paid for three
// times.
type ReasonGroup = { key: string; option: string; comments: number[] };
export const reasonsRequest = (question: string, comments: string[], groups: ReasonGroup[]) => ({
  maxOutputTokens: 4096,
  schema: z.object(Object.fromEntries(groups.map((g) => [g.key, z.string()]))),
  prompt: `Question:\n${question}\n\n---\n\nComments:\n\n${comments.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}\n\n---\n\nOptions, each with the comments that name it:\n${groups.map((g) => `${g.key} (${g.option}): ${g.comments.map((i) => i + 1).join(', ')}`).join('\n')}\n\nUnder each option's key, say in one line of at most 20 words why its comments rate it well or badly: what they like about it and what they warn about, in their own reasons, not general knowledge. Describe the option; don't address the asker. No counts, shares or votes: those are shown beside it.`,
});

// Streams each line to `onReason` once the model has started the next key (the
// model writes them in the schema's order), the last when it ends.
export async function explainOptions(question: string, comments: string[], groups: ReasonGroup[], onReason: (key: string, why: string) => void, provider: Provider = active(), reasoningEffort?: ReasoningEffort): Promise<Record<string, string>> {
  const { model, providerOptions } = providerFor(provider, reasoningEffort);
  const writing = streamObject({ model, providerOptions, ...reasonsRequest(question, comments, groups) });
  const keys = groups.map((g) => g.key);
  let sent = 0;
  for await (const partial of writing.partialObjectStream) {
    while (sent < keys.length - 1 && (partial as Record<string, unknown>)[keys[sent + 1]!] !== undefined) {
      onReason(keys[sent]!, String((partial as Record<string, unknown>)[keys[sent]!] ?? ''));
      sent++;
    }
  }
  const reasons = (await writing.object) as Record<string, string>;
  while (sent < keys.length) { onReason(keys[sent]!, reasons[keys[sent]!] ?? ''); sent++; }
  report(provider, 'reasons', await writing.usage);
  return reasons;
}
