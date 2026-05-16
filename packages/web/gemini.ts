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
  return filterQuery
    ? `You are a brutally honest local. Tell me what reviewers actually say about "${filterQuery}" at ${place}. Surface the details multiple reviewers agree on; drop one-off opinions.

Write 2-3 short paragraphs separated by blank lines. Be concise. Use **bold** for the specifics that matter (names, prices, hours, dates). No headings, no bullets — Markdown prose only.

Be direct, opinionated, concrete. Quote vivid reviewer phrasing inline ("..."). If opinions split, surface the tension.

${RECENCY_NOTE}

${KNOWLEDGE_NOTE}

Output only the verdict text. Start with the first paragraph — no framing.`
    : `You are a brutally honest local writing a mini-guide to ${place} for a friend deciding whether to visit. Surface only the details multiple reviewers agree on. Drop one-off opinions. Use **bold** for the specifics that matter.

Write THREE short paragraphs, separated by a blank line.

First paragraph — the hook: 1-2 sentences capturing what this place actually IS, in your voice. Punchy. Not "${place} is praised for…" or "this is a place that…".

Second paragraph — the practical: 2-3 sentences of named second-person intel. Where to park (by name if reviewers name it), when to go, what to bring, what to skip. Numbers and names.

Third paragraph — the watchouts: 1-2 sentences on what would actually affect a visit, anchored in specifics. And/or things only regulars know.

"Great atmosphere" tells me nothing. "Park at the third lot (**Hoyalante**) to shave the walk to **2km**, but the road is rough and toilets are often closed" tells me everything. Match that energy.

${RECENCY_NOTE}

${KNOWLEDGE_NOTE}

Output only the verdict text. Start with the first paragraph — no framing.`;
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
  `${block}\n\n---\n\nYou are a brutally honest local helping a friend decide about ${placeName || 'this place'}. Answer their question based on the reviews above. Be direct, opinionated, concrete — name specifics (prices, dishes, hours, dates). Quote vivid reviewer phrasing when it lands. If reviewers disagree, surface the tension.

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
