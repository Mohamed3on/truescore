import { test, expect, describe } from 'bun:test';
import { chipPolarity, selectScoredChips, sortChipsByImpact } from './index';

describe('sortChipsByImpact', () => {
  const chip = (scorePct: number, count: number, label: string) => ({ score: { scorePct }, count, label });

  test('above-overall chips first, then by signed magnitude × count', () => {
    const chips = [
      chip(40, 100, 'below-big'), // below overall — sinks despite high count
      chip(60, 1, 'above-small'),
      chip(90, 10, 'above-big'),
    ];
    expect(sortChipsByImpact(chips, 50).map((c) => c.label)).toEqual(['above-big', 'above-small', 'below-big']);
  });

  test('does not mutate the input array', () => {
    const chips = [chip(10, 1, 'a'), chip(90, 1, 'b')];
    const copy = [...chips];
    sortChipsByImpact(chips, 50);
    expect(chips).toEqual(copy);
  });

  test('a missing score sorts as zero', () => {
    const chips = [{ count: 5, label: 'x' }, { score: { scorePct: 80 }, count: 1, label: 'y' }];
    expect(sortChipsByImpact(chips, 50)[0].label).toBe('y');
  });
});

describe('chipPolarity', () => {
  test('positive at or above the place overall, negative below', () => {
    expect(chipPolarity(80, 50)).toBe('pos');
    expect(chipPolarity(50, 50)).toBe('pos'); // the boundary is inclusive
    expect(chipPolarity(49, 50)).toBe('neg');
  });
});

describe('selectScoredChips', () => {
  const item = (label: string, totalReviews?: number) => ({ label, totalReviews });
  const statsOf = (i: { totalReviews?: number }) =>
    i.totalReviews == null ? null : { totalReviews: i.totalReviews };

  test('keeps items with ≥2 reviews, most-mentioned first', () => {
    const items = [item('a', 5), item('b', 20), item('c', 2)];
    expect(selectScoredChips(items, statsOf).map((i) => i.label)).toEqual(['b', 'a', 'c']);
  });

  test('drops items below 2 reviews and still-pending items (no stats)', () => {
    const items = [item('scored', 3), item('thin', 1), item('pending')];
    expect(selectScoredChips(items, statsOf).map((i) => i.label)).toEqual(['scored']);
  });

  test('does not mutate the input array', () => {
    const items = [item('a', 2), item('b', 9)];
    const copy = [...items];
    selectScoredChips(items, statsOf);
    expect(items).toEqual(copy);
  });

  test('empty input yields no chips', () => {
    expect(selectScoredChips([], statsOf)).toEqual([]);
  });
});
