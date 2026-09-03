// Reading fields out of the JSON a model didn't finish writing.
//
// Structured-output calls truncate at the token cap — cut mid-array, so the text
// is not valid JSON and JSON.parse throws away everything the model did manage
// to say. The server has salvaged around that for a while; the extension, which
// hits the same providers with the same failure, just called JSON.parse and lost
// the whole summary.
//
// The two summary shapes are genuinely different (the server extracts
// highlights/items/alternatives/valueForMoney, the extension
// complaints/praised/conclusion/betterAlternative), so what is shared is not a
// salvage *result* but the field readers underneath it. Each side builds its own
// salvage on these; both stop throwing.
//
// Deliberately regex, not a streaming JSON parser: the input is malformed by
// definition, and a parser that could handle it would be a bigger thing to trust
// than the four readers below.

/** Every `"field": "…"` string value. Undefined when the field never appeared. */
export const salvageString = (text: string, field: string): string | undefined => {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m?.[1]) return undefined;
  try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]; }
};

/** A `"field": 12` numeric value. Undefined when absent or unreadable. */
export const salvageNumber = (text: string, field: string): number | undefined => {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return m ? Number(m[1]) : undefined;
};

/**
 * The elements of a `"field": [...]` string array. Reads the array as far as it
 * was written: a closing bracket ends it, and a truncated array runs to the end
 * of the text, so the last (partial) element is dropped rather than guessed.
 */
export const salvageStringArray = (text: string, field: string): string[] => {
  const open = text.match(new RegExp(`"${field}"\\s*:\\s*\\[`));
  if (open?.index == null) return [];
  const body = text.slice(open.index + open[0].length);
  const close = body.indexOf(']');
  const inner = close === -1 ? body : body.slice(0, close);
  const out: string[] = [];
  for (const m of inner.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    try { out.push(JSON.parse(`"${m[1]}"`) as string); } catch { out.push(m[1] ?? ''); }
  }
  // A truncated array ends mid-string; that fragment has no closing quote and so
  // never matched above. Nothing to drop.
  return out;
};

/**
 * Every complete `{…}` object in the text that mentions `key`. Objects are
 * flat-only (no nested braces), which is what these schemas emit, and anything
 * that doesn't parse is skipped — an interrupted final object is simply lost.
 */
export const salvageObjects = <T>(text: string, key: string): T[] => {
  const out: T[] = [];
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    if (!m[0].includes(`"${key}"`)) continue;
    try { out.push(JSON.parse(m[0]) as T); } catch {}
  }
  return out;
};

/**
 * Parse `text` as JSON, falling back to `salvage` when it is malformed. The one
 * call site shape both packages share: the model usually finishes, and when it
 * doesn't, a partial answer beats no answer.
 */
export const parseOrSalvage = <T>(text: string, salvage: (raw: string) => T): T => {
  try { return JSON.parse(text) as T; } catch { return salvage(text); }
};
