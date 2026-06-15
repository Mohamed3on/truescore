// Pure parsing + cleanup of the structured-summary LLM output, split out of
// llm.ts so the fragile bits (truncated-JSON salvage, item hygiene) are testable
// through their own interface with fixture strings — no live model. llm.ts owns
// the prompts, the zod schema, and the SDK calls; this owns turning model text
// into clean Summary fields. See summary-parse.test.ts.
import type { SummaryHighlight } from '@truescore/gmaps-shared';

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

// Pull a string[] field out of partial/truncated JSON by regex, used by the
// salvage path below when the structured call was cut mid-array.
const salvageStringArray = (text: string, field: string): string[] => {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*\\[([^\\]]*)\\]`));
  return cleanItems(m?.[1]?.split(',').map((s) => s.replace(/^\s*"|"\s*$/g, '')));
};

// The structured call occasionally truncates at maxOutputTokens (cut mid-array
// → invalid JSON → NoObjectGeneratedError). Salvage the complete highlight
// objects from the raw text instead of failing the whole summary — the verdict
// is a separate call and is always worth returning.
export function salvageStructured(text: string): { highlights: SummaryHighlight[]; items: string[]; alternatives: string[]; valueForMoney: number } {
  const highlights: SummaryHighlight[] = [];
  for (const m of text.matchAll(/\{[^{}]*"text"[^{}]*\}/g)) {
    try { highlights.push(JSON.parse(m[0])); } catch {}
  }
  const vfm = text.match(/"valueForMoney"\s*:\s*(\d+)/);
  console.warn(`[summarize] structured JSON truncated; salvaged ${highlights.length} highlights`);
  return { highlights, items: salvageStringArray(text, 'items'), alternatives: salvageStringArray(text, 'alternatives'), valueForMoney: vfm ? Number(vfm[1]) : 3 };
}
