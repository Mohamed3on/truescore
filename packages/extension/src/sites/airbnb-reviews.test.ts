import { expect, test } from 'bun:test';
import { selectAirbnbReviewSample } from './airbnb-reviews';

test('keeps lowest-rated reviews first, deduplicates the relevant sample, and cleans review markup', () => {
  const sample = selectAirbnbReviewSample(
    [
      { id: 'bad', rating: 1, comments: 'Noisy room<br/>Hard bed' },
      { id: 'mixed', rating: 4, comments: 'Good host &amp; poor sleep' },
      { id: 'okay', rating: 5, comments: 'Comfortable' },
    ],
    [
      { id: 'bad', rating: 1, comments: 'Noisy room<br/>Hard bed' },
      { id: 'great', rating: 5, comments: 'Excellent breakfast' },
      { id: 'empty', rating: 5, comments: ' ' },
    ],
    381,
  );

  expect(sample).toEqual({
    texts: [
      '1★ Noisy room\nHard bed',
      '4★ Good host & poor sleep',
      '5★ Comfortable',
      '5★ Excellent breakfast',
    ],
    sampled: 4,
    lowRated: 2,
    total: 381,
  });
});
