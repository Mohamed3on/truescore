import { orderByCssBand } from '../shared/score-grid';

// Vinted sorts by relevance, price or newest, never by likes. A "Most liked" chip
// beside its "Sort by" chip re-ranks the loaded catalog page by each card's
// favourite count. On by default; the chip turns it off. CSS order only
// (orderByCssBand): the React grid is never moved.

const CARD = '[data-testid="grid-item"]';
const SORT_TRIGGER = '[data-testid="catalog--sort-filter--trigger"]';
const STORE_KEY = 'truescore-vinted-most-liked';

let on = localStorage.getItem(STORE_KEY) !== '0';

const likes = (card: Element) => parseInt(card.querySelector('[data-testid="favourite-count-text"]')?.textContent || '', 10) || 0;

const chip = document.createElement('div');

chip.className = 'u-ui-margin-right-regular u-ui-margin-bottom-regular';

chip.innerHTML = `<button type="button" class="web_ui__Chip__chip web_ui__Chip__outlined web_ui__Chip__round"><div class="web_ui__Chip__text"><span class="web_ui__Text__text web_ui__Text__subtitle web_ui__Text__left web_ui__Text__amplified">Most liked</span></div></button>`;

const button = chip.querySelector('button')!;

const resort = () => {
  const containers = new Set([...document.querySelectorAll(CARD)].map((card) => card.parentElement!));

  for (const container of containers) {
    const cards = [...container.children].filter((child) => child.matches(CARD));

    // Array sort is stable, so equal likes keep Vinted's order.
    if (on) orderByCssBand(container, cards.sort((a, b) => likes(b) - likes(a)));
    else orderByCssBand(container, [], cards);
  }
};

const render = () => {
  button.setAttribute('aria-pressed', String(on));
  button.classList.toggle('web_ui__Chip__activated', on);
};

button.addEventListener('click', () => {
  on = !on;
  localStorage.setItem(STORE_KEY, on ? '1' : '0');
  render();
  resort();
});

// Only catalog pages carry the sort chip; the grids elsewhere (home feed, a
// member's closet) stay in Vinted's order.
const sync = () => {
  const slot = document.querySelector(SORT_TRIGGER)?.closest('.u-flex-wrap > *');

  if (!slot) return;

  if (slot.nextElementSibling !== chip) slot.after(chip);
  resort();
};

render();

sync();

let timer: ReturnType<typeof setTimeout>;

new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(sync, 200);
}).observe(document.body, { childList: true, subtree: true });
