// Booking reviews as TrueScore reads them, shared by the search ranking and the
// hotel panel: the traveler type to read (one saved preference), and each
// hotel's newest 200 reviews of that type, scored like every other site.
import { cacheGet, cacheSet } from './cache';
import { createThrottledFetcher } from './throttled-fetch';
import { npsStats } from './utils';

// ReviewList's `customerType` filter values; '' is every traveler.
export const BOOKING_TRAVELERS = [
  { name: 'Families', value: 'FAMILIES' },
  { name: 'Couples', value: 'COUPLES' },
  { name: 'Solo travelers', value: 'SOLO_TRAVELLERS' },
  { name: 'Groups of friends', value: 'GROUP_OF_FRIENDS' },
  { name: 'Business travelers', value: 'BUSINESS_TRAVELLERS' },
];

const KEY = 'bookingTraveler';

export const getBookingTraveler = async (): Promise<string> => {
  const stored = (await chrome.storage.sync.get(KEY))[KEY];

  return ['', ...BOOKING_TRAVELERS.map((traveler) => traveler.value)].find((value) => value === stored) ?? 'FAMILIES';
};

export const setBookingTraveler = (value: string) => chrome.storage.sync.set({ [KEY]: value });

export const SAMPLE = 200;
const PAGE = 25;
const CACHE_TTL = 24 * 60 * 60 * 1000;

// 20 at a time: measured against 6, 12, 30, 40 and unbounded, each request
// held ~235 ms up to 40 with no failures, while unbounded doubled it; a
// 20-card search page (160 requests) scores in about 2-4 s.
const throttledFetch = createThrottledFetcher(20);

export type Hotel = { id: string; country: string };

// The newest reviews' 9+ (loved) and ≤2 (hated) counts out of `n`, and how many
// reviews the traveler type has in all.
type Sample = { loved: number; hated: number; n: number; count: number };

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

export const sampleFor = (hotel: Hotel, traveler: string): Promise<Sample | null> => {
  const key = `bk-search-v2-${hotel.id}-${traveler || 'all'}`;
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

export const travelerName = (value: string) => BOOKING_TRAVELERS.find((type) => type.value === value)?.name.toLowerCase() ?? 'all travelers';

// Net loved (9+ minus 2-or-less) over the sample, weighted by every review of
// the traveler type: the sample's shares scaled up to that count.
export const trueScoreOf = (sample: Sample | null) => {
  if (!sample?.n) return null;
  const { score, nps } = npsStats((sample.loved / sample.n) * sample.count, (sample.hated / sample.n) * sample.count, sample.count);

  return { score, nps, total: sample.count };
};
