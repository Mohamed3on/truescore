// Pure parsing of the structured-summary LLM output, split out of llm.ts so the
// fragile bit (truncated-JSON salvage) is testable through its own interface
// with fixture strings — no live model. llm.ts owns the prompts, the zod schema,
// and the SDK calls; this owns turning a cut-off reply into Summary fields. See
// summary-parse.test.ts.
import { salvageNumber, salvageObjects, salvageStringArray, type Summary, type SummaryHighlight } from '@truescore/gmaps-shared';

// Standouts and alternatives each fire one label search per entry, so the cap
// bounds the fan-out. What the entries say — no blanks, no duplicates — is the
// prompt's job, not ours.
export const MAX_SCORED_ITEMS = 10;
export const capItems = (items: string[]): string[] => items.slice(0, MAX_SCORED_ITEMS);

// A standout searches each of its aliases too (llm.aliasesFor), so they're
// capped as well.
export const MAX_ALIASES = 3;

// The aliases the model wrote, by item (Summary.aliases): only the items asked
// about, each alias once and never the item itself (the search ignores case), capped.
export const aliasesOf = (items: string[], written: { name: string; aliases: string[] }[]): Summary['aliases'] => {
  const aliases = Object.fromEntries(items.flatMap((item) => {
    const seen = new Set([item.toLowerCase()]);

    const kept = (written.find((w) => w.name === item)?.aliases ?? [])
      .filter((a) => {
        const k = a.trim().toLowerCase();

        return !!k && !seen.has(k) && !!seen.add(k);
      })
      .slice(0, MAX_ALIASES);

    return kept.length ? [[item, kept]] : [];
  }));

  return Object.keys(aliases).length ? aliases : undefined;
};

// The structured call occasionally truncates at maxOutputTokens (cut mid-array
// → invalid JSON → NoObjectGeneratedError). Salvage the complete highlight
// objects from the raw text instead of failing the whole summary — the verdict
// is a separate call and is always worth returning. valueForMoney stays unset
// when the cut came before it: the UI shows no rating rather than an invented one.
export function salvageStructured(text: string): { highlights: SummaryHighlight[]; items: string[]; alternatives: string[]; valueForMoney?: number } {
  const highlights = salvageObjects<SummaryHighlight>(text, 'text');
  console.warn(`[summarize] structured JSON truncated; salvaged ${highlights.length} highlights`);

  return {
    highlights,
    items: capItems(salvageStringArray(text, 'items')),
    alternatives: capItems(salvageStringArray(text, 'alternatives')),
    valueForMoney: salvageNumber(text, 'valueForMoney'),
  };
}
