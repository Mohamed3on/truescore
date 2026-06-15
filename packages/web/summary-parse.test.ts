import { describe, expect, test } from 'bun:test';
import { cleanItems, salvageStructured } from './summary-parse';

describe('cleanItems', () => {
  test('returns [] for non-arrays', () => {
    expect(cleanItems(undefined)).toEqual([]);
    expect(cleanItems(null)).toEqual([]);
    expect(cleanItems('gorilla')).toEqual([]);
  });

  test('trims, drops blanks and letterless junk', () => {
    // models occasionally echo the empty-list notation ("[]", "—") as an element
    expect(cleanItems(['  gorilla  ', '', '   ', '[]', '—', '!!!'])).toEqual(['gorilla']);
  });

  test('dedupes case-insensitively, keeping the first spelling', () => {
    expect(cleanItems(['Bravas', 'bravas', 'BRAVAS', 'churros'])).toEqual(['Bravas', 'churros']);
  });

  test('caps at 6', () => {
    expect(cleanItems(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  test('skips non-string entries', () => {
    expect(cleanItems(['gorilla', 42, { x: 1 }, 'lion'])).toEqual(['gorilla', 'lion']);
  });

  test('keeps multi-word and accented terms with a letter/number', () => {
    expect(cleanItems(['dulce de leche', '€14 brunch'])).toEqual(['dulce de leche', '€14 brunch']);
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

  test('cleans salvaged items (dedupe + hygiene)', () => {
    const r = salvageStructured('"items":["bravas","Bravas","churros"]');
    expect(r.items).toEqual(['bravas', 'churros']);
  });

  test('defaults valueForMoney to 3 when the field never arrived', () => {
    expect(salvageStructured('{"highlights":[{"text":"x","sentiment":"neutral"}]').valueForMoney).toBe(3);
  });

  test('degrades to empty fields on unsalvageable text', () => {
    const r = salvageStructured('totally broken, not json at all');
    expect(r.highlights).toEqual([]);
    expect(r.items).toEqual([]);
    expect(r.alternatives).toEqual([]);
    expect(r.valueForMoney).toBe(3);
  });
});
