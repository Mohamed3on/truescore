import { test, expect, describe } from 'bun:test';
import { parseAbbreviated, parseLocaleNumber, parseRatingAndCount } from './locale-number';

describe('parseRatingAndCount', () => {
  test("reads Booking's score block in any locale by its numbers, not its words", () => {
    expect(parseRatingAndCount('Scored 8.6 8.6Fabulous 1,437 reviews')).toEqual({ rating: 8.6, count: 1437 });
    expect(parseRatingAndCount('Mit 8,6 bewertet 8,6Fabelhaft 1.437 Bewertungen')).toEqual({ rating: 8.6, count: 1437 });
    expect(parseRatingAndCount('9,4Exceptionnel1 437 expériences vécues')).toEqual({ rating: 9.4, count: 1437 });
    expect(parseRatingAndCount('9,4Hervorragend1’437 Bewertungen')).toEqual({ rating: 9.4, count: 1437 });
    expect(parseRatingAndCount('10Exceptional5 reviews')).toEqual({ rating: 10, count: 5 });
  });

  test("reads Airbnb's rating line past the count's thousands separator", () => {
    expect(parseRatingAndCount('4.95 · 1,234 reviews').count).toBe(1234);
    expect(parseRatingAndCount('4,95 · 1.234 Bewertungen').count).toBe(1234);
    expect(parseRatingAndCount('4.8 · 12 reviews').count).toBe(12);
  });

  test('a rating with no count beside it has no count', () => {
    expect(parseRatingAndCount('4.95').count).toBe(0);
    expect(parseRatingAndCount('New')).toEqual({ rating: 0, count: 0 });
  });
});

describe('parseLocaleNumber', () => {
  test('German marks: comma decimal, dot grouping', () => {
    expect(parseLocaleNumber('25,4', ',')).toBe(25.4);
    expect(parseLocaleNumber('1.234', ',')).toBe(1234);
    expect(parseLocaleNumber('12,5 %', ',')).toBe(12.5);
  });

  test('English marks: dot decimal, comma grouping', () => {
    expect(parseLocaleNumber('25.4', '.')).toBe(25.4);
    expect(parseLocaleNumber('1,234', '.')).toBe(1234);
  });

  test('NaN when the text is not a number', () => {
    expect(parseLocaleNumber('Manchester City', ',')).toBeNaN();
  });
});

describe('parseAbbreviated', () => {
  test("transfermarkt.de's German market values", () => {
    expect(parseAbbreviated('1,43 Mrd. €', ',')).toBeCloseTo(1.43e9, 0);
    expect(parseAbbreviated('924,30 Mio. €', ',')).toBeCloseTo(924.3e6, 0);
    expect(parseAbbreviated('800 Tsd. €', ',')).toBe(800e3);
  });

  test("transfermarkt.com's English market values", () => {
    expect(parseAbbreviated('€1.43bn', '.')).toBeCloseTo(1.43e9, 0);
    expect(parseAbbreviated('€924.30m', '.')).toBeCloseTo(924.3e6, 0);
    expect(parseAbbreviated('€800k', '.')).toBe(800e3);
    expect(parseAbbreviated('€800Th.', '.')).toBe(800e3);
  });

  test('keeps the sign wherever it sits, NaN without a number', () => {
    expect(parseAbbreviated('-€5.00m', '.')).toBe(-5e6);
    expect(parseAbbreviated('-5,00 Mio. €', ',')).toBe(-5e6);
    expect(parseAbbreviated('€-', '.')).toBeNaN();
  });
});
