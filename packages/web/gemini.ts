const KEY = process.env.GEMINI_API_KEY!;
const MODEL = 'gemini-3-flash-preview';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

export type Highlight = { text: string; count: number; sentiment: string };
export type Summary = { highlights: Highlight[]; verdict: string; valueForMoney: number };

const NOTES = `Reviews are prefixed [YYYY-MM-DD]. If reviewers disagree on facts (price, hours, quality), trust the more recent one — otherwise recency doesn't matter.

Reviews are the primary source. If they're silent on something and you have reliable general knowledge about the place (history, location context, well-known facts), you can fold it in.`;

const HIGHLIGHTS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    highlights: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          count: { type: 'INTEGER' },
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

const reviewBlock = (texts: string[]) =>
  texts.map((t, i) => `${i + 1}. ${t}`).join('\n');

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

  const verdictPrompt = `${block}\n\n---\n\nWrite a tight verdict on ${subject} from the reviews. Target ~120 words; hard cap 180. Neutral tone — no persona, no addressing the reader. Skip describing what the place is. Focus on what reviewers agree on: standouts, dealbreakers, tips, whether it's recommended. **Bold** specifics. Markdown prose only — no headings, no bullets.

${NOTES}

Output only the verdict — no framing.`;

  const structuredPrompt = `${block}\n\n---\n\nExtract highlights about ${subject} and rate value for money 1-5 from what reviewers say about pricing.

Each highlight: text (one concrete line with specifics — numbers, names, conditions; ≤20 words), count (roughly how many reviews mention it), sentiment ("positive" / "negative" / "neutral"). Avoid generic adjectives — favor specific named things and concrete details.

${NOTES}`;

  const [verdict, structuredText] = await Promise.all([
    call(verdictPrompt, 1024),
    call(structuredPrompt, 8192, HIGHLIGHTS_SCHEMA),
  ]);
  const parsed = JSON.parse(structuredText);
  return {
    verdict: verdict.trim(),
    highlights: parsed.highlights ?? [],
    valueForMoney: parsed.valueForMoney ?? 3,
  };
}

export async function ask(placeName: string, reviewTexts: string[], question: string, filterQuery?: string): Promise<string> {
  const subject = subjectOf(placeName, filterQuery);
  const prompt = `${reviewBlock(reviewTexts)}\n\n---\n\nAnswer the question below about ${subject} using the reviews above. Neutral, direct tone — answer the question, no preamble, no persona. Be concise. Name specifics (prices, hours, names, numbers) when relevant. Quote reviewer phrasing inline ("...") when it directly answers. If reviewers disagree, say so. If the reviews don't cover it, say that.

${NOTES}

Question: ${question}`;
  return call(prompt, 32768);
}
