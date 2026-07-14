// Booking.com hotel page - recent reviews scoreboard + summary
import { cacheGet, cacheSet } from '../shared/cache';
import { buildSummarizeWidget } from '../shared/review-summary';
import { el } from '../shared/utils';
import { createIslandShell } from '../shared/score-island';

const graphqlEndpoint = 'https://www.booking.com/dml/graphql?';
const MIN_REVIEWS_PER_GROUP = 3;
const PAGE_SIZE = 25;
const DEFAULT_REVIEW_LIMIT = 100;
const REVIEW_LIMIT_OPTIONS = [100, 200, 500];
const REVIEWS_CACHE_TTL = 24 * 60 * 60 * 1000;
const ALL_TRAVELERS = '';
const ALL_TRAVELERS_CACHE_TOKEN = 'all';
const TEXT_FILTER_DEBOUNCE_MS = 500;

type Review = {
  reviewScore: number;
  bookingDetails: {
    customerType: string;
    roomType?: { name: string } | null;
  };
  textDetails?: {
    title?: string | null;
    positiveText?: string | null;
    negativeText?: string | null;
  } | null;
};
type Tier = { cls: string; color: string };
type HotelData = { hotelId: string; destId: string; hotelCountryCode: string };
type TravelerFilter = { name: string; value: string; count: number };
type TopicFilter = { id: number; name: string; isSelected?: boolean };
type ReviewsPayload = { reviews: Review[]; travelerFilters: TravelerFilter[]; topicFilters: TopicFilter[] };
type ReviewFilterState = {
  travelerType: string;
  searchText: string;
  reviewLimit: number;
  selectedTopicIds: number[];
};

const GUEST_LABELS: Record<string, string> = {
  COUPLE: 'Couple',
  SOLO_TRAVELER: 'Solo',
  GROUP_OF_FRIENDS: 'Group',
  FAMILY_WITH_YOUNG_CHILDREN: 'Family (young)',
  FAMILY_WITH_OLDER_CHILDREN: 'Family (older)',
  BUSINESS_TRAVELER: 'Business',
  REVIEW_FROM_A_FAMILY_WITH_CHILDREN: 'Family',
};

const FALLBACK_TRAVELER_FILTERS: TravelerFilter[] = [
  { name: 'Families', value: 'FAMILIES', count: 0 },
  { name: 'Couples', value: 'COUPLES', count: 0 },
  { name: 'Solo travelers', value: 'SOLO_TRAVELLERS', count: 0 },
  { name: 'Groups of friends', value: 'GROUPS_OF_FRIENDS', count: 0 },
  { name: 'Business travelers', value: 'BUSINESS_TRAVELLERS', count: 0 },
];

const FALLBACK_TOPIC_FILTERS: TopicFilter[] = [
  { id: 249, name: 'Location' },
  { id: 270, name: 'Room' },
  { id: 258, name: 'Quiet' },
  { id: 245, name: 'Breakfast' },
  { id: 276, name: 'Clean' },
  { id: 254, name: 'Bed' },
  { id: 261, name: 'Kitchen' },
  { id: 288, name: 'Car' },
  { id: 252, name: 'Noise' },
  { id: 275, name: 'Loud' },
  { id: 251, name: 'Beach' },
  { id: 255, name: 'Bathroom' },
  { id: 246, name: 'Parking' },
  { id: 278, name: 'Suite' },
  { id: 257, name: 'View' },
  { id: 280, name: 'Toilet' },
  { id: 296, name: 'Coffee' },
  { id: 291, name: 'Heat' },
  { id: 289, name: 'Window' },
  { id: 263, name: 'Shower' },
  { id: 284, name: 'Private' },
  { id: 260, name: 'Lift' },
  { id: 264, name: 'English' },
];

