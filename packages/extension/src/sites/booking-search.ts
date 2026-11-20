// Booking.com search page: score every property from its newest 500 reviews by
// the chosen traveler type and rank by it.
import { BOOKING_TRAVELERS, getBookingTraveler, type Hotel, sampleFor, SAMPLE, setBookingTraveler, travelerName, trueScoreOf } from '../shared/booking-reviews';
import { orderByCssBand, setupScoreGrid } from '../shared/score-grid';

const CARD = '[data-testid="property-card"]';
const PICKER_ID = 'ts-bk-traveler';

// The card links carry "matching_block_id=1692255401_…": a room block id is
// the hotel id plus a two-digit room number. Cards added by "Load more" carry it too.
const hotelOf = (card: Element): Hotel | null => {
  const href = card.querySelector<HTMLAnchorElement>('[data-testid="title-link"]')?.href;

  if (!href) return null;
  const { pathname, searchParams } = new URL(href);
  const id = (searchParams.get('matching_block_id') ?? searchParams.get('highlighted_blocks'))?.split('_')[0].slice(0, -2);
  const country = pathname.match(/\/hotel\/([a-z]{2})\//)?.[1];

  return id && country ? { id, country } : null;
};

getBookingTraveler().then((initial) => {
  let traveler = initial;

  const rescan = setupScoreGrid({
    cardSelector: CARD,
    // The traveler type is part of the identity, so switching it rescores every card.
    idOf: (card) => {
      const hotel = hotelOf(card);

      return hotel && `${hotel.id}:${traveler}`;
    },
    scoreForCard: async (card) => {
      const hotel = hotelOf(card);

      return hotel && trueScoreOf(await sampleFor(hotel, traveler));
    },
    placeBadge: (card, badge) => {
      // Set like the host's own "2,483 reviews" line: a gray label, the figure in
      // the score's color.
      const label = document.createElement('span');
      label.textContent = 'TrueScore ';
      label.style.cssText = 'color:#595959;font-weight:400;';
      badge.prepend(label);
      badge.title = `Up to the newest ${SAMPLE} reviews from ${travelerName(traveler)}: share scoring 9+ minus share scoring 2 or less. ${badge.title}`;
      Object.assign(badge.style, { marginLeft: '0', lineHeight: '18px', fontVariantNumeric: 'tabular-nums' });
      // Under the review count, in the host's label column.
      card.querySelector('[data-testid="review-score"]')?.lastElementChild?.append(badge);
    },
    // The list view stacks its cards in a block, which ignores CSS `order`.
    applyOrder: (container, scored, rest, sunk) => {
      if (container instanceof HTMLElement && getComputedStyle(container).display === 'block') {
        Object.assign(container.style, { display: 'flex', flexDirection: 'column' });
      }

      orderByCssBand(container, scored, rest, sunk);
    },
  });

  // Which travelers' reviews score the list: a pill in the host's own sort and
  // filter row, drawn like its "Sort by" pill. Booking re-renders that row as
  // results update, so it's re-mounted when lost.
  const mountPicker = () => {
    if (document.getElementById(PICKER_ID) || !document.querySelector(CARD)) return;
    // The sort pill sits alone in a few wrappers; the row is where it gains siblings.
    let slot = document.querySelector('[data-testid="sorters-dropdown-trigger"]') ?? document.querySelector('h1');

    while (slot?.parentElement && slot.parentElement.children.length < 2) slot = slot.parentElement;

    if (!slot) return;
    const pill = document.createElement('label');
    pill.id = PICKER_ID;
    pill.style.cssText = 'position:relative;display:inline-flex;align-items:center;height:36px;box-sizing:border-box;padding:0 12px 0 16px;border:1px solid #868686;border-radius:9999px;background:#fff;color:#1a1a1a;font-size:14px;white-space:nowrap;cursor:pointer;';
    pill.append('TrueScore:');
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Rank by reviews from');
    select.style.cssText = 'appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-weight:500;padding:0 24px 0 4px;outline:none;cursor:pointer;';
    const chevron = document.createElement('span');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.style.cssText = 'position:absolute;right:12px;display:flex;pointer-events:none;';
    chevron.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    // The select draws no ring of its own: the pill takes Booking's focus blue.
    select.addEventListener('focus', () => {
      if (select.matches(':focus-visible')) Object.assign(pill.style, { outline: '2px solid #006ce4', outlineOffset: '2px' });
    });
    select.addEventListener('blur', () => { pill.style.outline = ''; });

    for (const { name, value } of [{ name: 'All travelers', value: '' }, ...BOOKING_TRAVELERS]) select.add(new Option(name, value));
    select.value = traveler;
    select.addEventListener('change', () => {
      traveler = select.value;
      setBookingTraveler(traveler);
      rescan();
    });
    pill.append(select, chevron);
    slot.after(pill);
  };

  mountPicker();
  new MutationObserver(mountPicker).observe(document.body, { childList: true, subtree: true });
});
