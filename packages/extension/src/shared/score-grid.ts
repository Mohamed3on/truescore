import { addCommas, npsColor } from './utils';

// The shared PLP behaviour the product-grid scrapers used to each hand-roll:
// badge every card with its net score, then re-rank each grid container by
// `data-nps` (scored desc, unscored last), progressively as scores arrive.
// Ranking is CSS-order-only by default so re-rendering hosts never fight it.
// The module owns the loop, the rAF coalescing, and the debounced
// MutationObserver; each site injects only what genuinely varies.

export interface ScoreData {
  score: number;
  nps: number;
  total?: number;
}

// The compact "score (nps%)" chip placed beside a host rating on a product card.
// Shared by the score grids and by island sites that annotate cards.
export const renderScoreBadge = ({ score, nps, total }: ScoreData): HTMLElement => {
  const badge = document.createElement('span');
  badge.className = 'nps-score-badge';
  badge.style.cssText = `color:${npsColor(nps)};font-weight:600;font-size:12px;margin-left:6px;white-space:nowrap;`;
  badge.textContent = `${addCommas(score)} (${Math.round(nps)}%)`;
  if (total != null) badge.title = `${addCommas(total)} item reviews`;
  return badge;
};

// --- container discovery strategies ---------------------------------------

// The default. Find each card's row by structure — the nearest ancestor holding
// two or more cards — for the surfaces (search, category, carousel) where a grid
// nests its cards differently and no single selector names the row.
export const structuralContainers =
  (cardSelector: string) =>
  (cards: Element[]): Set<Element> => {
    const isBearer = (child: Element) => child.matches(cardSelector) || !!child.querySelector(cardSelector);
    const containerOf = (card: Element): Element | null => {
      let el: Element = card;
      while (el.parentElement) {
        const parent = el.parentElement;
        const children = [...parent.children];
        const bearers = children.filter(isBearer).length;
        if (bearers >= 2) {
          // A page-level ancestor can also reach 2 — via unrelated sections that
          // each hold a card somewhere. A real row's children are mostly bearers;
          // reject rather than rank (and reshuffle) whole page sections. A lone
          // card then simply stays unranked. Empty children — lazy-load
          // placeholders holding the places of cards not yet rendered (AliExpress
          // ships 48 behind its first 12) — are neither card nor content, so
          // they weigh on neither side.
          const content = children.filter((child) => child.childElementCount || child.textContent!.trim()).length;
          return bearers * 2 >= content ? parent : null;
        }
        el = parent;
      }
      return null;
    };
    const containers = new Set<Element>();
    for (const card of cards) {
      const container = containerOf(card);
      if (container) containers.add(container);
    }
    return containers;
  };

// Fixed-grid sites: the container(s) are named directly by a selector.
export const containersBySelector =
  (selector: string) =>
  (): Iterable<Element> =>
    document.querySelectorAll(selector);

// --- sort application strategies ------------------------------------------

// Opt-in only, never the default: reorder by moving nodes. Works on any
// container display, but moving a framework-managed child turns every
// reconciliation into a restore-order fight — eaten clicks, re-shuffle loops
// (the Uniqlo/IKEA bug). Reserve for grids verified to be host-static.
// No-ops when the order already matches, so a settled grid stops feeding
// childList records to observers.
export const orderByAppend = (container: Element, scored: Element[], rest: Element[], sunk: Element[] = []): void => {
  const desired = [...scored, ...rest, ...sunk];
  if (desired.every((child, i) => container.children[i] === child)) return;
  for (const child of desired) container.appendChild(child);
};

// For flex/grid rows whose children the host pins with `order` utility classes:
// win them with an `!important` order. Style-only — the tab-order drift from
// not moving nodes is the price of never fighting a host re-render.
export const orderByCssImportant = (_container: Element, scored: Element[], rest: Element[], sunk: Element[] = []): void => {
  [...scored, ...rest, ...sunk].forEach((child, i) => {
    (child as HTMLElement).style.setProperty('order', String(i), 'important');
  });
};

// The default. Touch no nodes: a negative `order` band floats the scored cards
// above everything still at the default 0, a positive one sinks the hated below
// it. Grid/flex layout honours it, the host framework never inspects it, and a
// resort makes zero childList mutations — so re-rendering hosts (React/Vue grids,
// lazy-load placeholder rows) have nothing to fight and observers nothing to
// re-fire on. A child that drops back out of the ranking (its card recycled for
// an unscored product) returns to the default — only one this band ordered,
// never an order the host set itself.
const banded = new WeakSet<Element>();
export const orderByCssBand = (_container: Element, scored: Element[], rest: Element[] = [], sunk: Element[] = []): void => {
  scored.forEach((child, i) => {
    (child as HTMLElement).style.order = String(i - scored.length);
    banded.add(child);
  });
  sunk.forEach((child, i) => {
    (child as HTMLElement).style.order = String(i + 1);
    banded.add(child);
  });
  for (const child of rest) if (banded.delete(child)) (child as HTMLElement).style.order = '';
};

