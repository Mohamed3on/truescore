const KEY = process.env.GEMINI_API_KEY!;
const MODEL = 'gemini-3-flash-preview';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

export type Highlight = { text: string; count: number; sentiment: string };
export type Summary = { highlights: Highlight[]; verdict: string; valueForMoney: number };

// The goal is to surface what multiple reviewers agree on — that's the
// signal worth keeping. Dates are included so the model can break ties
// when reviewers contradict each other on facts, not so it writes about
// trajectory.
const HIGHLIGHT_RULES = `Highlights are short specific chips, ≤4 words each. Sentiment is positive / negative / neutral. Count is roughly how many reviews mention it.
GOOD: "Otzarreta beech forest" · "€9.95 sandwich" · "no cell in valleys" · "mastiff guard dogs"
BAD: "scenic mountain hiking" · "good value" · "friendly staff" · "weak cell service"`;

const RECENCY_NOTE = `Reviews are prefixed [YYYY-MM-DD]. If reviewers disagree on facts (price, hours, quality), trust the more recent one — otherwise recency doesn't matter much.`;

const KNOWLEDGE_NOTE = `Reviews are the main source. If they don't cover something but you have reliable general knowledge about the place (history, location context, well-known facts the reviews didn't mention), you can fold it in.`;

export async function summarize(placeName: string, reviewTexts: string[], filterQuery?: string): Promise<Summary> {
  const block = reviewTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const place = placeName || 'this place';
  const instructions = filterQuery
    ? `Summarize what reviewers say about "${filterQuery}" at ${place} from the reviews below. Surface the details multiple reviewers agree on; skip one-off opinions.

${RECENCY_NOTE}

${KNOWLEDGE_NOTE}

${HIGHLIGHT_RULES}`
    : `Summarize ${place} from the reviews below. Surface the details multiple reviewers agree on — that's the signal worth keeping. Skip one-off opinions.

${RECENCY_NOTE}

${KNOWLEDGE_NOTE}

${HIGHLIGHT_RULES}

Rate value for money 1-5 based on what reviewers actually say about pricing relative to what they got.`;
  const prompt = `${block}\n\n---\n\n${instructions}`;

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 32768,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        responseMimeType: 'application/json',
        responseSchema: {
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
            verdict: { type: 'STRING' },
            valueForMoney: { type: 'INTEGER' },
          },
        },
      },
    }),
  });
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data.error?.message || 'empty Gemini response');
  return JSON.parse(text);
}

const ASK_PROMPT = (placeName: string, block: string, question: string) =>
  `${block}\n\n---\n\nAnswer this question about ${placeName || 'this place'} based on the reviews above. Be direct, concrete, brief.

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
