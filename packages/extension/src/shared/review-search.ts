import { addCommas, el, npsColor, npsStats } from './utils';
import { llmSummarize, renderFreeFormAnswer } from './review-summary';
import { parseOrQuery } from '@truescore/gmaps-shared';

// Gmail-style ` OR ` (any case) splits a query into lowercased terms; a review
// matches if it contains ANY term. Shared by every panel's review search.
export const queryTerms = (query: string) => parseOrQuery(query).map((t) => t.toLowerCase());

// Highlight every occurrence of ANY term. At each position take the
// earliest-starting match (longest on ties) so overlapping terms don't double-wrap.
const appendHighlighted = (parent: HTMLElement, text: string, terms: string[]) => {
  if (!terms.length) { parent.appendChild(document.createTextNode(text)); return; }
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    let best = -1, bestLen = 0;
    for (const t of terms) {
      const idx = lower.indexOf(t, i);
      if (idx >= 0 && (best < 0 || idx < best || (idx === best && t.length > bestLen))) { best = idx; bestLen = t.length; }
    }
    if (best < 0) { parent.appendChild(document.createTextNode(text.slice(i))); return; }
    if (best > i) parent.appendChild(document.createTextNode(text.slice(i, best)));
    parent.appendChild(el('mark', 'ars-search-hl', text.slice(best, best + bestLen)));
    i = best + bestLen;
  }
};

export interface SearchReviewFields { rating: number; title?: string; body?: string; meta?: string }

const MAX_RENDERED_RESULTS = 50;
const SEARCH_DEBOUNCE_MS = 120;
// Remote searches cost a request per keystroke-burst, so they wait longer.
const REMOTE_DEBOUNCE_MS = 350;

export interface ReviewSearchOpts<T> {
  // The local corpus. Panels backed by a remote `search` pass `[]` and a `total`.
  reviews: T[];
  // Card/haystack projection of a review; searching matches against its
  // title + body + meta, lowercased.
  fields: (r: T) => SearchReviewFields;
  // Text sent to the LLM when summarizing the matched subset ('' = skip).
  toText: (r: T) => string;
  summaryPrompt: string;
  exampleQuery: string;
  // Corpus size behind the "of N reviews" copy (default: reviews.length).
  total?: number;
  // Server-side search over the whole corpus, replacing the local filter. Its
  // `total` is the true match count when the site returns only a first page.
  search?: (terms: string[]) => Promise<{ matches: T[]; total?: number }>;
}

