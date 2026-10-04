import { expect, test } from 'bun:test';
import { airbnbStats } from './airbnb-stats';

test('scores Airbnb listing-specific reviews from deferred page data', () => {
  const data = JSON.stringify({
    page: { quality: {
      ratingDistribution: [{ label: '5', percentage: 0.7 }, { label: '1', percentage: 0.1 }],
      listingRatingStats: { overallRatingStats: { ratingCount: '100' } },
    } },
  });
  expect(airbnbStats(data)).toEqual({ count: 100, five: 70, one: 10, score: 36, nps: 60 });
});

test('does not assign a score when a listing has no rating breakdown', () => {
  expect(airbnbStats('{"page":{}}')).toBeNull();
  expect(airbnbStats('not json')).toBeNull();
});
