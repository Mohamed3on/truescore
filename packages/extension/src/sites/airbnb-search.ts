import { airbnbStats, type AirbnbStats } from '../shared/airbnb-stats';
import { setupScoreGrid } from '../shared/score-grid';
import { extendFirstSearchPage } from './airbnb-search-extra';

const CARD = '[data-testid="card-container"]';
const cache = new Map<string, Promise<AirbnbStats | null>>();
const waiting: (() => void)[] = [];
let active = 0;
const PDP_SECTIONS_HASH = 'e684d30a625b62ffc44534b933a39e82ca704d9176de1e27eaffa02dd68df990';

// Search data has no per-star shares. Keep listing requests modest while the
// cards score progressively.
const withFetchSlot = async <T>(work: () => Promise<T>): Promise<T> => {
  if (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try { return await work(); }
  finally {
    const next = waiting.shift();
    if (next) next(); // Hand the occupied slot directly to the next request.
    else active--;
  }
};

const listingId = (card: Element): string | null => {
  const href = card.querySelector<HTMLAnchorElement>('a[href*="/rooms/"]')?.getAttribute('href');
  return href?.match(/\/rooms\/(\d+)/)?.[1] ?? null;
};

const statsFromApi = async (id: string): Promise<AirbnbStats | null | undefined> => {
  const bootstrap = JSON.parse(document.getElementById('data-initializer-bootstrap')?.textContent || '{}');
  const apiKey = bootstrap['layout-init']?.api_config?.key;
  if (!apiKey) return undefined;
  const variables = {
    id: btoa(`StayListing:${id}`),
    demandStayListingId: btoa(`DemandStayListing:${id}`),
    pdpSectionsRequest: { adults: '1', layouts: ['SIDEBAR', 'SINGLE_COLUMN'], sectionIds: ['REVIEWS_DEFAULT'] },
    includePdpLayoutPipelineInputs: false,
    includePdpMigrationBookItNavFragment: false,
    includeGpBookItFragment: true,
    includePdpMigrationBookItFloatingFooterFragment: false,
    includePdpMigrationBookItSidebarFragment: false,
    includePdpMigrationBookItCalendarSheetFragment: false,
    includePdpMigrationBookItNonExperiencedGuestFragment: false,
    includeGpBookItNonExperiencedGuestFragment: true,
    includePdpMigrationPropertyAvailableRoomsFragment: false,
    includeGpPropertyAvailableRoomsFragment: true,
    includeRecentAskPdpQuestions: false,
    includePdpOffers: false,
  };
  const response = await fetch(`/api/v3/StaysPdpSections/${PDP_SECTIONS_HASH}?operationName=StaysPdpSections`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Airbnb-API-Key': apiKey, 'X-CSRF-Without-Token': '1' },
    body: JSON.stringify({
      operationName: 'StaysPdpSections',
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: PDP_SECTIONS_HASH } },
    }),
  });
  if (!response.ok) return undefined;
  const body = await response.text();
  const data = JSON.parse(body);
  // A missing quality object usually means Airbnb changed the private query;
  // a quality object with no reviews is a definitive unscored listing.
  if (!data?.data?.node?.pdpPresentation?.quality) return undefined;
  return airbnbStats(body);
};

const statsFromPage = async (id: string): Promise<AirbnbStats | null> => {
  const response = await fetch(`/rooms/${id}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Airbnb listing ${id}: ${response.status}`);
  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  return airbnbStats(page.getElementById('data-deferred-state-0')?.textContent || 'null');
};

const statsForListing = (id: string): Promise<AirbnbStats | null> => {
  const cached = cache.get(id);
  if (cached) return cached;
  const pending = withFetchSlot(async () => {
    const apiStats = await statsFromApi(id).catch(() => undefined);
    return apiStats !== undefined ? apiStats : statsFromPage(id);
  }).catch(() => {
    cache.delete(id); // Let the grid's backoff retry a transient failure.
    return null;
  });
  cache.set(id, pending);
  return pending;
};

setupScoreGrid({
  cardSelector: CARD,
  idOf: listingId,
  scoreForCard: async (card) => {
    const id = listingId(card);
    if (!id) return null;
    const stats = await statsForListing(id);
    return stats && { score: stats.score, nps: stats.nps, total: stats.count };
  },
  placeBadge: (card, badge) => {
    badge.prepend(' · TrueScore ');
    badge.title = `${badge.title}. Net loved: 5★ minus 1★, over all reviews`;
    const extraRating = card.querySelector('.ts-air-extra-rating');
    if (extraRating) {
      extraRating.append(badge);
      return;
    }
    // The visible host rating has no stable test ID. Its hidden spoken label
    // sits next to this numeric span; fall back to the listing title if absent.
    const rating = [...card.querySelectorAll('span[aria-hidden="true"]')]
      .find((span) => /^\d[\d.,]*\s*\(\d/.test(span.textContent?.trim() || ''));
    (rating?.parentElement || card.querySelector('[data-testid="listing-card-title"]') || card).append(badge);
  },
  // A search grid can contain a "similar dates" carousel as one child. Rank
  // its cards in their own row, but never treat the entire carousel as a card.
  rankableChild: (child) => child.querySelectorAll(CARD).length <= 1,
});

extendFirstSearchPage();
