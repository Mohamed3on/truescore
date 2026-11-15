import { containersBySelector, setupScoreGrid } from '../shared/score-grid';
import { BJJ_FANATICS, cardScores } from '../shared/stamped';

const scoreOf = cardScores(BJJ_FANATICS);
const starsOf = (card: Element) => card.querySelector('.stamped-product-reviews-badge[data-id]');

// The Splide carousels on product and home pages ("What students are viewing")
// lay slides out by transform and turn clicks into paging, so they can't be
// ranked in place: each is swapped for a plain scrolling row of its own slides.
const ROW = 'ts-carousel';
const REPLACED = 'data-ts-replaced';

const style = document.createElement('style');

style.textContent = `
.${ROW} { display: flex !important; gap: 16px; margin: 0; padding: 0 0 12px; list-style: none; overflow-x: auto; scrollbar-width: thin; scrollbar-color: rgba(30, 45, 92, 0.45) transparent; }
.${ROW} > li { flex: 0 0 clamp(220px, 22%, 320px) !important; width: auto !important; margin: 0 !important; }
`;

document.head.append(style);

const replaceCarousels = () => {
  for (const root of document.querySelectorAll<HTMLElement>(`.splide:not([${REPLACED}])`)) {
    const list = root.querySelector('.splide__list');

    if (!list?.querySelector('a.product-card')) continue;
    const row = document.createElement('ul');
    row.className = list.className;
    row.classList.remove('splide__list', 'invisible');
    row.classList.add(ROW);
    row.append(...[...list.children].filter((slide) => !slide.classList.contains('splide__slide--clone')));
    root.setAttribute(REPLACED, '');
    root.style.display = 'none';
    root.after(row);
  }
};

replaceCarousels();

new MutationObserver(replaceCarousels).observe(document.body, { childList: true, subtree: true });

setupScoreGrid({
  cardSelector: `.product-card__grid-item, .${ROW} a.product-card`,
  scoreForCard: (card) => {
    const id = starsOf(card)?.getAttribute('data-id');

    return id ? scoreOf(id) : Promise.resolve(null);
  },
  // The card's info is a flex column: keep the badge from stretching across it.
  placeBadge: (card, badge) => {
    badge.style.alignSelf = 'flex-start';
    starsOf(card)?.after(badge);
  },
  // Search lists every result at once (964 for "guard"), too many to find their
  // row by structure on each re-rank.
  discover: containersBySelector(`.search-results, .collection-page__grid-products, .${ROW}`),
});
