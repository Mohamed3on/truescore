// The Booking traveler type TrueScore reads reviews from, shared by the hotel
// panel and the search ranking. Values are ReviewList's `customerType` filter;
// '' is every traveler.
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