// The review-search section shared by panels that hold a full review corpus:
// an OR-term search box, a matched-count header with a %-positive chip for the
// subset, a "Summarize <query>" free-form LLM pass over the matches, and the
// highlighted result cards. Cmd/Ctrl+Shift+F jumps to the box. Returns the
// section for the caller to place in its island.
export const buildSearchSection = <T,>({
  reviews, fields, toText, summaryPrompt, exampleQuery,
  total, search,
}: ReviewSearchOpts<T>) => {
  const corpusSize = total ?? reviews.length;
  const projected = reviews.map((r) => {
    const f = fields(r);
    return { r, f, h: [f.title, f.body, f.meta].filter(Boolean).join(' ').toLowerCase() };
  });

  const section = el('div', 'ars-search-section');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ars-search-input';
  input.placeholder = `Search ${addCommas(corpusSize)} reviews… (e.g. "${exampleQuery}")`;
  section.appendChild(input);

  const header = el('div', 'ars-search-header');
  header.style.display = 'none';
  const scoreChip = el('span', 'ars-search-score');
  const summary = el('span', 'ars-search-summary');
  const sumBtn = el('button', 'ars-summarize-btn ars-search-sum-btn', '✦ Summarize') as HTMLButtonElement;
  sumBtn.type = 'button';
  header.append(scoreChip, summary, sumBtn);
  section.appendChild(header);

  const sumPanel = el('div', 'ars-summary-panel ars-search-sum-panel');
  sumPanel.style.display = 'none';
  section.appendChild(sumPanel);

  const list = el('div', 'ars-search-list');
  list.style.display = 'none';
  section.appendChild(list);

  const summaryCache = new Map<string, string>();
  let timer: number | null = null;
  let currentQuery = '';

  type Match = { r: T; f: SearchReviewFields };
  let lastMatches: Match[] = [];

  const findMatches = async (terms: string[]): Promise<{ matches: Match[]; total: number }> => {
    if (!search) {
      const matches = projected.filter((p) => terms.some((t) => p.h.includes(t)));
      return { matches, total: matches.length };
    }
    const hit = await search(terms);
    const matches = hit.matches.map((r) => ({ r, f: fields(r) }));
    return { matches, total: hit.total ?? matches.length };
  };

  const hideSummary = () => {
    sumPanel.style.display = 'none';
    sumPanel.textContent = '';
    sumBtn.disabled = false;
    sumBtn.textContent = '✦ Summarize';
  };

  const renderCached = (query: string, text: string) => {
    sumPanel.style.display = 'block';
    renderFreeFormAnswer(sumPanel, text);
    sumBtn.disabled = false;
    sumBtn.textContent = `Re-summarize "${query}"`;
  };

  sumBtn.addEventListener('click', async () => {
    const query = currentQuery;
    if (!query) return;
    const texts = lastMatches.map((p) => toText(p.r)).filter(Boolean);
    if (!texts.length) {
      sumPanel.style.display = 'block';
      sumPanel.textContent = 'No review text to summarize';
      return;
    }
    sumBtn.disabled = true;
    sumBtn.textContent = '⏳ Summarizing…';
    sumPanel.style.display = 'block';
    sumPanel.textContent = 'Summarizing…';
    try {
      const text = await llmSummarize(texts, summaryPrompt, null);
      summaryCache.set(query.toLowerCase(), text);
      if (currentQuery !== query) return;
      renderCached(query, text);
    } catch (e: any) {
      sumPanel.textContent = `Error: ${e.message || 'Summarization failed'}`;
      sumBtn.disabled = false;
      sumBtn.textContent = `Retry "${query}"`;
    }
  });

  const render = async () => {
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    currentQuery = raw;
    if (!q) {
      header.style.display = 'none';
      list.style.display = 'none';
      hideSummary();
      return;
    }
    const terms = queryTerms(raw);

    header.style.display = '';
    list.style.display = '';
    if (search) {
      hideSummary();
      summary.textContent = `Searching ${addCommas(corpusSize)} reviews…`;
      scoreChip.style.display = 'none';
      sumBtn.disabled = true;
    }

    let found: { matches: Match[]; total: number };
    try { found = await findMatches(terms); }
    catch {
      if (currentQuery !== raw) return;
      summary.textContent = 'Search failed';
      list.textContent = '';
      return;
    }
    // A slower earlier query must not overwrite the results now on screen.
    if (currentQuery !== raw) return;
    const { matches, total: matchTotal } = found;
    lastMatches = matches;

    summary.textContent = '';
    summary.append(
      el('span', 'ars-search-count', addCommas(matchTotal)),
      document.createTextNode(` of ${addCommas(corpusSize)} reviews mention "${raw}"`),
    );

    if (matches.length) {
      let five = 0, one = 0;
      for (const { f } of matches) {
        if (f.rating === 5) five++;
        else if (f.rating === 1) one++;
      }
      const { nps } = npsStats(five, one, matches.length);
      scoreChip.textContent = `${Math.round(nps)}%`;
      scoreChip.style.color = npsColor(nps);
      scoreChip.style.display = '';
    } else {
      scoreChip.style.display = 'none';
    }

    const cached = summaryCache.get(q);
    if (cached) renderCached(raw, cached);
    else hideSummary();
    if (matches.length) sumBtn.textContent = cached ? `Re-summarize "${raw}"` : `✦ Summarize "${raw}"`;
    // After the branch above: both renderCached and hideSummary re-enable the button.
    sumBtn.disabled = matches.length === 0;

    list.textContent = '';
    if (!matches.length) {
      list.appendChild(el('div', 'ars-search-empty', 'No matching reviews'));
      return;
    }
    const shown = matches.slice(0, MAX_RENDERED_RESULTS);
    for (const p of shown) list.appendChild(buildReviewCard(p.f, terms));
    // matchTotal, not matches.length: a remote search reports every hit but
    // only hands back its first page.
    if (matchTotal > shown.length) {
      list.appendChild(el('div', 'ars-search-truncated',
        `Showing first ${shown.length} — refine the search to see more.`));
    }
  };

  input.addEventListener('input', () => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => void render(), search ? REMOTE_DEBOUNCE_MS : SEARCH_DEBOUNCE_MS) as unknown as number;
  });

  // Self-removing so SPA re-injections (which rebuild the section) don't stack
  // dead listeners on document.
  const onSearchKey = (e: KeyboardEvent) => {
    if (!input.isConnected) { document.removeEventListener('keydown', onSearchKey, true); return; }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      e.stopPropagation();
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input.focus();
      input.select();
    }
  };
  document.addEventListener('keydown', onSearchKey, true);

  return section;
};

// One review card in a `.ars-search-list`: stars + meta header, then the
// highlighted title and body.
export const buildReviewCard = (r: SearchReviewFields, terms: string[]) => {
  const card = el('div', 'ars-search-review');
  const head = el('div', 'ars-search-review-head');
  const rating = Math.max(0, Math.min(5, Math.round(r.rating || 0)));
  head.appendChild(el('span', 'ars-search-stars', '★'.repeat(rating) + '☆'.repeat(5 - rating)));
  if (r.meta) head.appendChild(el('span', 'ars-search-meta', r.meta));
  card.appendChild(head);
  if (r.title) {
    const title = el('div', 'ars-search-title');
    appendHighlighted(title, r.title, terms);
    card.appendChild(title);
  }
  if (r.body) {
    const body = el('div', 'ars-search-body');
    appendHighlighted(body, r.body, terms);
    card.appendChild(body);
  }
  return card;
};
