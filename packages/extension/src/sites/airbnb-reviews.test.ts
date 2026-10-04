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

test('uses Airbnb translated review text and falls back to the original when unavailable', () => {
  const sample = selectAirbnbReviewSample(
    [
      { id: 'translated', rating: 2, comments: 'Très bruyant', localizedReview: { comments: 'Very noisy' } },
      { id: 'v2', rating: 3, comments: '시끄러워요', localizedCommentV2: { comments: 'It is noisy' } },
      { id: 'original', rating: 5, comments: 'Lovely stay', localizedReview: { comments: '' } },
    ],
    [],
    3,
  );
  expect(sample.texts).toEqual(['2★ Very noisy', '3★ It is noisy', '5★ Lovely stay']);
});
