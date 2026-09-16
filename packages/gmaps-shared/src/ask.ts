import { isStaticToolUIPart, readUIMessageStream, tool, type ChatTransport, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { AskMessage, AskSearch, AskSearchOutput, SearchMatches } from './wire';

// What a client paints while an Ask runs: its Searches, then the Answer text so
// far; `done` once that text is final, and `answeredAt` when it's a replay.
export type AskView = { searches: AskSearch[]; text: string; done: boolean; answeredAt?: number };

// A question as a cache key: case, spacing and trailing punctuation don't make
// it a different question ("Dogs allowed?" asks what "dogs allowed" does).
export const normalizeQuestion = (q: string): string =>
  q.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[\s?!.。？！]+$/u, '');
// A client's own way to Search every review — the Maps tab's session, the web's
// /api/search, a retail or book site's own search. Resolves to the matches as
// review texts with their stats, or null when it can't search.
export type SearchReviews = (query: string, onFound: (found: number) => void) => Promise<SearchMatches | null>;

export const questionOf = (messages: AskMessage[]): string =>
  (messages[0]?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');

// An Ask's message as a client paints it: a row per Search (`progress` has the
// count so far of one still running), then the text after the last — text the
// model wrote before searching gives way to the Answer it writes after.
export const askViewOf = (message: AskMessage | undefined, progress = new Map<string, number>()): AskView => {
  const parts = message?.parts ?? [];
  return {
    searches: parts.filter(isStaticToolUIPart).map((p): AskSearch => {
      const query = p.input?.query ?? '';
      if (p.state === 'output-available') return { query, done: true, found: p.output.found, scorePct: p.output.scorePct, trustedReviews: p.output.trustedReviews };
      return p.state === 'output-error' ? { query, done: true, found: null } : { query, done: false, found: progress.get(p.toolCallId) ?? 0 };
    }),
    text: parts.slice(parts.map(isStaticToolUIPart).lastIndexOf(true) + 1).map((p) => (p.type === 'text' ? p.text : '')).join(''),
    done: false,
    answeredAt: message?.metadata?.answeredAt,
  };
};

// Rounds of Searches before the model must answer.
const SEARCH_ROUNDS_MAX = 2;
// A Search's matches the model reads beyond the Sample, capped so a common word
// on a big place can't flood the context (texts arrive longest-first).
const SEARCH_HITS_MAX = 100;

export const searchesLeft = (messages: ModelMessage[]) => messages.filter((m) => m.role === 'tool').length < SEARCH_ROUNDS_MAX;

// The searchReviews tool an Ask's model gets — on the server for a Place, in the
// extension for a product or book. No `execute`: a call ends the round and the
// client runs it (runAsk). The model reads back the matches its `sample` lacks.
export const searchReviewsTool = (sample: string[], description: string) => {
  const seen = new Set(sample);
  return tool({
    description,
    inputSchema: z.object({ query: z.string().describe('Terms joined with " OR "') }),
    toModelOutput: ({ output }: { output: AskSearchOutput }) => ({
      type: 'json' as const,
      value: { found: output.found, scorePct: output.scorePct, trustedReviews: output.trustedReviews, reviews: output.texts.filter((t) => !seen.has(t)).slice(0, SEARCH_HITS_MAX) },
    }),
  });
};

const SEARCH_FAILED = 'Search is unavailable right now. Answer from the sample, and say you could only check part of the reviews.';

// An Ask over a chat transport — /api/ask, or a model in-process. Streams the
// Answer; when the model calls for Searches instead, runs them through
// `search`, hands the model their matches, and goes on until the Answer
// settles. `onView` gets every change. Resolves to the settled view.
export async function runAsk(transport: ChatTransport<AskMessage>, question: string, search: SearchReviews, onView: (v: AskView) => void, abortSignal?: AbortSignal): Promise<AskView> {
  const asked: AskMessage = { id: 'question', role: 'user', parts: [{ type: 'text', text: question }] };
  const progress = new Map<string, number>();
  let answer: AskMessage | undefined;
  let view = askViewOf(answer);
  // Rows only get a new array when one changed, so a painter can skip rebuilding them.
  const paint = () => {
    const next = askViewOf(answer, progress);
    onView((view = JSON.stringify(next.searches) === JSON.stringify(view.searches) ? { ...next, searches: view.searches } : next));
  };
  for (;;) {
    const stream = await transport.sendMessages({ trigger: 'submit-message', chatId: 'ask', messageId: undefined, messages: answer ? [asked, answer] : [asked], abortSignal });
    for await (const m of readUIMessageStream<AskMessage>({ message: answer, stream, terminateOnError: true })) {
      answer = m;
      paint();
    }
    const calls = answer?.parts.filter(isStaticToolUIPart).filter((p) => p.state === 'input-available') ?? [];
    if (!calls.length) break;
    await Promise.all(calls.map(async (call) => {
      const matches = await search(call.input.query, (found) => { progress.set(call.toolCallId, found); paint(); }).catch(() => null);
      const settled = matches
        ? { ...call, state: 'output-available' as const, output: { ...matches, found: matches.texts.length } }
        : { ...call, state: 'output-error' as const, errorText: SEARCH_FAILED };
      answer = { ...answer!, parts: answer!.parts.map((p) => (p === call ? settled : p)) };
      paint();
    }));
  }
  if (!view.text.trim()) throw new Error('The answer was cut off — try again');
  onView((view = { ...view, done: true }));
  return view;
}
