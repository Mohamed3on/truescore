// Pure parsing + cleanup of the structured-summary LLM output, split out of
// llm.ts so the fragile bits (truncated-JSON salvage, item hygiene) are testable
// through their own interface with fixture strings — no live model. llm.ts owns
// the prompts, the zod schema, and the SDK calls; this owns turning model text
// into clean Summary fields. See summary-parse.test.ts.
import { salvageNumber, salvageObjects, salvageStringArray, type SummaryHighlight } from '@truescore/gmaps-shared';

// Praised standout terms: trim, drop blanks and letterless junk ("[]", "—" —
// models occasionally echo the empty-list notation as an element), dedupe
// case-insensitively, cap 6 (auto-scoring fires one label search per item, so
// the cap bounds the fan-out).
export const cleanItems = (raw: unknown): string[] => {
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
export function salvageStructured(text: string): { highlights: SummaryHighlight[]; items: string[]; alternatives: string[]; valueForMoney: number } {
  const highlights = salvageObjects<SummaryHighlight>(text, 'text');
  console.warn(`[summarize] structured JSON truncated; salvaged ${highlights.length} highlights`);
  return {
    highlights,
    items: cleanItems(salvageStringArray(text, 'items')),
    alternatives: cleanItems(salvageStringArray(text, 'alternatives')),
    valueForMoney: salvageNumber(text, 'valueForMoney') ?? 3,
  };
}
