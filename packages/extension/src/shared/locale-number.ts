// Numbers as sites print them per locale. Digit grouping varies — "1,437" (en),
// "1.437" (de), "1 437" (fr), "1’437" (de-CH) are one count — and so does the
// decimal mark: "8.6" and "8,6" are one rating.

// A rating and its review count printed together — Booking's "8,6 Fabelhaft
// 1.437 Bewertungen", Airbnb's "4.95 · 1,234 reviews" — read by their numbers,
// never their words. The rating leads, with either decimal mark; the count is
// the last whole number once the decimals are dropped, whatever its grouping.
export const parseRatingAndCount = (text: string) => {
  const rating = text.match(/\d+(?:[.,]\d{1,2})?/)?.[0] ?? '0';
  const counts = text
    .replace(/\d+[.,]\d{1,2}(?!\d)/g, ' ')
    .match(/\d{1,3}(?:[.,\s'’]\d{3})+(?!\d)|\d+/g);
  return {
    rating: Number(rating.replace(',', '.')),
    count: counts ? Number(counts[counts.length - 1].replace(/\D/g, '')) : 0,
  };
};

// `text`'s leading number, read like parseFloat but with `decimal` as the
// decimal mark and the other one as digit grouping: "1.234,5" (de) and
// "1,234.5" (en) are both 1234.5. NaN when it doesn't start with a number.
export const parseLocaleNumber = (text: string, decimal: '.' | ','): number =>
  parseFloat(decimal === ',' ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, ''));

const MAGNITUDES: Record<string, number> = { k: 1e3, th: 1e3, tsd: 1e3, m: 1e6, mio: 1e6, bn: 1e9, mrd: 1e9 };

// An amount with a magnitude suffix as either locale abbreviates it — "€1.43bn",
// "€56.04m", "€928k" / "1,43 Mrd. €", "56,04 Mio. €", "928 Tsd. €". NaN when
// there's no number.
export const parseAbbreviated = (text: string, decimal: '.' | ','): number => {
  const [, num = '', unit = ''] = text.replace(/[\p{Sc}\s]/gu, '').match(/(-?\d[\d.,]*)([a-z]*)/i) ?? [];
  return parseLocaleNumber(num, decimal) * (MAGNITUDES[unit.toLowerCase()] ?? 1);
};
