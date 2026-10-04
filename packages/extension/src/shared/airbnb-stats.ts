import { netScore } from '@truescore/gmaps-shared';

type Quality = {
  ratingDistribution?: { label: string; percentage: number }[];
  listingRatingStats?: { overallRatingStats?: { ratingCount?: string } };
};

export type AirbnbStats = { count: number; five: number; one: number; score: number; nps: number };

// Airbnb keeps the listing's star shares in its deferred page data. The host's
// headline review count can include other listings, so use this count instead.
const findQuality = (value: unknown): Quality | null => {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.ratingDistribution) && object.listingRatingStats) return value as Quality;
  for (const child of Object.values(object)) {
    const quality = findQuality(child);
    if (quality) return quality;
  }
  return null;
};

export const airbnbStats = (deferredState: string): AirbnbStats | null => {
  let quality: Quality | null = null;
  try { quality = findQuality(JSON.parse(deferredState)); } catch { return null; }
  const count = Number(quality?.listingRatingStats?.overallRatingStats?.ratingCount);
  if (!count || !quality?.ratingDistribution) return null;
  const stars = (label: string) => Math.round((quality.ratingDistribution!.find((rating) => rating.label === label)?.percentage ?? 0) * count);
  const five = stars('5');
  const one = stars('1');
  return { count, five, one, score: netScore(five - one, count), nps: ((five - one) / count) * 100 };
};
