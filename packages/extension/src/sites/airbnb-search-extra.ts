import { structuralContainers } from '../shared/score-grid';

const CARD = '[data-testid="card-container"]';
const SEARCH_HASH = '0afc7d440ee66286e44038530dc8d2af77d795e434e5cc5c8a8034c93cb377cf';
const PAGE_SIZE = 36;

type SearchListing = {
  demandStayListing?: { id?: string };
  title?: string;
  subtitle?: string;
  avgRatingLocalized?: string;
  contextualPictures?: { picture?: string; id?: string }[];
  structuredDisplayPrice?: { primaryLine?: { price?: string; discountedPrice?: string; qualifier?: string; accessibilityLabel?: string } };
};

const listingId = (listing: SearchListing): string | null => {
  try { return atob(listing.demandStayListing?.id || '').match(/:(\d+)$/)?.[1] || null; }
  catch { return null; }
};

const mainGrid = (): Element | null => {
  const nativeCards = [...document.querySelectorAll(CARD)].filter((card) => !card.closest('.ts-air-extra'));
  return [...structuralContainers(CARD)(nativeCards)]
    .sort((a, b) => b.querySelectorAll(CARD).length - a.querySelectorAll(CARD).length)[0] || null;
};

const deferredVariables = async (url: string, initialUrl: string): Promise<Record<string, any> | null> => {
  let state = document.getElementById('data-deferred-state-0')?.textContent;
  if (url !== initialUrl) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) return null;
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    state = page.getElementById('data-deferred-state-0')?.textContent;
  }
  if (!state) return null;
  const entries = JSON.parse(state).niobeClientData as [string, unknown][];
  const key = entries.find(([name]) => name.startsWith('StaysSearch:'))?.[0];
  return key ? JSON.parse(key.slice('StaysSearch:'.length)) : null;
};

const loadResults = async (url: string, initialUrl: string): Promise<{ listings: SearchListing[]; nextCursor?: string } | null> => {
  const bootstrap = JSON.parse(document.getElementById('data-initializer-bootstrap')?.textContent || '{}');
  const apiKey = bootstrap['layout-init']?.api_config?.key;
  const variables = await deferredVariables(url, initialUrl);
  if (!apiKey || !variables?.staysSearchRequest?.rawParams) return null;
  // Airbnb adds its default 18-item filter before URL filters. Replace every
  // copy so the server returns two pages of native search data in one request.
  const params = variables.staysSearchRequest.rawParams as { filterName: string; filterValues: string[] }[];
  variables.staysSearchRequest.rawParams = [
    ...params.filter((param) => param.filterName !== 'itemsPerGrid'),
    { filterName: 'itemsPerGrid', filterValues: [String(PAGE_SIZE)] },
  ];
  const response = await fetch(`/api/v3/StaysSearch/${SEARCH_HASH}?operationName=StaysSearch`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Airbnb-API-Key': apiKey, 'X-CSRF-Without-Token': '1' },
    body: JSON.stringify({
      operationName: 'StaysSearch',
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: SEARCH_HASH } },
    }),
  });
  if (!response.ok) return null;
  const results = (await response.json())?.data?.presentation?.staysSearch?.results;
  if (!Array.isArray(results?.searchResults) || results.searchResults.length <= PAGE_SIZE / 2) return null;
  return {
    listings: results.searchResults.slice(PAGE_SIZE / 2),
    nextCursor: results.paginationInfo?.pageCursors?.[1],
  };
};

const listingUrl = (id: string, photoId?: string): string => {
  const url = new URL(`/rooms/${id}`, location.origin);
  const search = new URL(location.href).searchParams;
  for (const [from, to] of [['adults', 'adults'], ['children', 'children'], ['infants', 'infants'], ['pets', 'pets'], ['checkin', 'check_in'], ['checkout', 'check_out']]) {
    const value = search.get(from);
    if (value) url.searchParams.set(to, value);
  }
  if (photoId) url.searchParams.set('photo_id', photoId);
  return url.pathname + url.search;
};

const ensureStyles = (): void => {
  if (document.getElementById('ts-air-extra-style')) return;
  const style = document.createElement('style');
  style.id = 'ts-air-extra-style';
  style.textContent = `
    .ts-air-extra { display: grid; min-width: 0; align-content: start; }
    .ts-air-extra [data-testid="card-container"] { min-width: 0; font: 14px/1.4 system-ui, sans-serif; color: #222; }
    .ts-air-extra-photo { aspect-ratio: 4 / 3; overflow: hidden; border-radius: 12px; background: #eee; }
    .ts-air-extra-photo a, .ts-air-extra-photo [data-testid="listing-image"], .ts-air-extra-photo img { display: block; width: 100%; height: 100%; }
    .ts-air-extra-photo img { object-fit: cover; }
    .ts-air-extra-info { display: grid; gap: 2px; padding: 10px 2px 0; }
    .ts-air-extra-title-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
    .ts-air-extra-title-row a { color: inherit; font-weight: 600; text-decoration: none; }
    .ts-air-extra-title-row a:hover { text-decoration: underline; }
    .ts-air-extra-title-row a:focus-visible { outline: 2px solid #222; outline-offset: 2px; }
    .ts-air-extra-rating { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; }
    .ts-air-extra-subtitle { color: #6a6a6a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ts-air-extra-price { margin-top: 4px; font-weight: 600; }
  `;
  document.head.append(style);
};

