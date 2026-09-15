import { streamNdjson } from './http';
import type { AskEvent, AskRequest, AskSearch, AskSearchResult, SearchMatches } from './wire';

// What a client paints while an Ask runs: its Searches, then the Answer text so
// far; `done` once that text is final, and `answeredAt` when it's a replay.
export type AskView = { searches: AskSearch[]; text: string; done: boolean; answeredAt?: number };

// A question as a cache key: case, spacing and trailing punctuation don't make
// it a different question ("Dogs allowed?" asks what "dogs allowed" does).
export const normalizeQuestion = (q: string): string =>
  q.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[\s?!.。？！]+$/u, '');
// A client's own way to Search every review of the Place — the extension's tab
// session, the web's /api/search. Resolves to the matches as review texts
// (textReviewsFor) with their stats, or null when it can't search.
export type SearchReviews = (query: string, onFound: (found: number) => void) => Promise<SearchMatches | null>;

// The client half of an Ask (see AskEvent). Streams the Answer; when the model
// wants Searches instead, runs them through `search` and asks again with the
// round's history and their matches, until the Answer settles. Text the model
// wrote before searching gives way to the Answer it writes after. `onView` gets
// every change, with a new `searches` array only when a row changed.
export async function runAsk(url: string, body: AskRequest, search: SearchReviews, onView: (v: AskView) => void, signal?: AbortSignal): Promise<string> {
  let view: AskView = { searches: [], text: '', done: false };
  const paint = (next: Partial<AskView>) => onView((view = { ...view, ...next }));
  let round: { history?: unknown[]; results?: AskSearchResult[] } = {};
  for (;;) {
    let wanted: Extract<AskEvent, { type: 'search' }> | undefined;
    for await (const e of streamNdjson<AskEvent>(url, { ...body, ...round }, signal)) {
      if (e.type === 'delta') paint({ text: view.text + e.text });
      else if (e.type === 'search') wanted = e;
      else if (e.type === 'answer') {
        paint({ text: e.answer, done: true, ...(e.searches && { searches: e.searches }), answeredAt: e.answeredAt });
        return e.answer;
      }
    }
    if (!wanted) throw new Error('The answer was cut off — try again');

    const base = view.searches.length;
    paint({ text: '', searches: [...view.searches, ...wanted.searches.map(({ query }) => ({ query, found: 0, done: false }))] });
    const setRow = (i: number, patch: Partial<AskSearch>) =>
      paint({ searches: view.searches.map((s, j) => (j === base + i ? { ...s, ...patch } : s)) });
    const results = await Promise.all(wanted.searches.map(async ({ id, query }, i): Promise<AskSearchResult> => {
      const matches = await search(query, (found) => setRow(i, { found })).catch(() => null);
      setRow(i, matches
        ? { found: matches.texts.length, done: true, scorePct: matches.scorePct, trustedReviews: matches.trustedReviews }
        : { found: null, done: true });
      return { id, matches };
    }));
    round = { history: wanted.history, results };
  }
}