// The module owns `data-nps`, so a container's scored child is whichever element
// under it carries the attribute — the card itself or a descendant.
const bearer = (child: Element): Element | null =>
  child.matches('[data-nps]') ? child : child.querySelector('[data-nps]');

// Partition a container's direct children into three bands: the scored ones
// worth floating (`data-nps` ≥ 0, descending), the unscored rest in original
// order, and the sunk — cards scored below 0, known hated, which belong under
// anything still unknown rather than above it. This is the ranking the grid
// applies each frame — exposed so the selection can be tested without a live grid.
export const rankChildren = (container: Element): { scored: Element[]; rest: Element[]; sunk: Element[] } => {
  const ranked: { child: Element; score: number }[] = [];
  const rest: Element[] = [];
  for (const child of [...container.children]) {
    const nps = bearer(child)?.getAttribute('data-nps');
    if (nps != null) ranked.push({ child, score: parseFloat(nps) });
    else rest.push(child);
  }
  ranked.sort((a, b) => b.score - a.score);
  return {
    scored: ranked.filter((r) => r.score >= 0).map((r) => r.child),
    rest,
    sunk: ranked.filter((r) => r.score < 0).map((r) => r.child),
  };
};

// Walking a ranking top-down, tint each badge whose ratio clearly beats every one
// above it — the picks that trade some volume for a better hit rate. Ratios are
// compared as displayed (`data-nps-ratio`, whole percent), where a one-point edge
// can be rounding alone, so it takes two. A card scoring (`data-nps`) under the
// floor is too thin for its ratio to mean much — one 5★ review reads as 100%.
// Returns the tinted badges.
const BEST_RATIO_MARGIN = 2;
const BEST_RATIO_MIN_SCORE = 20;
const BEST_RATIO_TINT = 'rgba(74, 222, 128, 0.2)';
export const markBestRatios = (badges: (Element | null)[]): HTMLElement[] => {
  const picks: HTMLElement[] = [];
  let best = -Infinity;
  for (const badge of badges) {
    if (!(badge instanceof HTMLElement)) continue;
    const ratio = Number(badge.dataset.npsRatio);
    const on = ratio >= best + BEST_RATIO_MARGIN && Number(badge.dataset.nps) >= BEST_RATIO_MIN_SCORE;
    if (ratio > best) best = ratio;
    if (on) picks.push(badge);
    badge.style.background = on ? BEST_RATIO_TINT : '';
    badge.style.boxShadow = on ? `0 0 0 3px ${BEST_RATIO_TINT}` : '';
    badge.style.borderRadius = on ? '3px' : '';
  }
  return picks;
};

