import { cacheGet, cacheSet } from '../shared/cache';
import { orderByCssBand } from '../shared/score-grid';
import type * as z from 'zod/mini';
import { compareKeys, parseItemSellers, postageFromApi, rankKey, SHIPPING, sellerFromApi, USER, type Postage, type Seller } from '../shared/vinted';

// Vinted sorts by relevance, price or newest. TrueScore adds "Best nearby" to its
// Sort by menu: good sellers first, cheaper postage (nearer) before dearer, more
// good reviews first, likes as the tiebreak (see rankKey). Sellers and postage
// come from Vinted's API as fast as it allows, cards on screen first, so the grid
// settles card by card; a 429 slows the calls, a 403 stops them for the session. On by
// default; picking any of Vinted's own sorts turns the order off, while the
// card labels (country, postage, reviews) stay under every sort. CSS order only
// (orderByCssBand): the React grid is never moved.

const CARD = '[data-testid="grid-item"]';
const TRIGGER_TEXT = '[data-testid="catalog--sort-filter--trigger--text"]';
const OPTION_ID = 'sort_by-list-item-truescore';
const STORE_KEY = 'truescore-vinted-best-nearby';
const SELLER_TTL = 7 * 24 * 60 * 60 * 1000;
const POSTAGE_TTL = 24 * 60 * 60 * 1000;

// As fast as Vinted allows: 4 calls in flight until its first 429, then a
// 10 s pause and one call at a time, 300 ms apart (which ran 50+ calls clean
// in a headless browser that drew 429s at 3 in flight). A 403 is a block for
// this browser (most of an hour; pages still load): stop for the session.
const FAST_CONCURRENCY = 4;
const SLOW_GAP_MS = 300;
const RATE_LIMIT_PAUSE_MS = 10_000;

let on = localStorage.getItem(STORE_KEY) !== '0';

// A link straight to one of Vinted's own sorts wins over the stored choice.
const active = () => on && [null, 'relevance'].includes(new URLSearchParams(location.search).get('order'));

const itemSeller = new Map<string, string>();

// Fetched records; null once the API answered with nothing usable.
const sellers = new Map<string, Seller | null>();

// Postage is the same for every item from one country (Vinted quotes the
// cheapest option: free within Germany, €4.85 from Italy, €5.39 from France to
// a Berlin buyer), so one item's answer stands for its whole country. An item
// whose seller is unreadable, or that is pickup-only (null), keeps its own.
const countryPostage = new Map<string, Postage | undefined>();
const itemPostage = new Map<string, Postage | null | undefined>();
const scannedPages = new Set<string>();
const headers = { accept: 'application/json', 'x-csrf-token': '', 'x-anon-id': '' };
let blocked = false;
let slow = false;
const inflight = new Set<string>();
let workers = 0;
let nextStart = 0;

const scan = (html: string) => {
  for (const [item, seller] of parseItemSellers(html)) itemSeller.set(item, seller);
};

for (const script of document.scripts) {
  const text = script.textContent ?? '';

  if (text.includes('"productItem')) scan(text);
  const csrf = text.match(/CSRF_TOKEN\\?":\\?"([\w-]+)/)?.[1];
  const anon = text.match(/anonId\\?":\\?"([\w-]+)/)?.[1];

  if (csrf) headers['x-csrf-token'] = csrf;

  if (anon) headers['x-anon-id'] = anon;
}

const itemOf = (card: Element) => card.querySelector('[data-testid^="product-item-id-"]')?.getAttribute('data-testid')?.match(/^product-item-id-(\d+)/)?.[1] ?? '';
const sellerOf = (card: Element) => itemSeller.get(itemOf(card)) ?? '';

const postageOf = (card: Element) => {
  const item = itemOf(card);

  if (itemPostage.has(item)) return itemPostage.get(item);
  const country = sellers.get(sellerOf(card))?.country;

  return country ? countryPostage.get(country) : undefined;
};

const likes = (card: Element) => parseInt(card.querySelector('[data-testid="favourite-count-text"]')?.textContent || '', 10) || 0;

// Rate-limited: leave the data unset so the call comes round again.
const RETRY = Symbol('retry');

const api = async <S extends z.ZodMiniType>(path: string, schema: S): Promise<z.infer<S> | undefined | typeof RETRY> => {
  try {
    const res = await fetch(path, { headers });

    if (res.status === 403) blocked = true;

    if (res.status === 429) {
      slow = true;
      nextStart = Date.now() + RATE_LIMIT_PAUSE_MS;

      return RETRY;
    }

    if (!res.ok) return undefined;
    const read = schema.safeParse(await res.json());

    return read.success ? read.data : undefined;
  } catch {
    return undefined;
  }
};

