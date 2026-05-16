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

Write a synthesized summary of "${filterQuery}" at this place. Format the verdict as Markdown so it's scannable, not a wall of text:
- Open with a 1-2 sentence overall take specific to "${filterQuery}" here (not a generic intro).
- Use **bold** to call out the specific details that matter — names, dishes, hours, prices, surprises.
- Use \`### \` subheads (e.g., \`### Praised\`, \`### Catches\`, \`### Then vs Now\`) only when the content actually splits into sections. Skip subheads if you'd just have one tiny bullet under each.
- Use \`- \` bulleted lists for parallel items (multiple complaints, multiple recommendations).
- Quote memorable reviewer phrasing inline when they put it better than you could.
- If there's a clear trajectory across the dates, flag it explicitly.

Don't pad and don't truncate — as long or short as the topic warrants.

The highlights field is the chips that render under the verdict. Each must be a SHORT (≤4 words), SPECIFIC noun phrase a reader can act on. Prefer "fishmonger missing" over "limited selection", "cashier rudeness 2020-22" over "rude staff", "Sunday brunch overpriced" over "expensive". Avoid generic adjective pairs like "good and friendly X" — pick the sharper angle. Sentiment is positive/negative/neutral.`
    : `You are a sharp, opinionated local writing a real summary of ${place} for a friend deciding whether to go. You've read the reviews below — each starts with [YYYY-MM-DD] so you can tell when people thought what. Treat newer reviews as the current truth and explicitly flag any trajectory across the timestamps (slipped after a renovation, recovered, staff turnover, price hikes, etc).

Format the verdict as Markdown so it's scannable, not a wall of text. Pick the structure that fits the place — don't force every section, but make sure the result isn't one giant paragraph:
- Open with a 1-2 sentence overall take that's specific to this place (skip the "this is a place that..." preamble).
- Use **bold** liberally on the concrete details that actually matter: dish names, hours, prices, named staff, specific quirks.
- Use \`### \` subheads (e.g., \`### The Good\`, \`### The Catches\`, \`### Practical Intel\`, \`### Then vs Now\`, \`### Standout Dishes\`) when the content naturally splits. Skip a subhead if you'd only have a one-line bullet under it.
- Use \`- \` bulleted lists for parallel items — things to skip, recommended orders, recurring complaints, time-of-day tips.
- Quote memorable reviewer phrasing inline ("...") when they put it better than you could.
- For restaurants / cafés / bars: a \`### Standout Dishes\` section listing items by name with whether reviewers praise or warn against them is required.
- For trajectory shifts: a \`### Then vs Now\` section anchored in dates from the timestamps.

Don't pad, don't truncate — make the verdict as long as the place actually warrants. Skip sections that don't apply. Avoid generic phrases like "great atmosphere" — they tell the reader nothing.

The highlights field renders as compact chips under the verdict. Each must be a SHORT (≤4 words), SPECIFIC noun phrase a reader can immediately understand and act on. Prefer:
- "summer overcrowding" over "small size"
- "cashier rudeness 2020-22" over "unfriendly staff"
- "no fresh fishmonger" over "limited selection"
- "€9.95 sandwich deal" over "good value"
- "weekday queues short" over "fast service"

Avoid generic adjective pairs ("friendly and helpful X"). Pick the sharpest, most concrete angle. Sentiment is positive/negative/neutral. Count is roughly how many reviews mention it.

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

Format the answer as Markdown so it's scannable. Use **bold** on the specific details that matter (names, dishes, prices, hours). Use \`- \` bullets when listing parallel points. Use \`### \` subheads if the answer splits into a few angles (skip subheads for short answers). Quote memorable reviewer phrasing inline. If reviewers disagree, surface the tension and say who's on each side. Be direct, opinionated, practical, concrete — no generic phrases.`;

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

