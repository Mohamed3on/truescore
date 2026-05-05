const KEY = process.env.GEMINI_API_KEY!;
const MODEL = 'gemini-3-flash-preview';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

export type Highlight = { text: string; count: number; sentiment: string };
export type Summary = { highlights: Highlight[]; verdict: string; valueForMoney: number };

export async function summarize(placeName: string, reviewTexts: string[], filterQuery?: string): Promise<Summary> {
  const block = reviewTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const place = placeName || 'this place';
  const instructions = filterQuery
    ? `You are analyzing what visitors to ${place} say specifically about "${filterQuery}".

Surface the most concrete, useful details: what exactly people praise, complain about, compare it to, or warn about regarding "${filterQuery}". Quote memorable phrasing when reviewers say it better than you could. If opinions are split, show both sides. The verdict should be a short summary of "${filterQuery}" at this place — the gist, anything to watch out for, and whether this is the best you can get for the price.`
    : `You are a brutally honest local expert writing a mini-guide to ${place} for a tourist deciding whether to visit.

What to extract:
- The specific things that make this place worth visiting (or not) — name exact dishes, exhibits, views, features, staff behaviors, quirks
- Standout menu items: which specific dishes/drinks do reviewers rave about or warn against by name? (If this is a restaurant, café, bar, or anywhere with a menu, this is required.)
- Practical intel: timing, crowds, pricing surprises, what to skip, what's overrated vs underrated
- Recurring complaints that would actually affect someone's visit
- Things only regulars or repeat visitors would know

Don't be generic. "Great atmosphere" tells me nothing. "Rooftop terrace gets packed after 8pm but the ground floor bar is underrated" tells me everything.

Be concise. Keep the entire response under 200 words.

For the verdict: a short summary — the gist of what visitors say, anything to watch out for, any better alternatives nearby if mentioned, and whether this is the best you can get for the price.

Also rate value for money 1-5 — base this on what reviewers actually say about pricing relative to what they got, not a guess.`;
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

export async function ask(placeName: string, reviewTexts: string[], question: string): Promise<string> {
  const block = reviewTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const prompt = `${block}\n\n---\n\nYou are a local expert helping a tourist decide about ${placeName || 'this place'}. Answer their question using only evidence from the reviews above.

Question: ${question}

Quote or paraphrase the most vivid, concrete detail from the reviews — names, numbers, comparisons, warnings, tips. If reviewers disagree, surface the tension. Be direct, opinionated, practical. Keep it concise.`;

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
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