const SUMMARY_PROMPT = `Analyze these hotel reviews. Focus on the stay itself: rooms, beds, cleanliness, noise, staff, breakfast, amenities, location, and value. Ignore booking flow, flights, transfers, or anything unrelated to the actual hotel experience.

ONLY include points mentioned by 3+ reviewers. Rank by frequency (most mentioned first). Each bullet should be one concrete point, e.g. "Rooms are clean but noticeably compact".

If 2+ reviewers mention a specific better nearby alternative hotel, apartment, or chain, note it and explain the comparison.

End with a short summary: the gist of what guests say, anything to watch out for, any better-value alternatives mentioned, and whether this is the best stay you can get for the price.`;

const formatGuest = (value: string) =>
  GUEST_LABELS[value] ||
  value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());

const formatRoom = (value: string) => value.replace(/\s+/g, ' ').trim();

const TIER_NEG: Tier = { cls: 'neg', color: '#F87171' };
const TIER_MID: Tier = { cls: 'mid', color: '#E8B86D' };
const TIER_POS: Tier = { cls: 'pos', color: '#4ADE80' };
const tier = (pct: number): Tier => (pct < 50 ? TIER_NEG : pct < 65 ? TIER_MID : TIER_POS);

const getHotelCountryCode = () =>
  location.pathname.match(/\/hotel\/([a-z]{2})\//i)?.[1]?.toLowerCase() || 'us';

const scoreOf = (reviews: Review[]) => {
  const net = reviews.reduce(
    (acc, review) => acc + (review.reviewScore >= 9 ? 1 : review.reviewScore <= 2 ? -1 : 0),
    0,
  );
  return reviews.length ? Math.round((net / reviews.length) * 100) : 0;
};

const groupBy = (
  reviews: Review[],
  key: (review: Review) => string | undefined,
  format: (value: string) => string,
) => {
  const map = new Map<string, Review[]>();
  for (const review of reviews) {
    const rawKey = key(review);
    if (!rawKey) continue;
    if (!map.has(rawKey)) map.set(rawKey, []);
    map.get(rawKey)!.push(review);
  }
  return [...map.entries()]
    .filter(([, groupedReviews]) => groupedReviews.length >= MIN_REVIEWS_PER_GROUP)
    .map(([label, groupedReviews]) => ({
      label: format(label),
      count: groupedReviews.length,
      pct: scoreOf(groupedReviews),
    }))
    .sort((a, b) => b.count - a.count);
};

const formatReviewText = (review: Review) => {
  const title = review.textDetails?.title?.trim();
  const positive = review.textDetails?.positiveText?.trim();
  const negative = review.textDetails?.negativeText?.trim();
  const parts = [
    title ? `Title: ${title}` : '',
    positive ? `Liked: ${positive}` : '',
    negative ? `Disliked: ${negative}` : '',
  ].filter(Boolean);
  return parts.join('\n').trim();
};

const toReviewTexts = (reviews: Review[]) => {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const review of reviews) {
    const text = formatReviewText(review);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return texts;
};

const getTravelerLabel = (value: string, filters: TravelerFilter[]) =>
  filters.find((filter) => filter.value === value)?.name || 'selected traveler type';

const parseLegacyCacheSuffix = (suffix: string): ReviewFilterState | null => {
  const parts = suffix.split('-').filter(Boolean);
  if (parts.length < 2) return null;
  const limit = parseInt(parts.pop()!, 10);
  if (!Number.isFinite(limit)) return null;
  const traveler = parts.shift();
  if (!traveler) return null;
  const travelerType = traveler === ALL_TRAVELERS_CACHE_TOKEN ? ALL_TRAVELERS : traveler;
  let searchText = '';
  let selectedTopicIds: number[] = [];
  const textIdx = parts.indexOf('text');
  const topicsIdx = parts.indexOf('topics');
  if (textIdx !== -1) {
    const end = topicsIdx > textIdx ? topicsIdx : parts.length;
    const raw = parts.slice(textIdx + 1, end).join('-');
    try { searchText = decodeURIComponent(raw); } catch { searchText = raw; }
  }
  if (topicsIdx !== -1) {
    selectedTopicIds = parts.slice(topicsIdx + 1)
      .map((n) => parseInt(n, 10))
      .filter(Number.isFinite);
  }
  return {
    travelerType,
    searchText,
    reviewLimit: normalizeReviewLimit(limit),
    selectedTopicIds: normalizeTopicIds(selectedTopicIds),
  };
};

const describeFilterState = (
  state: ReviewFilterState | undefined,
  travelerFilters: TravelerFilter[],
  topicFilters: TopicFilter[],
): string => {
  if (!state) return '';
  const traveler = state.travelerType
    ? getTravelerLabel(state.travelerType, travelerFilters)
    : 'All travelers';
  const parts = [traveler];
  if (state.searchText) parts.push(`"${state.searchText}"`);
  const ids = state.selectedTopicIds || [];
  if (ids.length === 1) {
    const name = topicFilters.find((t) => t.id === ids[0])?.name;
    if (name) parts.push(name);
  } else if (ids.length > 1) {
    parts.push(`${ids.length} topics`);
  }
  parts.push(`${state.reviewLimit}`);
  return parts.join(' · ');
};

const normalizeSearchText = (value: string) => value.trim();
const normalizeTopicIds = (ids: number[]) =>
  [...new Set(ids.filter((id) => Number.isFinite(id)))].sort((a, b) => a - b);

const cacheSuffix = ({ travelerType, searchText, selectedTopicIds }: ReviewFilterState) => {
  const traveler = travelerType || ALL_TRAVELERS_CACHE_TOKEN;
  const text = normalizeSearchText(searchText);
  const topics = normalizeTopicIds(selectedTopicIds);
  const parts = [traveler];
  if (text) parts.push(`text-${encodeURIComponent(text.toLowerCase()).slice(0, 80)}`);
  if (topics.length) parts.push(`topics-${topics.join('-')}`);
  return parts.join('-');
};

const normalizeReviewLimit = (limit: number) =>
  REVIEW_LIMIT_OPTIONS.includes(limit) ? limit : DEFAULT_REVIEW_LIMIT;

const cacheKeyFor = (hotelId: string, filterState: ReviewFilterState) =>
  `bk-reviews-v4-${hotelId}-${cacheSuffix(filterState)}-${normalizeReviewLimit(filterState.reviewLimit)}`;

const requestKeyFor = (filterState: ReviewFilterState) =>
  `${cacheSuffix(filterState)}-${normalizeReviewLimit(filterState.reviewLimit)}`;

const createPayload = (
  { hotelId, destId, hotelCountryCode }: HotelData,
  skip: number,
  filterState: ReviewFilterState,
) => ({
  operationName: 'ReviewList',
  variables: {
    input: {
      hotelId: parseInt(hotelId, 10),
      hotelCountryCode,
      ufi: parseInt(destId, 10),
      sorter: 'NEWEST_FIRST',
      filters: {
        text: normalizeSearchText(filterState.searchText),
        ...(filterState.travelerType ? { customerType: filterState.travelerType } : {}),
        ...(filterState.selectedTopicIds.length
          ? { selectedTopics: normalizeTopicIds(filterState.selectedTopicIds) }
          : {}),
      },
      skip,
      limit: PAGE_SIZE,
    },
  },
  extensions: {},
  query: `query ReviewList($input: ReviewListFrontendInput!) {
    reviewListFrontend(input: $input) {
      ... on ReviewListFrontendResult {
        customerTypeFilter {
          count
          name
          value
        }
        topicFilters {
          id
          name
          isSelected
          translation { id name }
        }
        reviewCard {
          reviewScore
          guestDetails { countryName }
          bookingDetails { customerType roomType { name } checkoutDate }
          textDetails { title positiveText negativeText }
        }
      }
    }
  }`,
});

const fetchReviewPage = (hotelData: HotelData, skip: number, filterState: ReviewFilterState) =>
  fetch(graphqlEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(createPayload(hotelData, skip, filterState)),
  }).then((response) => (response.ok ? response.json() : null));

