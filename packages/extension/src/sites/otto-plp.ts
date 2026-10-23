import { setupScoreGrid } from '../shared/score-grid';
import { cardScore } from '../shared/otto';

// Search and category pages share one card. Past the first rows it is a
// placeholder until it scrolls into view, so its stars may not exist yet.
const CARD = 'article[data-qa="reptile-product-tile"][data-product-id]';
const idOf = (card: Element) => card.getAttribute('data-product-id');

setupScoreGrid({
  cardSelector: CARD,
  idOf,
  // A drawn card without stars has no reviews to fetch.
  scoreForCard: async (card) => (card.querySelector('.reptile-tile-placeholder, .reptile-rating') ? cardScore(idOf(card)!) : null),
  // On the stars' line, or at the end of a placeholder, which survives its
  // drawing (the placeholder's contents don't).
  placeBadge: (card, badge) => (card.querySelector('.reptile-rating') ?? card).append(badge),
});

// A placeholder's badge joins the stars once the card is drawn.
new MutationObserver(() => {
  for (const badge of document.querySelectorAll(`${CARD} > .nps-score-badge`)) badge.parentElement!.querySelector('.reptile-rating')?.append(badge);
}).observe(document.body, { childList: true, subtree: true });
