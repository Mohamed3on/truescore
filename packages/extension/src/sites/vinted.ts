import { cacheGet, cacheSet } from '../shared/cache';
import { orderByCssBand } from '../shared/score-grid';
import { afterHydration } from '../shared/utils';
import type * as z from 'zod/mini';
import { compareKeys, parseListings, postageFromApi, rankKey, SHIPPING, sellerFromApi, USER, type Listing, type Money, type Seller } from '../shared/vinted';

// Vinted sorts by relevance, price or newest. TrueScore adds "Best nearby" to its
// Sort by menu: good sellers first, cheaper postage (nearer) before dearer, more
// good reviews first, likes as the tiebreak (see rankKey). Sellers and postage
// come from Vinted's API as fast as it allows, cards on screen first, so the grid
// settles card by card; a 429 slows the calls, a 403 stops them for the session. Off until
// picked; picking any of Vinted's own sorts turns the order off again, while the
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

let on = localStorage.getItem(STORE_KEY) === '1';

// A link straight to one of Vinted's own sorts wins over the stored choice.
const active = () => on && [null, 'relevance'].includes(new URLSearchParams(location.search).get('order'));

const listings = new Map<string, Listing>();

// Fetched records; null once the API answered with nothing usable.
const sellers = new Map<string, Seller | null>();

// Postage is the same for every item from one country (Vinted quotes the
// cheapest option: free within Germany, €4.85 from Italy, €5.39 from France to
// a Berlin buyer), so one item's answer stands for its whole country. An item
// whose seller is unreadable, or that is pickup-only (null), keeps its own.
const countryPostage = new Map<string, Money | undefined>();
const itemPostage = new Map<string, Money | null | undefined>();
const scannedPages = new Set<string>();
const headers = { accept: 'application/json', 'x-csrf-token': '', 'x-anon-id': '' };
let blocked = false;
let slow = false;
const inflight = new Set<string>();
let workers = 0;
let nextStart = 0;

