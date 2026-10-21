import { afterHydration } from '../shared/utils';
import { setupScoreGrid } from '../shared/score-grid';
import { cardScores, ROSSMANN } from '../shared/bazaarvoice';

// Search and category pages share one card, which carries its EAN, the
// BazaarVoice product id.
const CARD = '[data-testid="product-card"][data-item-ean]';
const eanOf = (card: Element) => card.getAttribute('data-item-ean');
const scoreOf = cardScores(ROSSMANN);

// As on DocMorris: the server-rendered cards' scores start fetching at once, and
// only the badges wait for React to hydrate. Each prefetch is handed over once.
const prefetched = new Map<string, ReturnType<typeof scoreOf>>();
for (const card of document.querySelectorAll(CARD)) {
  const id = eanOf(card);
  if (id && !prefetched.has(id)) prefetched.set(id, scoreOf(id));
}

afterHydration().then(() => setupScoreGrid({
  cardSelector: CARD,
  idOf: eanOf,
  scoreForCard: (card) => {
    const id = eanOf(card);
    if (!id) return Promise.resolve(null);
    const early = prefetched.get(id);
    prefetched.delete(id);
    return early ?? scoreOf(id);
  },
  // On the stars and review count's line.
  placeBadge: (card, badge) => card.querySelector('[data-testid="product-ratings"]')?.append(badge),
}));
