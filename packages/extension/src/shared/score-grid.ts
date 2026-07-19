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
        if ([...parent.children].filter(isBearer).length >= 2) return parent;
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
export const orderByAppend = (container: Element, scored: Element[], rest: Element[]): void => {
  const desired = [...scored, ...rest];
  if (desired.every((child, i) => container.children[i] === child)) return;
  for (const child of desired) container.appendChild(child);
};

// For flex/grid rows whose children the host pins with `order` utility classes:
// win them with an `!important` order. Style-only — the tab-order drift from
// not moving nodes is the price of never fighting a host re-render.
export const orderByCssImportant = (_container: Element, scored: Element[], rest: Element[]): void => {
  [...scored, ...rest].forEach((child, i) => {
    (child as HTMLElement).style.setProperty('order', String(i), 'important');
  });
};

// The default. Touch no nodes: a negative `order` band floats the scored cards
// above everything still at the default 0. Grid/flex layout honours it, the
// host framework never inspects it, and a resort makes zero childList
// mutations — so re-rendering hosts (React/Vue grids, lazy-load placeholder
// rows) have nothing to fight and observers nothing to re-fire on.
export const orderByCssBand = (_container: Element, scored: Element[]): void => {
  scored.forEach((child, i) => {
    (child as HTMLElement).style.order = String(i - scored.length);
  });
};

// The module owns `data-nps`, so a container's scored child is whichever element
// under it carries the attribute — the card itself or a descendant.
const bearer = (child: Element): Element | null =>
  child.matches('[data-nps]') ? child : child.querySelector('[data-nps]');

// Partition a container's direct children into the scored ones (carrying a
// `data-nps`, sorted by it descending) and the rest, in original order. This is
// the ranking the grid applies each frame — exposed so the selection can be
// tested without a live grid.
export const rankChildren = (container: Element): { scored: Element[]; rest: Element[] } => {
  const scored: { child: Element; score: number }[] = [];
  const rest: Element[] = [];
  for (const child of [...container.children]) {
    const nps = bearer(child)?.getAttribute('data-nps');
    if (nps != null) scored.push({ child, score: parseFloat(nps) });
    else rest.push(child);
  }
  scored.sort((a, b) => b.score - a.score);
  return { scored: scored.map((s) => s.child), rest };
};

// --- the grid ranker -------------------------------------------------------

export interface ScoreGridOpts {
  cardSelector: string;
  // Resolve a card's id and fetch its score. Throttling stays per-site.
  scoreForCard: (card: Element) => Promise<ScoreData | null>;
  // Place the badge relative to the card's own rating.
  placeBadge: (card: Element, badge: HTMLElement) => void;
  // Container discovery. Defaults to `structuralContainers(cardSelector)`.
  discover?: (cards: Element[]) => Iterable<Element>;
  // Sort application. Defaults to `orderByCssBand` — the only strategy safe on
  // hosts that re-render or recreate card wrappers, because its resort makes no
  // childList mutations (the persisted-badge path below re-sorts on every
  // wrapper recreation, which would feed a node-moving strategy into a
  // re-render↔re-sort loop).
  applyOrder?: (container: Element, scored: Element[], rest: Element[]) => void;
}

export const setupScoreGrid = ({
  cardSelector,
  scoreForCard,
  placeBadge,
  discover,
  applyOrder = orderByCssBand,
}: ScoreGridOpts): void => {
  const discoverContainers = discover ?? structuralContainers(cardSelector);

  const resort = () => {
    const cards = [...document.querySelectorAll(cardSelector)];
    const containers = new Set(discoverContainers(cards));
    for (const container of containers) {
      const { scored, rest } = rankChildren(container);
      if (scored.length < 2) continue; // nothing to rank against
      applyOrder(container, scored, rest);
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

  const processCards = () => {
    const cards = [...document.querySelectorAll(`${cardSelector}:not([data-nps-done])`)];
    if (!cards.length) return;

    for (const card of cards) {
      card.setAttribute('data-nps-done', '1');
      // Idempotent guard. Some hosts (e.g. Uniqlo's and IKEA's React grids)
      // re-render a card's wrapper around a persisted rating node, so a
      // freshly-matched card can already carry our badge. Never stack a second
      // one — but do re-rank, because the recreated wrapper lost any CSS
      // `order` it carried. Loop-safe because the default CSS-band resort
      // makes no childList mutations for the observer to re-fire on.
      if (card.querySelector('.nps-score-badge')) {
        scheduleSort();
        continue;
      }
      scoreForCard(card)
        .then((data) => {
          if (!data || isNaN(data.nps) || card.querySelector('.nps-score-badge')) return;
          // The badge, not the card, carries `data-nps`: the badge lives inside
          // the rating node hosts persist across re-renders, so the rank survives
          // the card wrapper being recreated around it.
          const badge = renderScoreBadge(data);
          badge.setAttribute('data-nps', String(data.score));
          placeBadge(card, badge);
          scheduleSort();
        })
        .catch(() => {});
    }
  };

  let debounceTimer: ReturnType<typeof setTimeout>;
  const debouncedProcess = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processCards, 200);
  };

  processCards();
  new MutationObserver(debouncedProcess).observe(document.body, { childList: true, subtree: true });
};