const scan = (html: string) => {
  for (const [item, listing] of parseListings(html)) listings.set(item, listing);
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
const sellerOf = (card: Element) => listings.get(itemOf(card))?.seller ?? '';

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

// The buyer's country, from the storefront's domain.
const tld = location.hostname.replace(/^www\.vinted\./, '');
const BUYER = tld === 'co.uk' ? 'GB' : tld === 'com' ? 'US' : tld.toUpperCase();

// Vinted's locale, read before Chrome Translate rewrites the page's lang, so
// our figures match the host's ("84,30 €" on vinted.de) and translate with it.
const LANG = new Intl.Locale(document.documentElement.lang || 'en').language;
const LOCALE = `${LANG}-${BUYER}`;
const money = (m: Money) => new Intl.NumberFormat(LOCALE, { style: 'currency', currency: m.currency }).format(m.amount);
const countryName = (code: string) => new Intl.DisplayNames([LANG], { type: 'region' }).of(code) ?? code;
const flag = (country: string) => String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

const VINTED_TEAL = 'rgb(0, 119, 130)';
const VINTED_GREY = 'rgb(90, 101, 102)';

// Host-native: Vinted's own text classes for the figures, and a hover card in
// the Goodreads recipe (white, hairline ring, soft shadow, 160 ms settle).
const style = document.createElement('style');

style.textContent = `
  .ts-vt { position: relative; display: inline-flex; align-items: baseline; gap: 4px; cursor: default; font-variant-numeric: tabular-nums; outline: none; }
  .ts-vt-note { text-decoration: underline dotted rgba(90, 101, 102, .5); text-underline-offset: 3px; }
  .ts-vt-card {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 20;
    display: grid; grid-template-columns: auto auto; column-gap: 16px; row-gap: 2px;
    width: max-content; padding: 10px 12px; background: #fff; border-radius: 8px;
    box-shadow: 0 0 0 1px rgba(17, 17, 17, .08), 0 8px 24px rgba(17, 17, 17, .12);
    font-size: 12px; line-height: 16px; color: ${VINTED_GREY}; font-variant-numeric: tabular-nums;
    opacity: 0; transform: translateY(-4px) scale(.97); transform-origin: top left; pointer-events: none;
    transition: opacity 100ms ease-out, transform 100ms ease-out;
  }
  .ts-vt:hover .ts-vt-card, .ts-vt:focus-visible .ts-vt-card {
    opacity: 1; transform: none;
    transition: opacity 160ms cubic-bezier(.23, 1, .32, 1) 80ms, transform 160ms cubic-bezier(.23, 1, .32, 1) 80ms;
  }
  .ts-vt:focus-visible .ts-vt-note { outline: 2px solid ${VINTED_TEAL}; outline-offset: 2px; border-radius: 2px; }
  .ts-vt-card > .-v { text-align: right; }
  .ts-vt-card > .-rule { grid-column: 1 / -1; height: 1px; margin: 4px 0 2px; background: rgba(17, 17, 17, .08); }
  .ts-vt-card > .-sum { color: #111; font-weight: 500; }
  .ts-vt-card > .-foot { grid-column: 1 / -1; margin-top: 6px; max-width: 220px; text-align: left; }
  .ts-vinted-seller { margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .ts-vinted-seller.-pending { opacity: .6; }
  .ts-vinted-status { margin: 0 0 12px; color: ${VINTED_GREY}; font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) { .ts-vt-card { transform: none !important; } }
`;


const el = (tag: string, className: string, text = '') => {
  const node = document.createElement(tag);

  node.className = className;
  node.textContent = text;

  return node;
};

// One total with postage, replacing Vinted's item + fee total; hovering it
// breaks the figure down. Null while the postage isn't known: Vinted's own
// total stays.
const totalFor = (card: Element): HTMLElement | null => {
  const listing = listings.get(itemOf(card));
  const postage = postageOf(card);
  const seller = sellers.get(sellerOf(card));

  if (!listing?.total || !postage || postage.currency !== listing.total.currency) return null;
  const sum = { amount: Math.round((listing.total.amount + postage.amount) * 100) / 100, currency: postage.currency };
  const node = el('span', 'ts-vt');

  node.tabIndex = 0;
  node.append(
    el('span', 'web_ui__Text__text web_ui__Text__subtitle web_ui__Text__left web_ui__Text__primary', money(sum)),
    el('span', 'ts-vt-note web_ui__Text__text web_ui__Text__caption web_ui__Text__left web_ui__Text__primary', postage.amount ? 'incl. postage' : 'incl. free postage'),
  );
  const card_ = el('span', 'ts-vt-card');
  const fee = listing.fee ?? { amount: 0, currency: sum.currency };
  const from = seller ? ` from ${countryName(seller.country)}` : '';

  card_.append(
    el('span', '', 'Item'),
    el('span', '-v', money({ amount: Math.round((listing.total.amount - fee.amount) * 100) / 100, currency: sum.currency })),
    el('span', '', 'Buyer protection'),
    el('span', '-v', money(fee)),
    el('span', '', `Postage${from}`),
    el('span', '-v', postage.amount ? money(postage) : 'free'),
    el('span', '-rule'),
    el('span', '-sum', 'Total'),
    el('span', '-sum -v', money(sum)),
    el('span', '-foot', 'Cheapest postage option to your address. Vinted adds it at checkout.'),
  );
  node.append(card_);

  return node;
};

const sellerLine = (card: Element) => {
  const id = sellerOf(card);
  const seller = sellers.get(id);
  const postage = postageOf(card);

  if (!id || seller === null) return { text: '', pending: false };

  if (!seller) return { text: blocked ? '' : 'Checking seller…', pending: true };
  const record = seller.total ? `${seller.total} review${seller.total === 1 ? '' : 's'} · ${(seller.rating * 5).toFixed(1)}★` : 'no reviews yet';
  const pickup = postage === null ? ' · pickup only' : '';

  return { text: `${flag(seller.country)} ${record}${pickup}`, pending: false };
};

const renderCard = (card: Element) => {
  const breakdown = card.querySelector<HTMLElement>('[data-testid$="--breakdown"]');

  if (!breakdown) return;
  const key = `${itemOf(card)}|${JSON.stringify(postageOf(card))}|${sellers.get(sellerOf(card))?.country ?? ''}`;
  let total = card.querySelector<HTMLElement>('.ts-vt');

  if (total?.dataset.key !== key) {
    total?.remove();
    total = totalFor(card);

    if (total) {
      total.dataset.key = key;
      breakdown.after(total);
    }
  }

  // Ours replaces Vinted's item + fee total; theirs returns when ours can't be built.
  breakdown.style.display = total ? 'none' : '';

  const { text, pending } = sellerLine(card);
  let line = card.querySelector<HTMLElement>('.ts-vinted-seller');

  if (!text) return line?.remove();

  if (!line) {
    line = el('div', 'ts-vinted-seller web_ui__Text__text web_ui__Text__caption web_ui__Text__left');
    (total ?? breakdown).after(line);
  }

  if (line.previousElementSibling !== (total ?? breakdown)) (total ?? breakdown).after(line);

  if (line.textContent !== text) line.textContent = text;
  line.classList.toggle('-pending', pending);
};

// One line above the grid saying what TrueScore is still doing, under every sort.
const status = el('div', 'ts-vinted-status web_ui__Text__text web_ui__Text__caption web_ui__Text__left');

const showStatus = (cards: Element[], waiting: number) => {
  const grid = cards[0]?.parentElement;
  const done = cards.length - waiting;

  const text = blocked && waiting
    ? 'TrueScore: Vinted paused postage and seller lookups for this browser. Totals show without postage until it lifts, usually within the hour.'
    : !waiting
      ? ''
      : slow && nextStart > Date.now()
        ? `TrueScore: Vinted asked us to slow down. Adding postage and seller reviews resumes in a few seconds · ${done} of ${cards.length}`
        : `TrueScore: adding postage and seller reviews${slow ? ' (slowly, at Vinted\'s limit)' : ''} · ${done} of ${cards.length}`;

  if (!text || !grid) return status.remove();

  if (status.nextElementSibling !== grid) grid.before(status);

  if (status.textContent !== text) status.textContent = text;
};

// --- ranking -----------------------------------------------------------------

const resort = () => {
  for (const container of new Set([...document.querySelectorAll(CARD)].map((card) => card.parentElement!))) {
    const cards = [...container.children].filter((child) => child.matches(CARD));

    if (!active()) {
      orderByCssBand(container, [], cards);
      continue;
    }

    // DOM order is Vinted's order: the ranking never moves nodes.
    const keyed = cards.map((card, place) => ({ card, key: rankKey(sellers.get(sellerOf(card)), postageOf(card), likes(card), place) }));

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
    renderCard(card);
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

  // Totals and seller lines show under any sort; only the order is Best nearby's alone.
  const waiting = cards.filter((card) => taskFor(card)).length;

  if (!blocked) for (let i = workers; i < (slow ? 1 : FAST_CONCURRENCY) && waiting; i++) void work();
  showStatus(cards, waiting);
  showInTrigger(active() ? 'Best nearby' : null);

  resort();
};

let timer: ReturnType<typeof setTimeout>;

// Touch the cards only once React has hydrated them (see afterHydration).
void afterHydration().then(() => {
  document.head.append(style);
  sync();
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(sync, 200);
  }).observe(document.body, { childList: true, subtree: true });
});