// --- card labels -------------------------------------------------------------

const flag = (country: string) => String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

// The browser's locale: Chrome Translate rewrites the page's lang.
const money = (p: Postage) => new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency }).format(p.amount);

const describe = (seller: Seller | null | undefined, postage: Postage | null | undefined) => {
  const parts: string[] = [];

  if (postage) parts.push(postage.amount ? `${money(postage)} postage` : 'free postage');
  else if (postage === null) parts.push('pickup only');

  if (seller) parts.push(seller.total ? `${seller.total} review${seller.total === 1 ? '' : 's'} · ${(seller.rating * 5).toFixed(1)}★` : 'no reviews');
  const text = parts.join(' · ');

  return seller ? `${flag(seller.country)} ${text}` : text;
};

// One line under the card's price: the seller's country, postage and record.
const labelCard = (card: Element) => {
  const text = describe(sellers.get(sellerOf(card)), postageOf(card));
  let line = card.querySelector<HTMLElement>('.ts-vinted-seller');

  if (!text) return line?.remove();

  if (!line) {
    line = document.createElement('div');
    line.className = 'ts-vinted-seller web_ui__Text__text web_ui__Text__caption web_ui__Text__left';
    line.style.cssText = 'margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    card.querySelector('[data-testid$="--breakdown"]')?.after(line);
  }

  if (line.textContent !== text) line.textContent = text;
};

// --- ranking -----------------------------------------------------------------

const resort = () => {
  for (const container of new Set([...document.querySelectorAll(CARD)].map((card) => card.parentElement!))) {
    const cards = [...container.children].filter((child) => child.matches(CARD));

    if (!active()) {
      orderByCssBand(container, [], cards);
      continue;
    }

    const keyed = cards.map((card) => ({ card, key: rankKey(sellers.get(sellerOf(card)), postageOf(card), likes(card)) }));

    // Array sort is stable, so equal keys keep Vinted's order.
    orderByCssBand(container, keyed.sort((a, b) => compareKeys(a.key, b.key)).map((k) => k.card));
  }
};

// --- fetching, cards on screen first -------------------------------------------

const fromCache = (card: Element) => {
  const id = sellerOf(card);

  if (id && !sellers.has(id)) {
    const cached = cacheGet(`truescore-vinted-seller-${id}`, SELLER_TTL);

    if (cached) sellers.set(id, cached);
  }

  const country = sellers.get(id)?.country;

  if (country && !countryPostage.has(country)) {
    const cached = cacheGet(`truescore-vinted-postage-${country}`, POSTAGE_TTL);

    if (cached) countryPostage.set(country, cached);
  }
};

const fetchSeller = async (id: string) => {
  const json = await api(`/api/v2/users/${id}`, USER);

  if (json === RETRY) return;
  const record = json ? sellerFromApi(json) : null;

  sellers.set(id, record);

  if (record) cacheSet(`truescore-vinted-seller-${id}`, record);
};

const fetchPostage = async (item: string, country: string | undefined) => {
  const json = await api(`/api/v2/items/${item}/shipping_details`, SHIPPING);

  if (json === RETRY) return;
  const postage = json ? postageFromApi(json) : undefined;

  if (country && postage) {
    countryPostage.set(country, postage);
    cacheSet(`truescore-vinted-postage-${country}`, postage);
  } else itemPostage.set(item, postage);
};

// The call a card still needs, keyed so two cards never fetch the same thing.
const taskFor = (card: Element): { key: string; run: () => Promise<void> } | null => {
  const id = sellerOf(card);
  const item = itemOf(card);

  if (!id || !item) return null;

  if (!sellers.has(id)) return { key: `u${id}`, run: () => fetchSeller(id) };
  const country = sellers.get(id)?.country;

  if (itemPostage.has(item) || (country && countryPostage.has(country))) return null;

  return { key: country ? `c${country}` : `i${item}`, run: () => fetchPostage(item, country) };
};

// Cards on screen first, then down the page.
const nextTask = () => {
  const distance = (card: Element) => {
    const r = card.getBoundingClientRect();

    return r.bottom < 0 ? Infinity : Math.max(r.top, 0);
  };

  for (const { card } of [...document.querySelectorAll(CARD)].map((c) => ({ card: c, d: distance(c) })).sort((a, b) => a.d - b.d)) {
    const task = taskFor(card);

    if (task && !inflight.has(task.key)) return task;
  }

  return null;
};