const normalizeFilterName = (name: string, fallback: string) =>
  (name || fallback).replace(/\s*\(\d+\)\s*$/, '').trim();

const normalizeTravelerFilters = (filters: TravelerFilter[] | undefined) => {
  const seen = new Set<string>();
  const normalized: TravelerFilter[] = [];
  for (const filter of filters || []) {
    if (!filter.value || seen.has(filter.value)) continue;
    const name = normalizeFilterName(filter.name, filter.value);
    if (filter.value === 'ALL' || name.toLowerCase() === 'all') continue;
    seen.add(filter.value);
    normalized.push({
      name,
      value: filter.value,
      count: filter.count || 0,
    });
  }
  return normalized.length ? normalized : FALLBACK_TRAVELER_FILTERS;
};

const normalizeTopicFilters = (filters: any[] | undefined) => {
  const seen = new Set<number>();
  const normalized: TopicFilter[] = [];
  for (const filter of filters || []) {
    const id = Number(filter.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      name: filter.translation?.name || filter.name || String(id),
      isSelected: Boolean(filter.isSelected),
    });
  }
  return normalized.length ? normalized : FALLBACK_TOPIC_FILTERS;
};

const fetchRecentReviews = async (
  hotelData: HotelData,
  filterState: ReviewFilterState,
): Promise<ReviewsPayload> => {
  const reviewLimit = normalizeReviewLimit(filterState.reviewLimit);
  const cacheKey = cacheKeyFor(hotelData.hotelId, { ...filterState, reviewLimit });
  const cached = cacheGet(cacheKey, REVIEWS_CACHE_TTL);
  if (cached) {
    return {
      reviews: Array.isArray(cached) ? cached : cached.reviews || [],
      travelerFilters: normalizeTravelerFilters(cached.travelerFilters),
      topicFilters: normalizeTopicFilters(cached.topicFilters),
    };
  }

  const pageCount = Math.ceil(reviewLimit / PAGE_SIZE);
  const pages = Array.from({ length: pageCount }, (_, index) =>
    fetchReviewPage(hotelData, index * PAGE_SIZE, filterState),
  );
  const results = await Promise.allSettled(pages);
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled',
  );
  const reviews: Review[] = fulfilled
    .flatMap((result) => result.value?.data?.reviewListFrontend?.reviewCard || []);
  const travelerFilters = normalizeTravelerFilters(
    fulfilled
      .map((result) => result.value?.data?.reviewListFrontend?.customerTypeFilter)
      .find((filters) => Array.isArray(filters) && filters.length),
  );
  const topicFilters = normalizeTopicFilters(
    fulfilled
      .map((result) => result.value?.data?.reviewListFrontend?.topicFilters)
      .find((filters) => Array.isArray(filters) && filters.length),
  );
  const payload = { reviews, travelerFilters, topicFilters };

  if (reviews.length) cacheSet(cacheKey, payload);
  return payload;
};

