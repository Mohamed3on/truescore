import { setupScoreGrid } from '../shared/score-grid';
import { cardScore } from '../shared/otto';

// Search and category pages share one card. Past the first rows it is a
// placeholder until it scrolls into view, so its stars may not exist yet; a
// fashion card never shows stars, reviews or not.
const CARD = 'article[data-qa="reptile-product-tile"][data-product-id]';
const idOf = (card: Element) => card.getAttribute('data-product-id');
const scoreOf = (card: Element) => cardScore(idOf(card)!);

// The stars' line, else the brand and title block.
const lineOf = (card: Element) => card.querySelector('.reptile-rating') ?? card.querySelector('.reptile-product-header');

// Otto's Svelte app hydrates the server-rendered list, then removes the script
// that started it. A card written to before that fails hydration and Otto drops
// it, so the scores start fetching at once and only the badges wait. Each
// prefetch is handed over once.
const APP = 'script[data-kestrel-app="reptile.dundee"]';

const hydrated = new Promise<void>((resolve) => {
  const check = () => {
    if (document.querySelector(APP)) return;
    observer.disconnect();
    resolve();
  };

  const observer = new MutationObserver(check);
  observer.observe(document, { childList: true, subtree: true });
  check();
});

const prefetched = new Map<string, ReturnType<typeof scoreOf>>();

for (const card of document.querySelectorAll(CARD)) {
  const id = idOf(card);

  if (id && !prefetched.has(id)) prefetched.set(id, scoreOf(card));
}

hydrated.then(() => {
  setupScoreGrid({
    cardSelector: CARD,
    idOf,
    scoreForCard: (card) => {
      const early = prefetched.get(idOf(card)!);
      prefetched.delete(idOf(card)!);

      return early ?? scoreOf(card);
    },
    // Or at the end of a placeholder, which survives its drawing (the
    // placeholder's contents don't). Its own width, not the title block's.
    placeBadge: (card, badge) => {
      badge.style.width = 'fit-content';
      (lineOf(card) ?? card).append(badge);
    },
  });

  // A placeholder's badge moves in once the card is drawn.
  new MutationObserver(() => {
    for (const badge of document.querySelectorAll(`${CARD} > .nps-score-badge`)) lineOf(badge.parentElement!)?.append(badge);
  }).observe(document.body, { childList: true, subtree: true });
});