// ] / [ step through the picks' cards in reading order, the way the YouTube
// thumbnail bar cycles its ranked videos: smooth-scroll the card to center and
// ring it, clamped at both ends. `picks` hands over the cards as of the last
// ranking rather than re-querying badges, since Amazon empties far-off result
// cards (badge and all) while the card itself stays put. Order is read off the
// layout, since CSS `order` ranking leaves the DOM order stale.
export const cycleBestRatios = (picks: () => (Element | null)[]): void => {
  let current: HTMLElement | null = null;
  document.addEventListener('keydown', (e) => {
    if ((e.key !== ']' && e.key !== '[') || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const at = (el: Element) => el.getBoundingClientRect();
    const cards = picks()
      .filter((card): card is HTMLElement => card instanceof HTMLElement && card.isConnected)
      .sort((a, b) => at(a).top - at(b).top || at(a).left - at(b).left);
    if (!cards.length) return;
    e.preventDefault();
    const i = current ? cards.indexOf(current) : -1;
    const next = cards[e.key === ']' ? Math.min(i + 1, cards.length - 1) : Math.max(i - 1, 0)];
    // Outside the card: an inset ring loses to cards whose image paints over it.
    current?.style.removeProperty('outline');
    next.style.outline = '3px solid rgb(74, 222, 128)';
    next.scrollIntoView({ behavior: 'smooth', block: 'center' });
    current = next;
  });
};

// --- the grid ranker -------------------------------------------------------

export interface ScoreGridOpts {
  cardSelector: string;
  // Resolve a card's id and fetch its score. Throttling stays per-site.
  scoreForCard: (card: Element) => Promise<ScoreData | null>;
  // The product a card shows. When it changes — a host recycling the card
  // element for another product — the card drops its badge and is rescored.
  // Without it a card is scored once for good.
  idOf?: (card: Element) => string | null | undefined;
  // Place the badge relative to the card's own rating.
  placeBadge: (card: Element, badge: HTMLElement) => void;
  // Container discovery. Defaults to `structuralContainers(cardSelector)`.
  discover?: (cards: Element[]) => Iterable<Element>;
  // Sort application. Defaults to `orderByCssBand` — the only strategy safe on
  // hosts that re-render or recreate card wrappers, because its resort makes no
  // childList mutations (the persisted-badge path below re-sorts on every
  // wrapper recreation, which would feed a node-moving strategy into a
  // re-render↔re-sort loop).
  applyOrder?: (container: Element, scored: Element[], rest: Element[], sunk: Element[]) => void;
}

// A null score or a failed fetch is retried a few times, backing off (2s, 8s,
// 32s). Fetchers cache their definitive misses (a reviewless product), so only
// transient ones — a 429, a missing CSRF token, a dropped connection — pay for
// another request.
const RETRIES = 3;
const RETRY_BASE_MS = 2000;

export const setupScoreGrid = ({
  cardSelector,
  scoreForCard,
  idOf,
  placeBadge,
  discover,
  applyOrder = orderByCssBand,
}: ScoreGridOpts): void => {
  const discoverContainers = discover ?? structuralContainers(cardSelector);
  const identity = (card: Element) => idOf?.(card) ?? '';

  let picks: (Element | null)[] = [];
  const resort = () => {
    const cards = [...document.querySelectorAll(cardSelector)];
    const containers = new Set(discoverContainers(cards));
    picks = [];
    for (const container of containers) {
      const { scored, rest, sunk } = rankChildren(container);
      if (scored.length + sunk.length < 2) continue; // nothing to rank against
      applyOrder(container, scored, rest, sunk);
      picks.push(...markBestRatios(scored.map(bearer)).map((badge) => badge.closest(cardSelector)));
    }
  };

  // Scores land one request at a time; re-sort as they do, but at most once a
  // frame so a slow batch doesn't reshuffle the grid on every response.
  let sortQueued = false;
  const scheduleSort = () => {
    if (sortQueued) return;
    sortQueued = true;
    requestAnimationFrame(() => {
      sortQueued = false;
      resort();
    });
  };

  const score = (card: Element, id: string, attempt = 0): void => {
    scoreForCard(card)
      .catch(() => null)
      .then((data) => {
        // Recycled for another product while in flight, or badged meanwhile.
        if (identity(card) !== id || card.querySelector('.nps-score-badge')) return;
        if (!data || isNaN(data.nps)) {
          if (attempt < RETRIES) {
            setTimeout(() => {
              if (card.isConnected && identity(card) === id) score(card, id, attempt + 1);
            }, RETRY_BASE_MS * 4 ** attempt);
          }
          return;
        }
        // The badge, not the card, carries `data-nps`: the badge lives inside
        // the rating node hosts persist across re-renders, so the rank survives
        // the card wrapper being recreated around it.
        const badge = renderScoreBadge(data);
        badge.setAttribute('data-nps', String(data.score));
        badge.setAttribute('data-nps-ratio', String(Math.round(data.nps)));
        badge.setAttribute('data-nps-id', id);
        placeBadge(card, badge);
        scheduleSort();
      })
      .catch(() => {});
  };

  const processCards = () => {
    for (const card of document.querySelectorAll(cardSelector)) {
      // `data-nps-done` names the product the card was scored for, so a card
      // the host recycles for another product comes round again.
      const id = identity(card);
      if (card.getAttribute('data-nps-done') === id) continue;
      card.setAttribute('data-nps-done', id);
      // Idempotent guard. Some hosts (e.g. Uniqlo's and IKEA's React grids)
      // re-render a card's wrapper around a persisted rating node, so a
      // freshly-matched card can already carry our badge. Never stack a second
      // one — but do re-rank, because the recreated wrapper lost any CSS
      // `order` it carried. Loop-safe because the default CSS-band resort
      // makes no childList mutations for the observer to re-fire on.
      const badge = card.querySelector<HTMLElement>('.nps-score-badge[data-nps-id]');
      if (badge?.dataset.npsId === id) {
        scheduleSort();
        continue;
      }
      // A recycled card's badge, and so its rank, belong to its last product.
      if (badge) {
        badge.remove();
        scheduleSort();
      }
      score(card, id);
    }
  };

  let debounceTimer: ReturnType<typeof setTimeout>;
  const debouncedProcess = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processCards, 200);
  };

  processCards();
  new MutationObserver(debouncedProcess).observe(document.body, { childList: true, subtree: true });
  cycleBestRatios(() => picks);
};