const renderListing = (listing: SearchListing): HTMLElement | null => {
  const id = listingId(listing);
  const photo = listing.contextualPictures?.[0];
  if (!id || !photo?.picture) return null;
  const href = listingUrl(id, photo.id);
  const wrapper = document.createElement('div');
  wrapper.className = 'ts-air-extra';
  wrapper.dataset.tsAirId = id;
  const card = document.createElement('article');
  card.setAttribute('data-testid', 'card-container');
  const frame = document.createElement('div');
  frame.className = 'ts-air-extra-photo';
  const imageLink = document.createElement('a');
  imageLink.href = href;
  imageLink.setAttribute('aria-label', `View ${listing.subtitle || listing.title || 'listing'}`);
  const image = document.createElement('div');
  image.setAttribute('data-testid', 'listing-image');
  const img = document.createElement('img');
  img.src = photo.picture;
  img.alt = '';
  img.loading = 'lazy';
  image.append(img);
  imageLink.append(image);
  frame.append(imageLink);

  const info = document.createElement('div');
  info.className = 'ts-air-extra-info';
  const titleRow = document.createElement('div');
  titleRow.className = 'ts-air-extra-title-row';
  const title = document.createElement('a');
  title.href = href;
  title.textContent = listing.title || listing.subtitle || 'Stay';
  title.setAttribute('data-testid', 'listing-card-title');
  const rating = document.createElement('span');
  rating.className = 'ts-air-extra-rating';
  rating.textContent = listing.avgRatingLocalized || '';
  titleRow.append(title, rating);
  const subtitle = document.createElement('div');
  subtitle.className = 'ts-air-extra-subtitle';
  subtitle.textContent = listing.subtitle || '';
  const price = document.createElement('div');
  price.className = 'ts-air-extra-price';
  const priceLine = listing.structuredDisplayPrice?.primaryLine;
  const amount = priceLine?.discountedPrice || priceLine?.price;
  price.textContent = amount
    ? [amount, priceLine?.qualifier].filter(Boolean).join(' ')
    : priceLine?.accessibilityLabel || '';
  info.append(titleRow, subtitle, price);
  card.append(frame, info);
  wrapper.append(card);
  return wrapper;
};

export const extendFirstSearchPage = (): void => {
  const initialUrl = location.href;
  let loadedUrl = '';
  let cards: HTMLElement[] = [];
  let nextCursor: string | undefined;
  let generation = 0;

  // Airbnb's pagination click handler uses its own cursor rather than the
  // anchor href. Navigate our rewritten links directly.
  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    const link = target instanceof Element ? target.closest<HTMLAnchorElement>('a[data-ts-air-original-href]') : null;
    if (!link) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.assign(link.href);
  }, true);

  const removeExtras = () => {
    document.querySelectorAll('.ts-air-extra').forEach((card) => card.remove());
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-ts-air-original-href]')) {
      if (!link.dataset.tsAirOriginalHref) continue;
      link.href = link.dataset.tsAirOriginalHref;
      delete link.dataset.tsAirOriginalHref;
    }
  };

  const useCombinedPageAsPrevious = (url: string) => {
    const cursor = new URL(url).searchParams.get('cursor');
    let offset = 0;
    try { offset = JSON.parse(atob(cursor || '')).items_offset; }
    catch { return; }
    if (offset !== PAGE_SIZE) return;
    const previous = document.querySelector<HTMLAnchorElement>('a[aria-label="Previous page"]');
    if (!previous) return;
    previous.dataset.tsAirOriginalHref ||= previous.href;
    const firstPage = new URL(previous.dataset.tsAirOriginalHref);
    firstPage.searchParams.delete('cursor');
    firstPage.searchParams.delete('pagination_search');
    previous.href = firstPage.href;
  };

  const mount = (grid: Element) => {
    ensureStyles();
    const existing = new Set([...grid.querySelectorAll<HTMLElement>('.ts-air-extra')].map((card) => card.dataset.tsAirId));
    for (const card of cards) if (!existing.has(card.dataset.tsAirId)) grid.append(card);
    const next = document.querySelector<HTMLAnchorElement>('a[aria-label="Next page"]');
    if (next && nextCursor) {
      next.dataset.tsAirOriginalHref ||= next.href;
      const url = new URL(next.dataset.tsAirOriginalHref);
      url.searchParams.set('cursor', nextCursor);
      next.href = url.href;
    }
  };

  const refresh = async () => {
    const url = location.href;
    if (new URL(url).searchParams.has('cursor')) {
      generation++;
      loadedUrl = url;
      cards = [];
      nextCursor = undefined;
      removeExtras();
      useCombinedPageAsPrevious(url);
      return;
    }
    const grid = mainGrid();
    if (!grid) return;
    if (url === loadedUrl) {
      if (cards.length) mount(grid);
      return;
    }
    loadedUrl = url;
    cards = [];
    nextCursor = undefined;
    removeExtras();
    const run = ++generation;
    const data = await loadResults(url, initialUrl).catch(() => null);
    if (run !== generation || url !== location.href || !data) return;
    const existingIds = new Set([...document.querySelectorAll(CARD)].map((card) => card.querySelector('a[href*="/rooms/"]')?.getAttribute('href')?.match(/\/rooms\/(\d+)/)?.[1]));
    cards = data.listings.filter((listing) => !existingIds.has(listingId(listing) || '')).map(renderListing).filter((card): card is HTMLElement => !!card);
    nextCursor = data.nextCursor;
    const currentGrid = mainGrid();
    if (currentGrid) mount(currentGrid);
  };

  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 250); };
  schedule();
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
};
