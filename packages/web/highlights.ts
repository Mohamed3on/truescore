import { chipsFromPreview, statsForReviews, type Review, type SortStats } from '@truescore/gmaps-shared';
import { fetchPlacePreview } from './browser';
import { fetchAllForToken } from './gmaps';

export type HighlightStats = SortStats;
export type Highlight = {
  label: string;
  count: number;
  token: string;
  fetched?: number;
  score?: HighlightStats;
  reviews?: Review[];
};

export async function harvestTokens(placeUrl: string): Promise<{ label: string; count: number; token: string }[]> {
  try {
    return chipsFromPreview(await fetchPlacePreview(placeUrl));
  } catch {
    return [];
  }
}

export async function scoreHighlights(
  featureId: string,
  items: { label: string; count: number; token: string }[],
): Promise<Highlight[]> {
  return Promise.all(
    items.map(async (h) => {
      const reviews = await fetchAllForToken(featureId, h.token);
      return {
        ...h,
        fetched: reviews.length,
        score: statsForReviews(reviews),
        reviews,
      };
    }),
  );
}
