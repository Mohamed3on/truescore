import { answersOf, askViewOf, countAnswers, opinionTone, parseOrQuery, runAsk, type AnswerCounts, type AskSearch, type AskView, type SearchReviews } from '@truescore/gmaps-shared';
import { opinionNumbers, opinionsLabel, opinionsSlot, readAnswers } from './jev';
import { askTransport } from './llm';
import { addCommas, el, npsColor, renderMarkdown, toneColor } from './utils';

// What lets a page's Ask Search every one of its reviews (see searchWith);
// `open` shows a Search's reviews, e.g. by running it in the search box.
export interface SearchAsk { search: SearchReviews; open?: (query: string) => void }

// What a Search's matches say to the question, once Jev has read them: settled,
// still being read, or null — the row then keeps its matches' % positive.
type Read = AnswerCounts | Promise<AnswerCounts | null> | null;

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
  else { const pct = starShare(); if (pct) row.append(pct); }
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

// Ask `question` of the `sample` reviews into `panel`, on the popup's model with
// the site's `prompt` (see llm.ts askTransport). Stops once the panel leaves the page.
// Each Search's matches are read for their answer as they come in, without holding
// up the model; the settled view carries those reads, so a kept Answer replays them.
export const askReviews = async (panel: HTMLElement, answerClass: string, ask: SearchAsk, sample: string[], prompt: string, question: string): Promise<AskView> => {
  const reads = new Map<string, Read>();
  const search: SearchReviews = async (query, onFound) => {
    const matches = await ask.search(query, onFound);
    if (matches && !reads.has(query)) {
      reads.set(query, readAnswers(question, matches.texts).then((a) => {
        const counts = a && countAnswers(a);
        reads.set(query, counts);
        return counts;
      }));
    }
    return matches;
  };
  const draw = mountAskView(panel, answerClass, ask.open, reads);
  draw(askViewOf(undefined));
  const ctrl = new AbortController();
  const view = await runAsk(await askTransport(prompt, sample), question, search, (v) => (panel.isConnected ? draw(v) : ctrl.abort()), ctrl.signal);
  const searches = await Promise.all(view.searches.map(async (s) => ({ ...s, answers: (await reads.get(s.query)) ?? undefined })));
  return { ...view, searches };
};
