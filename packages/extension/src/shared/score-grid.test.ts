import { test, expect, describe } from 'bun:test';
import {
  rankChildren,
  structuralContainers,
  orderByAppend,
  orderByCssBand,
  renderScoreBadge,
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

  test('negative scores rank below positive ones', () => {
    const neg = card(-30);
    const pos = card(5);
    const { scored } = rankChildren(grid(neg, pos));
    expect(scored).toEqual([pos, neg]);
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
