import { test, expect, describe } from 'bun:test';
import { tallyVariationDims } from './variation-table';

// starScore (from gmaps-shared): 5★ → +1, 1★ → −1, else 0.
const review = (rating: number, v: [string, string][]) => ({ rating, v });
const opts = {
  variationsOf: (r: { v: [string, string][] }) => r.v,
  ratingOf: (r: { rating: number }) => r.rating,
};

describe('tallyVariationDims', () => {
  test("ranks a dimension's values by net sentiment, best first", () => {
    const dims = tallyVariationDims(
      [
        review(5, [['Colour', 'Red']]),
        review(5, [['Colour', 'Red']]),
        review(1, [['Colour', 'Blue']]),
        review(5, [['Colour', 'Blue']]),
      ],
      opts
    );
    expect(dims).toHaveLength(1);
    expect(dims[0].label).toBe('Colour');
    expect(dims[0].rows.map((r) => r.label)).toEqual(['Red', 'Blue']); // Red +2, Blue 0
    expect(dims[0].rows[0].score).toBe(2);
    expect(dims[0].rows[0].meta).toBe('2 reviews');
    expect(dims[0].rows[1].score).toBe(0);
  });

  test('drops a dimension with only one value (nothing to compare)', () => {
    const dims = tallyVariationDims(
      [
        review(5, [['Size', 'M'], ['Colour', 'Red']]),
        review(5, [['Size', 'L'], ['Colour', 'Red']]),
      ],
      opts
    );
    // Size has M + L → kept; Colour is Red-only → dropped.
    expect(dims.map((d) => d.label)).toEqual(['Size']);
  });

  test('skips empty values', () => {
    const dims = tallyVariationDims(
      [
        review(5, [['Colour', '']]),
        review(5, [['Colour', 'Red']]),
        review(1, [['Colour', 'Blue']]),
      ],
      opts
    );
    expect(dims[0].rows.map((r) => r.label).sort()).toEqual(['Blue', 'Red']);
  });

  test('singular meta for a single review', () => {
    const dims = tallyVariationDims(
      [review(5, [['Colour', 'Red']]), review(1, [['Colour', 'Blue']])],
      opts
    );
    expect(dims[0].rows[0].meta).toBe('1 review');
  });

  test('reads variations through a lookup (Etsy keys by transaction id)', () => {
    const lookup = new Map<number, [string, string][]>([
      [1, [['Fit', 'True to size']]],
      [2, [['Fit', 'Runs small']]],
      [3, [['Fit', 'True to size']]],
    ]);
    const dims = tallyVariationDims([{ id: 1, rating: 5 }, { id: 2, rating: 1 }, { id: 3, rating: 5 }], {
      variationsOf: (r) => lookup.get(r.id) ?? [],
      ratingOf: (r) => r.rating,
    });
    expect(dims[0].rows[0].label).toBe('True to size'); // +2 vs Runs small −1
    expect(dims[0].rows[0].score).toBe(2);
  });
});
