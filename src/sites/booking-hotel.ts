// Booking.com hotel page - recent reviews scoreboard
import { el } from '../shared/utils';

const graphqlEndpoint = 'https://www.booking.com/dml/graphql?';
const MIN_REVIEWS_PER_GROUP = 3;
const PAGE_SIZE = 25;
const PAGE_COUNT = 4;

type Review = { reviewScore: number; bookingDetails: { customerType: string; roomType: { name: string } } };
type Tier = { cls: string; color: string };

const GUEST_LABELS: Record<string, string> = {
  COUPLE: 'Couple',
  SOLO_TRAVELER: 'Solo',
  GROUP_OF_FRIENDS: 'Group',
  FAMILY_WITH_YOUNG_CHILDREN: 'Family (young)',
  FAMILY_WITH_OLDER_CHILDREN: 'Family (older)',
  BUSINESS_TRAVELER: 'Business',
  REVIEW_FROM_A_FAMILY_WITH_CHILDREN: 'Family',
};

const formatGuest = (t: string) =>
  GUEST_LABELS[t] ||
  t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const formatRoom = (t: string) => t.replace(/\s+/g, ' ').trim();

const TIER_NEG: Tier = { cls: 'neg', color: '#F87171' };
const TIER_MID: Tier = { cls: 'mid', color: '#E8B86D' };
const TIER_POS: Tier = { cls: 'pos', color: '#4ADE80' };
const tier = (pct: number): Tier => (pct < 50 ? TIER_NEG : pct < 65 ? TIER_MID : TIER_POS);

function waitForHotelId(callback: (id: string) => void) {
  const checkInterval = setInterval(() => {
    const hotelIdInput = document.querySelector('input[name="hotel_id"]') as HTMLInputElement;
    if (hotelIdInput?.value) { clearInterval(checkInterval); callback(hotelIdInput.value); }
  }, 500);
}

waitForHotelId((hotelId) => {
  const destId = (document.querySelector('input[name="dest_id"]') as HTMLInputElement).value;

  const createPayload = (skip: number) => ({
    operationName: 'ReviewList',
    variables: {
      input: {
        hotelId: parseInt(hotelId), hotelCountryCode: 'gr', ufi: parseInt(destId),
        sorter: 'NEWEST_FIRST', filters: { text: '' }, skip, limit: PAGE_SIZE,
      },
    },
    extensions: {},
    query: `query ReviewList($input: ReviewListFrontendInput!) {
      reviewListFrontend(input: $input) {
        ... on ReviewListFrontendResult {
          reviewCard { reviewScore guestDetails { countryName } bookingDetails { customerType roomType { name } checkoutDate } }
        }
      }
    }`,
  });

  const fetchReviews = (skip: number) =>
    fetch(graphqlEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(createPayload(skip)),
    }).then((r) => r.json());

  const pages = Array.from({ length: PAGE_COUNT }, (_, i) => fetchReviews(i * PAGE_SIZE));

  Promise.allSettled(pages)
    .then((results) => {
      const allReviews: Review[] = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .flatMap((r) => r.value.data.reviewListFrontend.reviewCard);

      if (!allReviews.length) return;

      const scoreOf = (reviews: Review[]) => {
        const net = reviews.reduce(
          (acc, r) => acc + (r.reviewScore >= 9 ? 1 : r.reviewScore <= 2 ? -1 : 0),
          0,
        );
        return reviews.length ? Math.round((net / reviews.length) * 100) : 0;
      };

      const groupBy = (key: (r: Review) => string, format: (s: string) => string) => {
        const map = new Map<string, Review[]>();
        for (const r of allReviews) {
          const k = key(r);
          if (!k) continue;
          if (!map.has(k)) map.set(k, []);
          map.get(k)!.push(r);
        }
        return [...map.entries()]
          .filter(([, revs]) => revs.length >= MIN_REVIEWS_PER_GROUP)
          .map(([label, revs]) => ({ label: format(label), count: revs.length, pct: scoreOf(revs) }))
          .sort((a, b) => b.count - a.count);
      };

      const overallPct = scoreOf(allReviews);
      const guestRows = groupBy((r) => r.bookingDetails.customerType, formatGuest);
      const roomRows = groupBy((r) => r.bookingDetails.roomType?.name, formatRoom);

      const panel = el('div', 'ts-bp');

      const head = el('div', 'ts-bp-head');
      const headLeft = el('div');
      const kicker = el('div', 'ts-bp-kicker');
      kicker.appendChild(el('span', 'ts-bp-dot'));
      kicker.appendChild(document.createTextNode('Recent reviews'));
      headLeft.appendChild(kicker);
      headLeft.appendChild(el('div', 'ts-bp-sub', `Last ${allReviews.length} · newest first`));
      const scoreEl = el('div', 'ts-bp-score', `${overallPct}%`);
      scoreEl.style.color = tier(overallPct).color;
      head.appendChild(headLeft);
      head.appendChild(scoreEl);
      panel.appendChild(head);

      const renderSection = (
        label: string,
        rows: { label: string; count: number; pct: number }[],
      ) => {
        if (!rows.length) return;
        const section = el('div', 'ts-bp-section');
        const sectionHead = el('div', 'ts-bp-section-head');
        sectionHead.appendChild(el('span', 'ts-bp-section-label', label));
        sectionHead.appendChild(el('span', 'ts-bp-rule'));
        sectionHead.appendChild(
          el('span', 'ts-bp-section-count', rows.reduce((a, r) => a + r.count, 0)),
        );
        section.appendChild(sectionHead);

        for (const row of rows) {
          const t = tier(row.pct);
          const r = el('div', `ts-bp-row ${t.cls}`);
          const fill = el('div', 'ts-bp-row-fill');
          fill.style.width = `${Math.max(2, Math.min(100, row.pct))}%`;
          r.appendChild(fill);
          const labelEl = el('span', 'ts-bp-label', row.label);
          labelEl.title = row.label;
          r.appendChild(labelEl);
          const pctEl = el('span', 'ts-bp-pct', `${row.pct}%`);
          pctEl.style.color = t.color;
          r.appendChild(pctEl);
          r.appendChild(el('span', 'ts-bp-count', row.count));
          section.appendChild(r);
        }
        panel.appendChild(section);
      };

      renderSection('By guest', guestRows);
      renderSection('By room', roomRows);

      document.querySelector('#js--hp-gallery-scorecard')?.appendChild(panel);
    })
    .catch((error) => console.error('Error:', error));
});
