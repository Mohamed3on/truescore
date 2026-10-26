import * as z from 'zod/mini';
import { netScore } from '@truescore/gmaps-shared';

// A listing's star shares, read only as far as they're used: a share per star
// label, and a count Number() reads.
const QUALITY = z.object({
  ratingDistribution: z.array(z.object({ label: z.unknown(), percentage: z.unknown() })),
  listingRatingStats: z.object({ overallRatingStats: z.nullish(z.object({ ratingCount: z.unknown() })) }),
});

type Quality = z.infer<typeof QUALITY>;

export type AirbnbStats = { count: number; five: number; one: number; score: number; nps: number };

// Airbnb keeps the listing's star shares in its deferred page data. The host's
// headline review count can include other listings, so use this count instead.
// The parse collects every object holding a rating distribution; the first that
// reads as one wins.
const findQuality = (deferredState: string): Quality | null => {
  const holders: unknown[] = [];

  JSON.parse(deferredState, function (key, value) {
    if (key === 'ratingDistribution') holders.push(this);

    return value;
  });

  for (const holder of holders) {
    const quality = QUALITY.safeParse(holder);

    if (quality.success) return quality.data;
  }

  return null;
};

export const airbnbStats = (deferredState: string): AirbnbStats | null => {
  let quality: Quality | null = null;

  try { quality = findQuality(deferredState); } catch { return null; }

  const count = Number(quality?.listingRatingStats?.overallRatingStats?.ratingCount);

  if (!count || !quality?.ratingDistribution) return null;
  const stars = (label: string) => Math.round(Number(quality.ratingDistribution.find((rating) => rating.label === label)?.percentage ?? 0) * count);
  const five = stars('5');
  const one = stars('1');

  return { count, five, one, score: netScore(five - one, count), nps: ((five - one) / count) * 100 };
};