const buildReviewFilters = (
  filterState: ReviewFilterState,
  filters: TravelerFilter[],
  topicFilters: TopicFilter[],
  onChange: (nextFilterState: ReviewFilterState) => void,
) => {
  const wrapper = el('div', 'ts-bp-filters');
  const travelerWrapper = el('label', 'ts-bp-filter ts-bp-filter--traveler');
  travelerWrapper.appendChild(el('span', 'ts-bp-filter-label', 'Traveler'));
  const select = document.createElement('select');
  select.className = 'ts-bp-filter-select';

  const allOption = document.createElement('option');
  allOption.value = ALL_TRAVELERS;
  allOption.textContent = 'All travelers';
  allOption.label = 'All travelers';
  select.appendChild(allOption);

  for (const filter of filters) {
    const option = document.createElement('option');
    option.value = filter.value;
    option.textContent = filter.count ? `${filter.name} (${filter.count})` : filter.name;
    option.label = filter.name;
    select.appendChild(option);
  }

  select.value = filterState.travelerType;
  travelerWrapper.appendChild(select);
  wrapper.appendChild(travelerWrapper);

  const limitWrapper = el('label', 'ts-bp-filter ts-bp-filter--limit');
  limitWrapper.appendChild(el('span', 'ts-bp-filter-label', 'Reviews'));
  const limitSelect = document.createElement('select');
  limitSelect.className = 'ts-bp-filter-select';
  for (const limit of REVIEW_LIMIT_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(limit);
    option.textContent = `${limit} reviews`;
    option.label = String(limit);
    limitSelect.appendChild(option);
  }
  limitSelect.value = String(normalizeReviewLimit(filterState.reviewLimit));
  limitWrapper.appendChild(limitSelect);
  wrapper.appendChild(limitWrapper);

  const textWrapper = el('label', 'ts-bp-filter ts-bp-filter--text');
  textWrapper.appendChild(el('span', 'ts-bp-filter-label', 'Search reviews'));
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'ts-bp-filter-input';
  input.placeholder = 'breakfast, noise, parking...';
  input.value = filterState.searchText;
  let textTimer: number | null = null;
  const nextState = (searchText = normalizeSearchText(input.value)): ReviewFilterState => ({
    travelerType: select.value,
    searchText,
    reviewLimit: normalizeReviewLimit(parseInt(limitSelect.value, 10)),
    selectedTopicIds: normalizeTopicIds(filterState.selectedTopicIds),
  });
  select.addEventListener('change', () =>
    onChange(nextState()),
  );
  limitSelect.addEventListener('change', () =>
    onChange(nextState()),
  );
  const runTextSearch = () => {
    const nextSearchText = normalizeSearchText(input.value);
    if (nextSearchText === filterState.searchText) return;
    onChange(nextState(nextSearchText));
  };
  input.addEventListener('input', () => {
    if (textTimer) window.clearTimeout(textTimer);
    textTimer = window.setTimeout(runTextSearch, TEXT_FILTER_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (textTimer) window.clearTimeout(textTimer);
    runTextSearch();
  });
  textWrapper.appendChild(input);
  wrapper.appendChild(textWrapper);

  const topicWrapper = el('div', 'ts-bp-topics');
  const topicLabel = el('div', 'ts-bp-filter-label', 'Topics');
  topicWrapper.appendChild(topicLabel);
  const topicList = el('div', 'ts-bp-topic-list');
  const selectedTopics = new Set(normalizeTopicIds(filterState.selectedTopicIds));
  for (const topic of topicFilters) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = selectedTopics.has(topic.id) ? 'ts-bp-topic is-selected' : 'ts-bp-topic';
    chip.textContent = topic.name;
    chip.setAttribute('aria-pressed', String(selectedTopics.has(topic.id)));
    chip.addEventListener('click', () => {
      const nextTopics = new Set(selectedTopics);
      if (nextTopics.has(topic.id)) nextTopics.delete(topic.id);
      else nextTopics.add(topic.id);
      onChange({ ...nextState(), selectedTopicIds: normalizeTopicIds([...nextTopics]) });
    });
    topicList.appendChild(chip);
  }
  topicWrapper.appendChild(topicList);
  wrapper.appendChild(topicWrapper);

  return wrapper;
};

