import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, generateText, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import type { Summary, SummaryHighlight } from '@truescore/gmaps-shared';

export type { Summary, SummaryHighlight };

// Both providers run the same prompts and schema so the models are directly
// comparable (see evals/compare.ts). LLM_PROVIDER=gemini|openai picks the
// active one; defaults to Gemini. The google provider reads GEMINI_API_KEY
// (this repo's name for it), not the SDK default GOOGLE_GENERATIVE_AI_API_KEY.
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
    // gpt-5.4-nano spends no reasoning tokens by default, matching Gemini's
    // minimal thinking level — don't set reasoningEffort.
    model: openai('gpt-5.4-nano'),
    providerOptions: {},
  },
};
export type Provider = keyof typeof PROVIDERS;

const active = (): Provider => (process.env.LLM_PROVIDER === 'openai' ? 'openai' : 'gemini');

// evals/compare.ts hooks this to collect per-call token usage; the server
// never sets it.
type UsageEvent = { provider: Provider; call: string; inputTokens: number; outputTokens: number };
let onUsage: ((u: UsageEvent) => void) | undefined;
export const setOnUsage = (fn: typeof onUsage) => { onUsage = fn; };
const report = (provider: Provider, call: string, u: { inputTokens?: number; outputTokens?: number }) =>
  onUsage?.({ provider, call, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 });

const NOTES = `On factual disagreements (price, hours), trust the more recent review. Reviews come first; fold in general knowledge where they're silent.`;

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

// Praised standout terms: trim, drop blanks and letterless junk ("[]", "—" —
// models occasionally echo the empty-list notation as an element), dedupe
// case-insensitively, cap 6 (auto-scoring fires one label search per item, so
// the cap bounds the fan-out).
const cleanItems = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    const k = t.toLowerCase();
    if (!t || !/[\p{L}\p{N}]/u.test(t) || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 6) break;
  }
  return out;
};

// The structured call occasionally truncates at maxOutputTokens (cut mid-array
// → invalid JSON → NoObjectGeneratedError). Salvage the complete highlight
// objects from the raw text instead of failing the whole summary — the verdict
// is a separate call and is always worth returning.
const salvageStringArray = (text: string, field: string): string[] => {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*\\[([^\\]]*)\\]`));
  return cleanItems(m?.[1]?.split(',').map((s) => s.replace(/^\s*"|"\s*$/g, '')));
};

function salvageStructured(text: string): { highlights: SummaryHighlight[]; items: string[]; alternatives: string[]; valueForMoney: number } {
  const highlights: SummaryHighlight[] = [];
  for (const m of text.matchAll(/\{[^{}]*"text"[^{}]*\}/g)) {
    try { highlights.push(JSON.parse(m[0])); } catch {}
  }
  const vfm = text.match(/"valueForMoney"\s*:\s*(\d+)/);
  console.warn(`[summarize] structured JSON truncated; salvaged ${highlights.length} highlights`);
  return { highlights, items: salvageStringArray(text, 'items'), alternatives: salvageStringArray(text, 'alternatives'), valueForMoney: vfm ? Number(vfm[1]) : 3 };
}

const reviewBlock = (texts: string[]) => texts.join('\n\n');

const subjectOf = (place: string, filter?: string) => {
  const p = place || 'this place';
  return filter ? `"${filter}" at ${p}` : p;
};

// Structured-output mode mangles markdown prose (Gemini strips \n\n inside
// string fields), so the prose verdict and structured highlights run as two
// parallel calls. Input tokens overlap on the review block; output is clean
// both ways.
export async function summarize(placeName: string, reviewTexts: string[], filterQuery?: string, provider: Provider = active()): Promise<Summary> {
  const { model, providerOptions } = PROVIDERS[provider];
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

export async function ask(placeName: string, reviewTexts: string[], question: string, filterQuery?: string, provider: Provider = active()): Promise<string> {
  const { model, providerOptions } = PROVIDERS[provider];
  const prompt = `${reviewBlock(reviewTexts)}\n\n---\n\nAnswer about ${subjectOf(placeName, filterQuery)} using the reviews. Be concise. Name specifics (prices, hours, names) when relevant. Quote reviewer phrasing inline ("...") when it directly answers. If reviewers disagree or don't cover it, say so.

${NOTES}

Question: ${question}`;
  const r = await generateText({ model, providerOptions, maxOutputTokens: 32768, prompt });
  report(provider, 'ask', r.usage);
  return r.text;
}
