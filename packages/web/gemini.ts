const KEY = process.env.GEMINI_API_KEY!;
const MODEL = 'gemini-3-flash-preview';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

export type Highlight = { text: string; description?: string; count: number; sentiment: string };
export type Summary = { highlights: Highlight[]; verdict: string; valueForMoney: number };

const RECENCY_NOTE = `Reviews are prefixed [YYYY-MM-DD]. If reviewers disagree on facts (price, hours, quality), trust the more recent one — otherwise recency doesn't matter.`;

const KNOWLEDGE_NOTE = `Reviews are the primary source. If they're silent on something and you have reliable general knowledge about the place (history, location context, well-known facts), you can fold it in.`;

// Gemini's structured-JSON mode strips \n\n inside string fields, so the
// prose verdict and structured highlights/value run as two parallel calls.
// Input tokens overlap (same review block both times) but output is clean
// markdown for the verdict and clean schema-validated JSON for the rest.
function verdictInstructions(place: string, filterQuery?: string): string {
  const subject = filterQuery ? `"${filterQuery}" at ${place}` : place;
  return `Write a verdict on ${subject} based on the reviews above. Under 300 words. Neutral, informational tone — not a persona, not addressing the reader. Surface what multiple reviewers agree on; drop one-off opinions. Name specifics (prices, dishes, hours, distances, place names). Use **bold** for the details that matter. Markdown prose only — no headings, no bullets, no rigid structure.

${RECENCY_NOTE}

${KNOWLEDGE_NOTE}

Output only the verdict text — no framing.`;
}

function structuredInstructions(place: string, filterQuery?: string): string {
  const subject = filterQuery ? `"${filterQuery}" at ${place}` : place;
  return `Extract the most-mentioned specific things about ${subject} from the reviews above as highlights, and rate value for money.

Each highlight = { text (named or specific thing, ≤6 words), description (one sentence with concrete specifics — numbers, names, conditions), count (roughly how many reviews mention it), sentiment ("positive" / "negative" / "neutral") }. Don't repeat the title in the description.

GOOD highlights:
- text: "Mirador del Salto del Nervión" / description: "A suspended metal platform with a 222-meter bird's-eye view into the Delika canyon."
- text: "Ephemeral waterfall" / description: "Dry 300+ days a year; needs 3+ days of heavy rain or snowmelt to actually flow."
- text: "Lobera" / description: "An ancient funnel-shaped wolf trap, just meters from the precipice."

BAD highlights:
- text: "scenic mountain hiking" with no description and no specifics
- text: "friendly staff" — generic, no name or angle

Rate value for money 1-5 based on what reviewers actually say about pricing relative to what they got, not a guess.

${RECENCY_NOTE}

${KNOWLEDGE_NOTE}`;
}

const HIGHLIGHTS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    highlights: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          description: { type: 'STRING' },
          count: { type: 'INTEGER' },
          sentiment: { type: 'STRING' },
        },
      },
    },
    valueForMoney: { type: 'INTEGER' },
  },
};

async function generateVerdict(prompt: string): Promise<string> {
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      },
    }),
  });
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data.error?.message || 'empty Gemini verdict response');
  return text.trim();
}

async function generateStructured(prompt: string): Promise<{ highlights: Highlight[]; valueForMoney: number }> {
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        responseMimeType: 'application/json',
        responseSchema: HIGHLIGHTS_SCHEMA,
      },
    }),
  });
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data.error?.message || 'empty Gemini structured response');
  const parsed = JSON.parse(text);
  return { highlights: parsed.highlights ?? [], valueForMoney: parsed.valueForMoney ?? 3 };
}

export async function summarize(placeName: string, reviewTexts: string[], filterQuery?: string): Promise<Summary> {
  const block = reviewTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const place = placeName || 'this place';
  const verdictPrompt = `${block}\n\n---\n\n${verdictInstructions(place, filterQuery)}`;
  const structuredPrompt = `${block}\n\n---\n\n${structuredInstructions(place, filterQuery)}`;

  const [verdict, structured] = await Promise.all([
    generateVerdict(verdictPrompt),
    generateStructured(structuredPrompt),
  ]);
  return { verdict, ...structured };
}

const ASK_PROMPT = (placeName: string, block: string, question: string) =>
  `${block}\n\n---\n\nAnswer the question below about ${placeName || 'this place'} using the reviews above. Just answer the question — no preamble, no "listen", no "here's the move", no persona. Be concise. Name specifics (prices, dishes, hours, names) when relevant. Quote reviewer phrasing inline ("...") when it directly answers. If reviewers disagree, say so. If the reviews don't cover it, say that.

${RECENCY_NOTE}

${KNOWLEDGE_NOTE}

Question: ${question}`;

export async function ask(placeName: string, reviewTexts: string[], question: string): Promise<string> {
  const block = reviewTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: ASK_PROMPT(placeName, block, question) }] }],
      generationConfig: {
        maxOutputTokens: 32768,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      },
    }),
  });
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data.error?.message || 'empty Gemini response');
  return text;
}