const mountPanel = (panel: HTMLElement) => {
  const galleryMount = document.querySelector('.k2-hp--gallery-header #hotel_main_content')
    || document.querySelector('.k2-hp--gallery-header');
  const mount = galleryMount || document.querySelector('#js--hp-gallery-scorecard');
  if (!mount) return;
  panel.classList.toggle('ts-bp-wide', Boolean(galleryMount));
  const existing = document.querySelector('.ts-bp');
  if (existing?.parentElement === mount) existing.replaceWith(panel);
  else {
    existing?.remove();
    mount.appendChild(panel);
  }
};

const renderLoadingPanel = (
  filterState: ReviewFilterState,
  filters: TravelerFilter[],
  topicFilters: TopicFilter[],
  onFilterChange: (nextFilterState: ReviewFilterState) => void,
) => {
  const panel = el('div', 'ts-bp ts-bp-loading');
  const head = el('div', 'ts-bp-head');
  const headLeft = el('div');
  const kicker = el('div', 'ts-bp-kicker');
  kicker.appendChild(el('span', 'ts-bp-dot'));
  kicker.appendChild(document.createTextNode('Recent reviews'));
  headLeft.appendChild(kicker);
  headLeft.appendChild(el('div', 'ts-bp-sub', 'Fetching newest reviews...'));
  head.appendChild(headLeft);
  head.appendChild(el('div', 'ts-bp-score', '--'));
  panel.appendChild(head);
  panel.appendChild(buildReviewFilters(filterState, filters, topicFilters, onFilterChange));
  mountPanel(panel);
};

