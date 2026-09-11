import { test, expect, describe } from 'bun:test';
import {
  rankChildren,
  structuralContainers,
  orderByAppend,
  orderByCssBand,
  renderScoreBadge,
  markBestRatios,
} from './score-grid';

// --- DOM builders ----------------------------------------------------------

const card = (nps?: number): HTMLElement => {
  const el = document.createElement('div');
  el.className = 'card';
  if (nps != null) el.setAttribute('data-nps', String(nps));
  return el;
};

// A wrapper that isn't itself scored but holds a scored card (the container's
// direct child is often a grid `li`, not the card).
const wrap = (child: Element): HTMLElement => {
  const li = document.createElement('div');
  li.appendChild(child);
  return li;
};

const grid = (...children: Element[]): HTMLElement => {
  const g = document.createElement('div');
  children.forEach((c) => g.appendChild(c));
  return g;
};

// --- rankChildren: the sort-selection --------------------------------------

describe('rankChildren', () => {
  test('sorts scored children by data-nps, descending', () => {
    const a = card(10);
    const b = card(50);
    const c = card(30);
    const { scored, rest } = rankChildren(grid(a, b, c));
    expect(scored).toEqual([b, c, a]);
    expect(rest).toEqual([]);
  });

  test('unscored children go to rest, in original order (scored float above them)', () => {
    const scoredHi = card(80);
    const pendingA = card();
    const scoredLo = card(20);
    const pendingB = card();
    const { scored, rest } = rankChildren(grid(scoredHi, pendingA, scoredLo, pendingB));
    expect(scored).toEqual([scoredHi, scoredLo]);
    expect(rest).toEqual([pendingA, pendingB]);
  });

  test('finds data-nps on a descendant when the direct child is a wrapper', () => {
    const hi = wrap(card(90));
    const lo = wrap(card(40));
    const { scored } = rankChildren(grid(lo, hi));
    expect(scored).toEqual([hi, lo]);
  });

  test('hated cards sink into their own band, below the unscored', () => {
    const neg = card(-30);
    const worse = card(-90);
    const pos = card(5);
    const pending = card();
    const { scored, rest, sunk } = rankChildren(grid(worse, neg, pending, pos));
    expect(scored).toEqual([pos]);
    expect(rest).toEqual([pending]);
    expect(sunk).toEqual([neg, worse]);
  });

  test('all-unscored container yields no scored', () => {
    const { scored, rest } = rankChildren(grid(card(), card()));
    expect(scored).toEqual([]);
    expect(rest.length).toBe(2);
  });
});

// --- structuralContainers: discovery ---------------------------------------

describe('structuralContainers', () => {
  test('finds the nearest ancestor holding two or more cards', () => {
    const cards = [card(), card(), card()];
    const g = grid(...cards);
    const containers = structuralContainers('.card')(cards);
    expect([...containers]).toEqual([g]);
  });

  test('counts wrapper children that contain a card (grid of li > card)', () => {
    const cards = [card(), card(), card()];
    const g = grid(...cards.map(wrap));
    const containers = structuralContainers('.card')(cards);
    expect([...containers]).toEqual([g]);
  });

  test('walks past ancestors that hold fewer than two cards', () => {
    // outer holds two rows, each row holds a single card → the row has <2, so
    // discovery climbs to `outer`, whose two children each bear a card.
    const c1 = card();
    const c2 = card();
    const outer = grid(wrap(c1), wrap(c2));
    const containers = structuralContainers('.card')([c1, c2]);
    expect([...containers]).toEqual([outer]);
  });

  test('a lone card has no ranking container', () => {
    const only = card();
    grid(only); // single child
    const containers = structuralContainers('.card')([only]);
    expect([...containers]).toEqual([]);
  });

  // AliExpress's #card-list: 12 rendered cards behind 48 empty `lazy-load` divs.
  const placeholder = (): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'lazy-load';
    el.style.cssText = 'width:220px;height:220px';
    return el;
  };
  const section = (text: string): HTMLElement => {
    const el = document.createElement('section');
    el.textContent = text;
    return el;
  };

  test('empty lazy-load placeholders weigh on neither side', () => {
    const cards = [card(), card(), card()];
    const g = grid(...cards.map(wrap), ...Array.from({ length: 12 }, placeholder));
    expect([...structuralContainers('.card')(cards)]).toEqual([g]);
  });

  test('still rejects a page-level ancestor whose children are mostly other content', () => {
    const [c1, c2] = [card(), card()];
    grid(wrap(c1), wrap(c2), section('Related searches'), section('Help'), section('Footer'), placeholder(), placeholder());
    expect([...structuralContainers('.card')([c1, c2])]).toEqual([]);
  });
});

// --- applyOrder strategies -------------------------------------------------

