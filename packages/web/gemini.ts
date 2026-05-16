const KEY = process.env.GEMINI_API_KEY!;
const MODEL = 'gemini-3-flash-preview';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

export type Highlight = { text: string; count: number; sentiment: string };
export type Summary = { highlights: Highlight[]; verdict: string; valueForMoney: number };

export async function summarize(placeName: string, reviewTexts: string[], filterQuery?: string): Promise<Summary> {
  const block = reviewTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const place = placeName || 'this place';
  // Each review is prefixed with `[YYYY-MM-DD]` (or `[undated]`) so the model
  // can weight by recency and flag trajectory shifts.
  const instructions = filterQuery
    ? `You are analyzing what visitors to ${place} say specifically about "${filterQuery}". Each review starts with [YYYY-MM-DD] showing when it was posted — treat newer comments as the current state and call out any shift over time.

Write a real synthesized summary of "${filterQuery}" at this place:
- The gist of what people actually think, weighted toward recent reviews.
- Where opinions split, surface the tension and (when possible) who tends to be on each side.
- Quote memorable phrasing when reviewers say it better than you could.
- Anything to watch out for; whether this is the best you can get for the price.

The verdict is this summary — write as much as the place warrants, no length cap. The highlights are the most-mentioned aspects of "${filterQuery}" as short noun phrases with sentiment and count (these render as chips).`
    : `You are a sharp, opinionated local writing a real summary of ${place} for a friend deciding whether to go. You've read the reviews below — each starts with [YYYY-MM-DD] so you can tell when people thought what. Treat newer reviews as the current truth and explicitly flag any trajectory: a place that was great in 2022 and slipped, one that recovered after a renovation, a regime change visible across the timestamps, etc.

Write a real synthesized summary, not a feature list:
- What it's actually like to visit right now — pull together what most reviewers consistently say.
- Where opinions split, surface the tension and roughly who's on each side (locals vs tourists, weekday vs weekend crowds, etc).
- Ground the summary in concrete specifics: exact dish names, exhibits, views, staff quirks, recurring complaints. Generic phrases like "great atmosphere" are useless; "rooftop gets packed after 8pm but the ground-floor bar is underrated" is what we want.
- Standout menu items if relevant — which dishes/drinks reviewers praise or warn against by name (required for restaurants, cafés, bars).
- Practical intel travelers can act on: timing, crowds, pricing surprises, what to skip, things only regulars know.

Don't pad, don't truncate — make the verdict as long as the place actually warrants. The highlights list is the most-mentioned topics as short noun phrases with sentiment and count (these become chips in the UI).

Rate value for money 1-5 based on what reviewers actually say about pricing relative to what they got, not a guess.`;
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
  `${block}\n\n---\n\nYou are a local expert helping a tourist decide about ${placeName || 'this place'}. Answer their question using only evidence from the reviews above. Each review starts with [YYYY-MM-DD] — weight recent reviews more heavily and flag if the answer has changed over time.

Question: ${question}

Quote or paraphrase the most vivid, concrete detail from the reviews — names, numbers, comparisons, warnings, tips. If reviewers disagree, surface the tension. Be direct, opinionated, practical. Keep it concise.`;

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

