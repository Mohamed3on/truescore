import type { Summary, SummaryHighlight } from '@truescore/gmaps-shared';

export type { Summary, SummaryHighlight };

const KEY = process.env.GEMINI_API_KEY!;
const MODEL = 'gemini-3-flash-preview';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

const NOTES = `On factual disagreements (price, hours), trust the more recent review. Reviews come first; fold in general knowledge where they're silent.`;

const HIGHLIGHTS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    highlights: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          sentiment: { type: 'STRING' },
        },
      },
    },
    valueForMoney: { type: 'INTEGER' },
  },
};

async function call(prompt: string, maxTokens: number, schema?: object): Promise<string> {
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        ...(schema && { responseMimeType: 'application/json', responseSchema: schema }),
      },
    }),
  });
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data.error?.message || 'empty Gemini response');
  return text;
}

// Gemini occasionally truncates the structured JSON at maxOutputTokens (cut
// mid-array → "Unterminated string" / "Expected '}'"). Salvage the complete
// highlight objects instead of failing the whole summary — the verdict is a
// separate call and is always worth returning.
function parseStructured(text: string): { highlights: SummaryHighlight[]; valueForMoney: number } {
  try {
    const p = JSON.parse(text);
    return { highlights: p.highlights ?? [], valueForMoney: p.valueForMoney ?? 3 };
  } catch {
    const highlights: SummaryHighlight[] = [];
    for (const m of text.matchAll(/\{[^{}]*"text"[^{}]*\}/g)) {
      try { highlights.push(JSON.parse(m[0])); } catch {}
    }
    const vfm = text.match(/"valueForMoney"\s*:\s*(\d+)/);
    console.warn(`[summarize] structured JSON truncated; salvaged ${highlights.length} highlights`);
    return { highlights, valueForMoney: vfm ? Number(vfm[1]) : 3 };
  }
}

const reviewBlock = (texts: string[]) => texts.join('\n\n');

const subjectOf = (place: string, filter?: string) => {
  const p = place || 'this place';
  return filter ? `"${filter}" at ${p}` : p;
};

// Gemini's structured-JSON mode strips \n\n inside string fields, so the
// prose verdict and structured highlights run as two parallel calls. Input
// tokens overlap on the review block; output is clean both ways.
export async function summarize(placeName: string, reviewTexts: string[], filterQuery?: string): Promise<Summary> {
  const subject = subjectOf(placeName, filterQuery);
  const block = reviewBlock(reviewTexts);

  const verdictPrompt = `${block}\n\n---\n\nWrite a concise verdict on ${subject}: what stands out and whether it's worth it. Mention caveats only if the reviews raise real ones — don't invent them. **Bold** specifics. Markdown prose, no headings or bullets. Max 120 words.

${NOTES}`;

  const structuredPrompt = `${block}\n\n---\n\nExtract highlights about ${subject} and rate value for money 1-5 from pricing mentions.

Each highlight: text (one concrete line, ≤20 words, specifics over adjectives), sentiment (positive/negative/neutral).

${NOTES}`;

  const [verdict, structuredText] = await Promise.all([
    call(verdictPrompt, 1024),
    call(structuredPrompt, 8192, HIGHLIGHTS_SCHEMA),
  ]);
  const { highlights, valueForMoney } = parseStructured(structuredText);
  return { verdict: verdict.trim(), highlights, valueForMoney };
}

export async function ask(placeName: string, reviewTexts: string[], question: string, filterQuery?: string): Promise<string> {
  const subject = subjectOf(placeName, filterQuery);
  const prompt = `${reviewBlock(reviewTexts)}\n\n---\n\nAnswer about ${subject} using the reviews. Be concise. Name specifics (prices, hours, names) when relevant. Quote reviewer phrasing inline ("...") when it directly answers. If reviewers disagree or don't cover it, say so.

${NOTES}

Question: ${question}`;
  return call(prompt, 32768);
}
