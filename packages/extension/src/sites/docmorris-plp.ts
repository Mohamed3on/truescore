import { afterHydration } from '../shared/utils';
import { setupScoreGrid } from '../shared/score-grid';
import { cardScores, DOCMORRIS } from '../shared/bazaarvoice';

// Search and category pages share one card: a link to `/<slug>/<PZN>`.
const CARD = 'a[data-testid="product-card"]';
const pznOf = (card: Element) => card.getAttribute('href')?.match(/\/(\d{8,})\/?$/)?.[1] ?? null;
const scoreOf = cardScores(DOCMORRIS);

// The server-rendered cards' scores start fetching at once; only the badges wait
// until React has hydrated those cards (see afterHydration). Each prefetch is
// handed over once, so the grid's retries of a failed one fetch afresh.
const prefetched = new Map<string, ReturnType<typeof scoreOf>>();
for (const card of document.querySelectorAll(CARD)) {
  const id = pznOf(card);
  if (id && !prefetched.has(id)) prefetched.set(id, scoreOf(id));
}

afterHydration().then(() => setupScoreGrid({
  cardSelector: CARD,
  idOf: pznOf,
  scoreForCard: (card) => {
    const id = pznOf(card);
    if (!id) return Promise.resolve(null);
    const early = prefetched.get(id);
    prefetched.delete(id);
    return early ?? scoreOf(id);
  },
  // The stars, found by their icons: Chrome's page translation rewrites their
  // "von 5 Sternen" label.
  placeBadge: (card, badge) => card.querySelector('[role="img"]:has([data-testid^="rating-star"])')?.after(badge),
}));
