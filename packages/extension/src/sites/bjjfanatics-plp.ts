import { containersBySelector, orderByCssBand, setupScoreGrid } from '../shared/score-grid';
import { BJJ_FANATICS, cardScores } from '../shared/stamped';

const scoreOf = cardScores(BJJ_FANATICS);
const starsOf = (card: Element) => card.querySelector('.stamped-product-reviews-badge[data-id]');

// The carousels on product and home pages ("What students are viewing").
const CAROUSEL_CARD = 'a.product-card';
const CLONE = 'splide__slide--clone';
const isClone = (slide: Element) => slide.classList.contains(CLONE);
const cardIn = (slide: Element) => slide.querySelector(CAROUSEL_CARD);

// Splide pages a carousel by where each slide is laid out, so CSS order would
// scramble its arrows: the cards move between the slides instead (static
// Shopify markup, nothing re-renders them). Its loop clones copy the slides
// (the last few ahead of the first, the first few after the last), so each is
// refreshed from the slide it stands for.
const orderSlides = (list: Element, scored: Element[], rest: Element[], sunk: Element[]) => {
  const cards = [...scored, ...rest, ...sunk].flatMap((slide) => (isClone(slide) ? [] : [cardIn(slide)]));
  const slides = [...list.children].filter((slide) => !isClone(slide));

  slides.forEach((slide, i) => {
    if (cards[i] && cardIn(slide) !== cards[i]) slide.replaceChildren(cards[i]!);
  });

  const head = [...list.children].findIndex((child) => !isClone(child));

  [...list.children].forEach((child, at) => {
    if (!isClone(child)) return;
    const card = cards[(((at - head) % cards.length) + cards.length) % cards.length];
    const copy = cardIn(child);

    if (card && (copy?.getAttribute('href') !== card.getAttribute('href') || !copy.querySelector('.nps-score-badge') !== !card.querySelector('.nps-score-badge'))) {
      child.replaceChildren(card.cloneNode(true));
    }
  });
};

setupScoreGrid({
  cardSelector: `.product-card__grid-item, ${CAROUSEL_CARD}`,
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
  discover: containersBySelector('.search-results, .collection-page__grid-products, .splide__list'),
  rankableChild: (child) => !isClone(child),
  applyOrder: (container, ...ranked) => (container.matches('.splide__list') ? orderSlides : orderByCssBand)(container, ...ranked),
});
