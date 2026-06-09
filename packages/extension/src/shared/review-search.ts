import { el } from './utils';
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
