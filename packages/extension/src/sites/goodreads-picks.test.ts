import { describe, expect, test } from 'bun:test';
import { shrunkAverage } from './goodreads-picks';

describe('shrunkAverage', () => {
  test('pulls a handful of fan ratings down to the shelf', () => {
    expect(shrunkAverage(4.86, 7, 4.2, 100)).toBeCloseTo(4.24, 2);
  });

  test('leaves an established average alone', () => {
    expect(shrunkAverage(4.59, 36827, 4.2, 100)).toBeCloseTo(4.59, 2);
  });

  test('stands on the book alone when the shelf has no average', () => {
    expect(shrunkAverage(4.86, 7, null, 100)).toBe(4.86);
  });
});