const renderEmptyPanel = (
  filterState: ReviewFilterState,
  filters: TravelerFilter[],
  topicFilters: TopicFilter[],
  onFilterChange: (nextFilterState: ReviewFilterState) => void,
) => {
  const panel = el('div', 'ts-bp');
  const head = el('div', 'ts-bp-head');
  const headLeft = el('div');
  const kicker = el('div', 'ts-bp-kicker');
  kicker.appendChild(el('span', 'ts-bp-dot'));
  kicker.appendChild(document.createTextNode('Recent reviews'));
  headLeft.appendChild(kicker);
  headLeft.appendChild(el('div', 'ts-bp-sub', 'No matching reviews found'));
  head.appendChild(headLeft);
  head.appendChild(el('div', 'ts-bp-score', '--'));
  panel.appendChild(head);
  panel.appendChild(buildReviewFilters(filterState, filters, topicFilters, onFilterChange));
  mountPanel(panel);
};

function waitForHotelData(callback: (data: HotelData) => void) {
  const checkInterval = setInterval(() => {
    const hotelIdInput = document.querySelector('input[name="hotel_id"]') as HTMLInputElement;
    const destIdInput = document.querySelector('input[name="dest_id"]') as HTMLInputElement;
    if (!hotelIdInput?.value || !destIdInput?.value) return;
    clearInterval(checkInterval);
    callback({
      hotelId: hotelIdInput.value,
      destId: destIdInput.value,
      hotelCountryCode: getHotelCountryCode(),
    });
  }, 500);
}

