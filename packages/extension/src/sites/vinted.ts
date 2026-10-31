import { cacheGet, cacheGetMaybe, cacheSet, cacheSetMaybe } from '../shared/cache';
import { orderByCssBand } from '../shared/score-grid';
import type * as z from 'zod/mini';
import { compareKeys, parseItemSellers, postageFromApi, rankKey, SHIPPING, sellerFromApi, USER, type Postage, type Seller } from '../shared/vinted';

// Vinted sorts by relevance, price or newest. TrueScore adds "Best nearby" to its
// Sort by menu: good sellers first, cheaper postage (nearer) before dearer, more
// good reviews first, likes as the tiebreak (see rankKey). Sellers and postage
// come from Vinted's API one call at a time, cards on screen first, so the grid
// settles card by card; a 403/429 stops the calls for the session. On by
// default; picking any of Vinted's own sorts turns it off. CSS order only
// (orderByCssBand): the React grid is never moved.

const CARD = '[data-testid="grid-item"]';
const TRIGGER_TEXT = '[data-testid="catalog--sort-filter--trigger--text"]';
const OPTION_ID = 'sort_by-list-item-truescore';
const STORE_KEY = 'truescore-vinted-best-nearby';
const SELLER_TTL = 7 * 24 * 60 * 60 * 1000;
const POSTAGE_TTL = 24 * 60 * 60 * 1000;

// Gap between API calls: a burst of 24 got this browser blocked for most of an hour.
const CALL_GAP_MS = 300;

let on = localStorage.getItem(STORE_KEY) !== '0';

// A link straight to one of Vinted's own sorts wins over the stored choice.
const active = () => on && [null, 'relevance'].includes(new URLSearchParams(location.search).get('order'));

const itemSeller = new Map<string, string>();

// Fetched records; null once the API answered with nothing usable.
const sellers = new Map<string, Seller | null>();

// Postage: null for a pickup-only item, undefined when the API gave nothing usable.
const postages = new Map<string, Postage | null | undefined>();
const scannedPages = new Set<string>();
const headers = { accept: 'application/json', 'x-csrf-token': '', 'x-anon-id': '' };
let blocked = false;
let fetching = false;

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
const likes = (card: Element) => parseInt(card.querySelector('[data-testid="favourite-count-text"]')?.textContent || '', 10) || 0;

const api = async <S extends z.ZodMiniType>(path: string, schema: S): Promise<z.infer<S> | undefined> => {
  try {
    const res = await fetch(path, { headers });

    if (res.status === 403 || res.status === 429) blocked = true;

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
  const text = describe(sellers.get(sellerOf(card)), postages.get(itemOf(card)));
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

    const keyed = cards.map((card) => ({ card, key: rankKey(sellers.get(sellerOf(card)), postages.get(itemOf(card)), likes(card)) }));

    // Array sort is stable, so equal keys keep Vinted's order.
    orderByCssBand(container, keyed.sort((a, b) => compareKeys(a.key, b.key)).map((k) => k.card));
  }
};

// --- fetching, cards on screen first -------------------------------------------

const fromCache = (card: Element) => {
  const seller = sellerOf(card);
  const item = itemOf(card);

  if (seller && !sellers.has(seller)) {
    const cached = cacheGet(`truescore-vinted-seller-${seller}`, SELLER_TTL);

    if (cached) sellers.set(seller, cached);
  }

  if (item && !postages.has(item)) {
    const cached = cacheGetMaybe(`truescore-vinted-postage-${item}`, POSTAGE_TTL);

    if (cached) postages.set(item, cached.value);
  }
};

const missing = (card: Element) => (!!sellerOf(card) && !sellers.has(sellerOf(card))) || (!!itemOf(card) && !postages.has(itemOf(card)));

const nextCard = () => {
  const distance = (card: Element) => {
    const r = card.getBoundingClientRect();

    return r.bottom < 0 ? Infinity : Math.max(r.top, 0);
  };

  return [...document.querySelectorAll(CARD)]
    .flatMap((card) => (missing(card) ? [{ card, d: distance(card) }] : []))
    .sort((a, b) => a.d - b.d)[0]?.card;
};

const work = async () => {
  fetching = true;

  for (let card = nextCard(); card && active() && !blocked; card = nextCard()) {
    const seller = sellerOf(card);
    const item = itemOf(card);

    if (seller && !sellers.has(seller)) {
      const json = await api(`/api/v2/users/${seller}`, USER);
      const record = json ? sellerFromApi(json) : null;

      sellers.set(seller, record);

      if (record) cacheSet(`truescore-vinted-seller-${seller}`, record);
    } else {
      const json = await api(`/api/v2/items/${item}/shipping_details`, SHIPPING);
      const postage = json ? postageFromApi(json) : undefined;

      postages.set(item, postage);

      if (postage !== undefined) cacheSetMaybe(`truescore-vinted-postage-${item}`, postage);
    }

    sync();
    await new Promise((r) => setTimeout(r, CALL_GAP_MS));
  }

  fetching = false;
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
  if (unmapped && active() && !scannedPages.has(location.href)) {
    scannedPages.add(location.href);
    fetch(location.href)
      .then((res) => res.text())
      .then(scan)
      .catch(() => {})
      .finally(sync);
  }

  if (active()) {
    const waiting = blocked ? 0 : cards.filter(missing).length;

    showInTrigger(waiting ? `Best nearby · ${cards.length - waiting}/${cards.length}` : 'Best nearby');

    if (waiting && !fetching) void work();
  } else showInTrigger(null);

  resort();
};

sync();

let timer: ReturnType<typeof setTimeout>;

new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(sync, 200);
}).observe(document.body, { childList: true, subtree: true });