describe('applyOrder strategies', () => {
  test('orderByAppend moves scored first, then rest', () => {
    const a = card(10);
    const b = card(50);
    const pending = card();
    const g = grid(a, pending, b);
    const { scored, rest } = rankChildren(g);
    orderByAppend(g, scored, rest);
    expect([...g.children]).toEqual([b, a, pending]);
  });

  test('orderByCssBand floats scored with a negative order band, touching nothing else', () => {
    const a = card(10);
    const b = card(50);
    const pending = card();
    const g = grid(a, pending, b);
    const { scored } = rankChildren(g);
    orderByCssBand(g, scored);
    // b (rank 0 of 2) → -2, a (rank 1) → -1; pending stays at default.
    expect((b as HTMLElement).style.order).toBe('-2');
    expect((a as HTMLElement).style.order).toBe('-1');
    expect((pending as HTMLElement).style.order).toBe('');
    // no node moved
    expect([...g.children]).toEqual([a, pending, b]);
  });

  test('a hated card lands below the unscored under every strategy', () => {
    const hated = card(-40);
    const loved = card(60);
    const pending = card();
    const g = grid(hated, pending, loved);
    const { scored, rest, sunk } = rankChildren(g);
    orderByCssBand(g, scored, rest, sunk);
    expect((loved as HTMLElement).style.order).toBe('-1');
    expect((pending as HTMLElement).style.order).toBe('');
    expect((hated as HTMLElement).style.order).toBe('1');
    orderByAppend(g, scored, rest, sunk);
    expect([...g.children]).toEqual([loved, pending, hated]);
  });

  test('orderByCssBand returns a child that dropped out of the ranking to the default', () => {
    // A recycled card loses its badge; until its new product scores it's unscored.
    const [a, b, c] = [card(50), card(10), card(-5)];
    const g = grid(a, b, c);
    const band = () => {
      const { scored, rest, sunk } = rankChildren(g);
      orderByCssBand(g, scored, rest, sunk);
    };
    band();
    b.removeAttribute('data-nps');
    c.removeAttribute('data-nps');
    band();
    expect([a.style.order, b.style.order, c.style.order]).toEqual(['-1', '', '']);
  });

  test('orderByCssBand never clears an order the host set itself', () => {
    const hostPinned = card();
    hostPinned.style.order = '3';
    const g = grid(card(20), card(10), hostPinned);
    const { scored, rest, sunk } = rankChildren(g);
    orderByCssBand(g, scored, rest, sunk);
    expect(hostPinned.style.order).toBe('3');
  });
});

// --- markBestRatios --------------------------------------------------------

describe('markBestRatios', () => {
  const badge = (score: number, ratio?: number): HTMLElement => {
    const el = document.createElement('span');
    el.setAttribute('data-nps', String(score));
    if (ratio != null) el.setAttribute('data-nps-ratio', String(ratio));
    return el;
  };

  test('tints each badge whose ratio clearly beats every one ranked above it', () => {
    // The dm biscuit shelf ranked by score: dips, ties and a one-point edge stay plain.
    const badges = [badge(162, 82), badge(147, 81), badge(137, 82), badge(128, 83), badge(123, 93)];
    expect(markBestRatios(badges)).toEqual([badges[0], badges[4]]);
    expect(badges[0].style.background).not.toBe('');
    expect(badges[1].style.background).toBe('');
  });

  test('a thin card never earns a tint, however perfect its ratio', () => {
    const badges = [badge(162, 82), badge(1, 100)];
    expect(markBestRatios(badges)).toEqual([badges[0]]);
  });

  test('skips missing badges and unknown ratios without lowering the bar', () => {
    const [hi, unknown, lo] = [badge(90, 70), badge(80), badge(70, 60)];
    expect(markBestRatios([null, hi, unknown, lo])).toEqual([hi]);
  });

  test('clears a tint the badge no longer earns after a re-rank', () => {
    const [a, b] = [badge(50, 80), badge(40, 90)];
    markBestRatios([a, b]);
    expect(markBestRatios([b, a])).toEqual([b]);
    expect(a.style.background).toBe('');
  });
});

// --- renderScoreBadge ------------------------------------------------------

describe('renderScoreBadge', () => {
  test('shows score and rounded nps, colours by sentiment', () => {
    const badge = renderScoreBadge({ score: 1234, nps: 67.4, total: 5000 });
    expect(badge.textContent).toBe('1,234 (67%)');
    expect(badge.title).toBe('5,000 item reviews');
    expect(badge.style.color).toContain('hsl');
  });

  test('omits the title when total is absent', () => {
    const badge = renderScoreBadge({ score: 3, nps: 20 });
    expect(badge.title).toBe('');
  });
});