const work = async () => {
  workers++;

  // Once slowed, workers retire until one is left.
  for (let task = nextTask(); task && !blocked && (!slow || workers === 1); task = nextTask()) {
    inflight.add(task.key);
    const wait = nextStart - Date.now();

    nextStart = Math.max(Date.now(), nextStart) + (slow ? SLOW_GAP_MS : 0);

    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await task.run();
    inflight.delete(task.key);
    sync();
  }

  workers--;
};

// --- the Sort by option ----------------------------------------------------------

let triggerText: string | null = null;

const showInTrigger = (text: string | null) => {
  const el = document.querySelector(TRIGGER_TEXT);

  if (!el) return;

  if (text == null) {
    if (triggerText != null && el.textContent !== triggerText) el.textContent = triggerText;
    triggerText = null;

    return;
  }

  triggerText ??= el.textContent;

  if (el.textContent !== text) el.textContent = text;
};

const choose = (value: boolean) => {
  on = value;
  localStorage.setItem(STORE_KEY, value ? '1' : '0');

  if (!value) return sync();
  document.querySelector<HTMLElement>('[data-testid="catalog--sort-filter--trigger"]')?.click();
  const url = new URL(location.href);

  // Rank Vinted's relevance results, not a price or date order.
  if (!active()) {
    url.searchParams.set('order', 'relevance');
    location.assign(url);
  } else sync();
};

// Picking one of Vinted's own sorts hands the grid back to it.
document.addEventListener(
  'click',
  (e) => {
    const row = e.target instanceof Element ? e.target.closest('[id^="sort_by-list-item-"]') : null;

    if (row && row.id !== OPTION_ID) choose(false);
  },
  true,
);

// Vinted renders its menu on open: add a row cloned from its first one.
const addOption = () => {
  const list = document.querySelector('[data-testid="sort-by-dropdown"] ul');

  if (!list) return;
  let option = list.querySelector(`#${OPTION_ID}`);

  if (!option) {
    const li = list.firstElementChild?.cloneNode(true);

    if (!(li instanceof HTMLElement)) return;

    option = li.querySelector('[id^="sort_by-list-item-"]')!;
    option.id = OPTION_ID;
    li.querySelector('.web_ui__Text__text')!.textContent = 'Best nearby';
    li.querySelectorAll('[data-testid]').forEach((el) => el.removeAttribute('data-testid'));
    const input = li.querySelector('input')!;

    input.value = 'truescore';
    // Cloned from the selected row: unchecked while detached, so Vinted's keeps its check.
    input.removeAttribute('checked');
    input.checked = false;
    option.addEventListener('click', () => choose(true));
    list.append(li);
  }

  // Sharing Vinted's radio name, checking ours unchecks theirs.
  const radio = option.querySelector('input')!;

  if (active() && !radio.checked) radio.checked = true;
};

// --- the loop --------------------------------------------------------------------

const sync = () => {
  // Catalog and search results only: the home feed and closets keep Vinted's order and stay label-free.
  if (!location.pathname.startsWith('/catalog')) return;
  addOption();
  const cards = [...document.querySelectorAll(CARD)];

  if (!cards.length) return;
  let unmapped = false;

  for (const card of cards) {
    if (!sellerOf(card)) unmapped = true;
    fromCache(card);
    labelCard(card);
  }

  // Client-side navigation brings cards the first page load never named:
  // read their sellers off the current page's HTML, once per URL.
  if (unmapped && !scannedPages.has(location.href)) {
    scannedPages.add(location.href);
    fetch(location.href)
      .then((res) => res.text())
      .then(scan)
      .catch(() => {})
      .finally(sync);
  }

  // Labels show under any sort; only the order is Best nearby's alone.
  const waiting = blocked ? 0 : cards.filter((card) => taskFor(card)).length;

  for (let i = workers; i < (slow ? 1 : FAST_CONCURRENCY) && waiting; i++) void work();

  if (active()) showInTrigger(waiting ? `Best nearby · ${cards.length - waiting}/${cards.length}` : 'Best nearby');
  else showInTrigger(null);

  resort();
};

sync();

let timer: ReturnType<typeof setTimeout>;

new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(sync, 200);
}).observe(document.body, { childList: true, subtree: true });