waitForHotelData((hotelData) => {
  let travelerFilters: TravelerFilter[] = [];
  let topicFilters: TopicFilter[] = FALLBACK_TOPIC_FILTERS;
  let currentFilterState: ReviewFilterState = {
    travelerType: ALL_TRAVELERS,
    searchText: '',
    reviewLimit: DEFAULT_REVIEW_LIMIT,
    selectedTopicIds: [],
  };
  let renderId = 0;
  const reviewsByFilter = new Map<string, Promise<ReviewsPayload>>();
  const getReviews = (filterState = currentFilterState) => {
    const key = requestKeyFor(filterState);
    if (!reviewsByFilter.has(key)) {
      reviewsByFilter.set(key, fetchRecentReviews(hotelData, filterState));
    }
    return reviewsByFilter.get(key)!;
  };

  const render = async (filterState = currentFilterState) => {
    currentFilterState = {
      travelerType: filterState.travelerType,
      searchText: normalizeSearchText(filterState.searchText),
      reviewLimit: normalizeReviewLimit(filterState.reviewLimit),
      selectedTopicIds: normalizeTopicIds(filterState.selectedTopicIds),
    };
    const activeRenderId = ++renderId;
    renderLoadingPanel(currentFilterState, travelerFilters, topicFilters, render);

    try {
      const {
        reviews: allReviews,
        travelerFilters: fetchedTravelerFilters,
        topicFilters: fetchedTopicFilters,
      } = await getReviews(currentFilterState);
      if (activeRenderId !== renderId) return;
      if (fetchedTravelerFilters.length) travelerFilters = fetchedTravelerFilters;
      if (fetchedTopicFilters.length) topicFilters = fetchedTopicFilters;
      if (!allReviews.length) {
        renderEmptyPanel(currentFilterState, travelerFilters, topicFilters, render);
        return;
      }

      const overallPct = scoreOf(allReviews);
      const guestRows = groupBy(allReviews, (review) => review.bookingDetails.customerType, formatGuest);
      const roomRows = groupBy(allReviews, (review) => review.bookingDetails.roomType?.name, formatRoom);
      const reviewTexts = toReviewTexts(allReviews);
      const travelerLabel = currentFilterState.travelerType
        ? getTravelerLabel(currentFilterState.travelerType, travelerFilters).toLowerCase()
        : 'all travelers';
      const activeFilterLabel = currentFilterState.searchText
        ? `${travelerLabel} · "${currentFilterState.searchText}"`
        : travelerLabel;
      const topicLabel = currentFilterState.selectedTopicIds.length
        ? ` · ${currentFilterState.selectedTopicIds.length} topics`
        : '';
      const metaLabel = `${allReviews.length} reviews · ${activeFilterLabel}${topicLabel}`;

      const panel = el('div', 'ts-bp');

      const head = el('div', 'ts-bp-head');
      const headLeft = el('div');
      const kicker = el('div', 'ts-bp-kicker');
      kicker.appendChild(el('span', 'ts-bp-dot'));
      kicker.appendChild(document.createTextNode('Recent reviews'));
      headLeft.appendChild(kicker);
      const sub = el('div', 'ts-bp-sub', metaLabel);
      sub.title = `Last ${allReviews.length} reviews · newest first · ${activeFilterLabel}`;
      headLeft.appendChild(sub);
      const scoreEl = el('div', 'ts-bp-score', `${overallPct}%`);
      scoreEl.style.color = tier(overallPct).color;
      head.appendChild(headLeft);
      head.appendChild(scoreEl);
      panel.appendChild(head);
      panel.appendChild(buildReviewFilters(currentFilterState, travelerFilters, topicFilters, render));

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
          el('span', 'ts-bp-section-count', rows.reduce((acc, row) => acc + row.count, 0)),
        );
        section.appendChild(sectionHead);

        for (const row of rows) {
          const rowTier = tier(row.pct);
          const rowEl = el('div', `ts-bp-row ${rowTier.cls}`);
          const fill = el('div', 'ts-bp-row-fill');
          fill.style.width = `${Math.max(2, Math.min(100, row.pct))}%`;
          rowEl.appendChild(fill);
          const labelEl = el('span', 'ts-bp-label', row.label);
          labelEl.title = row.label;
          rowEl.appendChild(labelEl);
          const pctEl = el('span', 'ts-bp-pct', `${row.pct}%`);
          pctEl.style.color = rowTier.color;
          rowEl.appendChild(pctEl);
          rowEl.appendChild(el('span', 'ts-bp-count', row.count));
          section.appendChild(rowEl);
        }
        panel.appendChild(section);
      };

      renderSection('By guest', guestRows);
      renderSection('By room', roomRows);

      if (reviewTexts.length >= MIN_REVIEWS_PER_GROUP) {
        const summaryWrapper = createIslandShell();

        buildSummarizeWidget({
          wrapper: summaryWrapper,
          cacheKey: `bk-summary-${hotelData.hotelId}-${cacheSuffix(currentFilterState)}-${currentFilterState.reviewLimit}`,
          summaryPrompt: SUMMARY_PROMPT,
          questionPlaceholder: 'Ask about this hotel\u2026',
          questionPrompt: 'Answer this question using ONLY evidence from the hotel reviews below. Quote or paraphrase the most concrete details about the stay. If reviewers disagree, surface the tension. Be direct and practical.',
          fetchReviews: async () => toReviewTexts((await getReviews(currentFilterState)).reviews),
          cacheMeta: { filterState: currentFilterState },
          alternates: {
            prefix: `bk-summary-${hotelData.hotelId}-`,
            decode: (entry) => {
              const fromMeta = entry.meta?.filterState as ReviewFilterState | undefined;
              const filterState = fromMeta || parseLegacyCacheSuffix(
                entry.key.slice(`bk-summary-${hotelData.hotelId}-`.length),
              );
              if (!filterState) return null;
              const label = describeFilterState(filterState, travelerFilters, topicFilters);
              if (!label) return null;
              return { label, onSelect: () => render(filterState) };
            },
          },
        });

        panel.appendChild(summaryWrapper);
      }

      mountPanel(panel);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  render();
});
