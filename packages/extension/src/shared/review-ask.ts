import type { ChatTransport } from 'ai';
import { answersOf, askViewOf, countAnswers, opinionTone, parseOrQuery, runAsk, type AnswerCounts, type AskMessage, type AskSearch, type AskView, type SearchReviews } from '@truescore/gmaps-shared';
import { opinionNumbers, opinionsLabel, opinionsSlot, readAnswers } from './jev';
import { bumpRateLimit } from './llm';
import { findQA, saveQA } from './qa-history';
import { addCommas, el, npsColor, renderMarkdown, toneColor } from './utils';

// What lets a page's Ask Search every one of its reviews (see searchWith);
// `open` shows a Search's reviews, e.g. by running it in the search box.
export interface SearchAsk { search: SearchReviews; open?: (query: string) => void }

// What a Search's matches say to the question, once Jev has read them: settled,
// still being read, or null — the row then keeps its matches' % positive.
export type Read = AnswerCounts | Promise<AnswerCounts | null> | null;

// One Search the model had the page run: its terms, then what its matches say to
// the question (or their % positive) and their count — pulsing while it runs; a
// click opens those reviews.
const searchRow = (s: AskSearch, open?: (query: string) => void, read?: Read) => {
  const row = el('button', s.done ? 'ars-ask-search' : 'ars-ask-search live') as HTMLButtonElement;
  row.type = 'button';
  row.disabled = !open || !s.done || !s.found;
  row.title = s.found == null ? "Couldn't search right now" : s.query;
  row.append(
    el('span', 'ars-ask-search-label', s.done ? 'Searched all reviews' : 'Searching all reviews'),
    el('span', 'ars-ask-search-terms', parseOrQuery(s.query).join(' · ')),
  );

  const starShare = () => {
    if (s.scorePct == null) return null;
    const pct = el('span', 'ars-ask-search-pct', s.trustedReviews ? `${s.scorePct}%` : '—');

    if (s.trustedReviews) pct.style.color = npsColor(s.scorePct);

    return pct;
  };

  // The share alone, in the row's own % style: its count is the matches'.
  const counts = (a: AnswerCounts) => {
    const o = answersOf(a);
    row.setAttribute('aria-label', `${parseOrQuery(s.query).join(', ')}: ${opinionsLabel(o)}`);
    row.title = `${row.title} — ${o.title}`;

    return opinionNumbers(o, { share: () => 'ars-ask-search-pct', color: (x) => toneColor(opinionTone(x)) }, 'yes');
  };

  const answered = s.answers ?? read;

  if (answered instanceof Promise) row.append(opinionsSlot(answered.then((a) => a && counts(a)), starShare));
  else if (answered) row.append(...counts(answered));
  else {
    const pct = starShare();

    if (pct) row.append(pct);
  }

  row.append(el('span', 'ars-ask-search-count', s.found == null ? '—' : `·${addCommas(s.found)}`));

  if (open) row.onclick = () => open(s.query);

  return row;
};

// An Answer's DOM in `panel`, returning its painter: a row per Search, then the
// Answer's markdown in `answerClass` as it's written, pulsing until its first
// words land. Painting a settled view replays a kept Answer.
export const mountAskView = (panel: HTMLElement, answerClass: string, open?: (query: string) => void, reads?: Map<string, Read>) => {
  const rows = el('div', 'ars-ask-searches');
  const text = el('div', answerClass);
  panel.replaceChildren(rows, text);
  let shown: AskView | undefined;

  return (v: AskView) => {
    if (v.searches !== shown?.searches) rows.replaceChildren(...v.searches.map((s) => searchRow(s, open, reads?.get(s.query))));

    if (v.text !== shown?.text) renderMarkdown(text, v.text);
    text.classList.toggle('ars-ask-reading', !v.done && !v.text && v.searches.every((s) => s.done));
    shown = v;
  };
};

// One Ask as a page runs it. `transport` is its model — the server's /api/ask
// for Maps, the popup's in-process (llm.ts askTransport) elsewhere — told
// whether the page can Search, and so whether it may, or answers in one pass.
export interface AskRun {
  question: string;
  transport: (canSearch: boolean) => Promise<ChatTransport<AskMessage>>;
  search?: SearchReviews;
  // The page's painter, mounted as the Ask starts or replays; `reads` holds what
  // each Search's matches say to the question.
  mount: (reads: Map<string, Read>) => (v: AskView) => void;
  // False once the user has left: the Ask stops.
  live: () => boolean;
  // Recent questions under this key: a kept Answer replays unless `fresh`, a new one is kept.
  qaKey?: string | null;
  fresh?: boolean;
  // Counts toward the popup key's daily cap (llm.ts bumpRateLimit).
  limited?: boolean;
}

// Run an Ask, or replay its kept Answer. Each Search's matches are read for
// their answer as they come in, without holding up the model; the settled view
// carries those reads, so a kept Answer replays them.
export const askReviews = async (run: AskRun): Promise<AskView> => {
  const kept = run.qaKey && !run.fresh ? findQA(run.qaKey, run.question) : undefined;

  if (kept) {
    const view = { searches: kept.searches ?? [], text: kept.a, done: true, answeredAt: kept.ts };
    run.mount(new Map())(view);

    return view;
  }

  const reads = new Map<string, Read>();

  const search: SearchReviews = async (query, onFound) => {
    const matches = (await run.search?.(query, onFound)) ?? null;

    if (matches && !reads.has(query)) {
      reads.set(query, readAnswers(run.question, matches.texts).then((a) => {
        const counts = a && countAnswers(a);
        reads.set(query, counts);

        return counts;
      }));
    }

    return matches;
  };

  const transport = await run.transport(!!run.search);
  const draw = run.mount(reads);
  draw(askViewOf(undefined));
  const ctrl = new AbortController();
  const view = await runAsk(transport, run.question, search, (v) => (run.live() ? draw(v) : ctrl.abort()), ctrl.signal);
  const searches = await Promise.all(view.searches.map(async (s) => ({ ...s, answers: s.answers ?? (await reads.get(s.query)) ?? undefined })));

  if (run.limited) bumpRateLimit();

  if (run.qaKey) saveQA(run.qaKey, { q: run.question, a: view.text, ts: view.answeredAt ?? Date.now(), searches });

  return { ...view, searches };
};
