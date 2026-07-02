import { test, expect, describe } from 'bun:test';
import { sortChipsByImpact } from './index';

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
