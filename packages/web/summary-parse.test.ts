import { describe, expect, test } from 'bun:test';
import { capItems, salvageStructured } from './summary-parse';

describe('capItems', () => {
  test('caps at MAX_SCORED_ITEMS, keeping order', () => {
    expect(capItems(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  test("passes shorter lists through untouched — hygiene is the prompt's job", () => {
    expect(capItems(['Bravas', 'churros'])).toEqual(['Bravas', 'churros']);
  });
});

describe('salvageStructured', () => {
  test('recovers the complete highlight objects from a mid-array truncation', () => {
    // The structured call cut off after two complete highlights — the third is
    // half-written, so it must be dropped, not break the whole salvage.
    const text = '{"highlights":[{"text":"Great coffee","sentiment":"positive"},{"text":"Slow service","sentiment":"negative"},{"text":"Pric';
    const r = salvageStructured(text);
    expect(r.highlights).toEqual([
      { text: 'Great coffee', sentiment: 'positive' },
      { text: 'Slow service', sentiment: 'negative' },
    ]);
  });

  test('extracts items, alternatives, and valueForMoney from intact fields', () => {
    const text = '{"highlights":[{"text":"x","sentiment":"neutral"}],"items":["bravas","churros"],"alternatives":["Maud"],"valueForMoney":4}';
    const r = salvageStructured(text);
    expect(r.items).toEqual(['bravas', 'churros']);
    expect(r.alternatives).toEqual(['Maud']);
    expect(r.valueForMoney).toBe(4);
  });

  test('caps salvaged items', () => {
    const r = salvageStructured('"items":["a","b","c","d","e","f","g"]');
    expect(r.items).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  test('leaves valueForMoney unset when the field never arrived', () => {
    expect(salvageStructured('{"highlights":[{"text":"x","sentiment":"neutral"}]').valueForMoney).toBeUndefined();
  });

  test('degrades to empty fields on unsalvageable text', () => {
    const r = salvageStructured('totally broken, not json at all');
    expect(r.highlights).toEqual([]);
    expect(r.items).toEqual([]);
    expect(r.alternatives).toEqual([]);
    expect(r.valueForMoney).toBeUndefined();
  });
});
