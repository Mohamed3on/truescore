import { describe, expect, test } from 'bun:test';
import { compareKeys, rankKey, type Seller } from './vinted';

const seller = (positive: number, negative: number, rating: number): Seller => ({ country: 'DE', positive, negative, total: positive + negative, rating });
const eur = (amount: number) => ({ amount, currency: 'EUR' });
const order = (...entries: [string, number[]][]) => entries.sort((a, b) => compareKeys(a[1], b[1])).map(([name]) => name);

describe('rankKey', () => {
  test('good sellers, then unreviewed, then badly reviewed — postage and relevance aside', () => {
    expect(order(
      ['bad', rankKey(seller(3, 4, 0.6), eur(2), 50, 0)],
      ['none', rankKey(seller(0, 0, 0), eur(9), 0, 1)],
      ['good', rankKey(seller(5, 0, 1), eur(9), 0, 90)],
    )).toEqual(['good', 'none', 'bad']);
  });

  test('a seller 10× better outranks a parcel €1 cheaper, not €2', () => {
    const strong = seller(589, 5, 1); // score 567
    const weak = seller(13, 0, 1); // score 13

    expect(order(['weak', rankKey(weak, eur(3), 0, 0)], ['strong', rankKey(strong, eur(4), 0, 0)])).toEqual(['strong', 'weak']);
    expect(order(['weak', rankKey(weak, eur(3), 0, 0)], ['strong', rankKey(strong, eur(5), 0, 0)])).toEqual(['weak', 'strong']);
  });

  test('€1 less postage climbs 3 places of relevance, not 4', () => {
    const s = seller(50, 0, 1);

    expect(order(['top', rankKey(s, eur(4), 0, 0)], ['cheaper', rankKey(s, eur(3), 0, 2)])).toEqual(['cheaper', 'top']);
    expect(order(['top', rankKey(s, eur(4), 0, 0)], ['cheaper', rankKey(s, eur(3), 0, 4)])).toEqual(['top', 'cheaper']);
  });

  test('cards still loading wait after the known good sellers, above the unreviewed', () => {
    expect(order(
      ['none', rankKey(seller(0, 0, 0), eur(3), 0, 0)],
      ['loading', rankKey(undefined, undefined, 99, 0)],
      ['good', rankKey(seller(5, 0, 1), eur(9), 0, 50)],
    )).toEqual(['good', 'loading', 'none']);
  });
});
