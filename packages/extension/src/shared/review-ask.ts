import { parseOrQuery, type AskSearch, type AskView, type SearchReviews } from '@truescore/gmaps-shared';
import { loadLlm } from './llm';
import { addCommas, el, npsColor, renderMarkdown } from './utils';

// What lets a page's Ask Search every one of its reviews (see searchWith);
// `open` shows a Search's reviews, e.g. by running it in the search box.
export interface SearchAsk { search: SearchReviews; open?: (query: string) => void }

// One Search the model had the page run: its terms, then its matches' % positive
// and count — pulsing while it runs; a click opens those reviews.
const searchRow = (s: AskSearch, open?: (query: string) => void) => {
  const row = el('button', s.done ? 'ars-ask-search' : 'ars-ask-search live') as HTMLButtonElement;
  row.type = 'button';
  row.disabled = !open || !s.done || !s.found;
  row.title = s.found == null ? "Couldn't search right now" : s.query;
  row.append(
    el('span', 'ars-ask-search-label', s.done ? 'Searched all reviews' : 'Searching all reviews'),
    el('span', 'ars-ask-search-terms', parseOrQuery(s.query).join(' · ')),
  );
  if (s.scorePct != null) {
    const pct = el('span', 'ars-ask-search-pct', s.trustedReviews ? `${s.scorePct}%` : '—');
    if (s.trustedReviews) pct.style.color = npsColor(s.scorePct);
    row.append(pct);
  }
  row.append(el('span', 'ars-ask-search-count', s.found == null ? '—' : `·${addCommas(s.found)}`));
  if (open) row.onclick = () => open(s.query);
  return row;
};

// An Answer's DOM in `panel`, returning its painter: a row per Search, then the
// Answer's markdown in `answerClass` as it's written, pulsing until its first
// words land. Painting a settled view replays a kept Answer.
export const mountAskView = (panel: HTMLElement, answerClass: string, open?: (query: string) => void) => {
  const rows = el('div', 'ars-ask-searches');
  const text = el('div', answerClass);
  panel.replaceChildren(rows, text);
  let shown: AskView | undefined;
  return (v: AskView) => {
    if (v.searches !== shown?.searches) rows.replaceChildren(...v.searches.map((s) => searchRow(s, open)));
    if (v.text !== shown?.text) renderMarkdown(text, v.text);
    text.classList.toggle('ars-ask-reading', !v.done && !v.text && v.searches.every((s) => s.done));
    shown = v;
  };
};

// Ask `prompt` of the `sample` reviews into `panel` (see src/llm.ts). Stops once
// the panel leaves the page.
export const askReviews = async (panel: HTMLElement, answerClass: string, ask: SearchAsk, sample: string[], prompt: string): Promise<AskView> => {
  const draw = mountAskView(panel, answerClass, ask.open);
  draw({ searches: [], text: '', done: false });
  const { streamAsk } = await loadLlm();
  const ctrl = new AbortController();
  return streamAsk(sample, prompt, ask.search, (v) => (panel.isConnected ? draw(v) : ctrl.abort()), ctrl.signal);
};
