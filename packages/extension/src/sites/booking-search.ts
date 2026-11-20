// Booking.com search page: score every property from its newest 100 reviews by
// the chosen traveler type and rank by it.
import { BOOKING_TRAVELERS, getBookingTraveler, setBookingTraveler } from '../shared/booking-travelers';
import { cacheGet, cacheSet } from '../shared/cache';
import { orderByCssBand, setupScoreGrid } from '../shared/score-grid';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { npsStats } from '../shared/utils';

const CARD = '[data-testid="property-card"]';
const SAMPLE = 100;
const PAGE = 25;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const PICKER_ID = 'ts-bk-traveler';

// Six at a time: a 20-card page (80 requests) scores in about 4 s.
const throttledFetch = createThrottledFetcher(6);

type Hotel = { id: string; country: string };

// The newest reviews' 9+ (loved) and ≤2 (hated) counts out of `n`, and how many
// reviews the traveler type has in all.
type Sample = { loved: number; hated: number; n: number; count: number };

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

const reviewPage = async ({ id, country }: Hotel, customerType: string, skip: number) => {
  const res = await throttledFetch('/dml/graphql?', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      operationName: 'ReviewList',
      variables: {
        input: {
          hotelId: Number(id),
          hotelCountryCode: country,
          ufi: 0, // ignored: the hotel id alone picks the reviews
          sorter: 'NEWEST_FIRST',
          filters: customerType ? { text: '', customerType } : { text: '' },
          skip,
          limit: PAGE,
        },
      },
      extensions: {},
      query: `query ReviewList($input: ReviewListFrontendInput!) {
        reviewListFrontend(input: $input) {
          ... on ReviewListFrontendResult {
            customerTypeFilter { count value }
            reviewCard { reviewScore }
          }
        }
      }`,
    }),
  });

  if (!res.ok) throw new Error(`Booking reviews ${id}: ${res.status}`);
  const page = (await res.json())?.data?.reviewListFrontend;

  if (!page) throw new Error(`Booking reviews ${id}: no review list`);

  // SAFETY: the query above selects exactly these fields.
  return page as { customerTypeFilter?: { count: number; value: string }[]; reviewCard?: { reviewScore: number }[] };
};

const samples = new Map<string, Promise<Sample | null>>();

const sampleFor = (hotel: Hotel, traveler: string): Promise<Sample | null> => {
  const key = `bk-search-v1-${hotel.id}-${traveler || 'all'}`;
  const known = samples.get(key);

  if (known) return known;

  const pending = (async (): Promise<Sample> => {
    const cached = await cacheGet(key, CACHE_TTL);

    if (cached) return cached;
    const pages = await Promise.all(Array.from({ length: SAMPLE / PAGE }, (_, i) => reviewPage(hotel, traveler, i * PAGE)));
    const scores = pages.flatMap((page) => page.reviewCard ?? []).map((review) => review.reviewScore);

    const sample = {
      loved: scores.filter((score) => score >= 9).length,
      hated: scores.filter((score) => score <= 2).length,
      n: scores.length,
      count: pages[0].customerTypeFilter?.find((type) => type.value === (traveler || 'ALL'))?.count ?? scores.length,
    };

    cacheSet(key, sample);

    return sample;
  })().catch(() => {
    samples.delete(key); // Let the grid's backoff retry a transient failure.

    return null;
  });

  samples.set(key, pending);

  return pending;
};

const travelerName = (value: string) => BOOKING_TRAVELERS.find((type) => type.value === value)?.name.toLowerCase() ?? 'all travelers';

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
      const sample = hotel && (await sampleFor(hotel, traveler));

      if (!sample?.n) return null;
      // The sample's shares, scaled to every review of this traveler type.
      const { score, nps } = npsStats((sample.loved / sample.n) * sample.count, (sample.hated / sample.n) * sample.count, sample.count);

      return { score, nps, total: sample.count };
    },
    placeBadge: (card, badge) => {
      badge.prepend('TrueScore ');
      badge.title = `Newest ${SAMPLE} reviews from ${travelerName(traveler)}: share scoring 9+ minus share scoring 2 or less. ${badge.title}`;
      badge.style.marginLeft = '0';
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

  // Which travelers' reviews score the list, beside the results heading. Booking
  // re-renders the heading as results update, so it's re-mounted when lost.
  const mountPicker = () => {
    const heading = document.querySelector('h1');

    if (!heading || document.getElementById(PICKER_ID) || !document.querySelector(CARD)) return;
    const label = document.createElement('label');
    label.id = PICKER_ID;
    label.style.cssText = 'display:inline-flex;align-items:center;gap:8px;font-size:14px;white-space:nowrap;';
    label.append('TrueScore from');
    const select = document.createElement('select');
    select.style.cssText = 'font:inherit;color:inherit;padding:6px 8px;border:1px solid #868686;border-radius:8px;background:#fff;outline-color:#006ce4;cursor:pointer;';

    for (const { name, value } of [{ name: 'All travelers', value: '' }, ...BOOKING_TRAVELERS]) select.add(new Option(name, value));
    select.value = traveler;
    select.addEventListener('change', () => {
      traveler = select.value;
      setBookingTraveler(traveler);
      rescan();
    });
    label.append(select);
    heading.after(label);
  };

  mountPicker();
  new MutationObserver(mountPicker).observe(document.body, { childList: true, subtree: true });
});
