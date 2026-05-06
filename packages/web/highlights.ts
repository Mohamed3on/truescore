import { chipsFromPreview, statsForReviews, type ChipMeta, type Review, type SortStats } from '@truescore/gmaps-shared';
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

const HARVEST_ATTEMPTS = 3;
const HARVEST_DELAY_MS = 400;

// Google's /maps/preview/place RPC sometimes serves a place page without the
// chip block at all (geo / A-B bucket dependent). Decodo rotates exit IPs per
// request, so each retry usually lands in a different bucket.
export async function harvestTokens(placeUrl: string): Promise<ChipMeta[]> {
  for (let attempt = 0; attempt < HARVEST_ATTEMPTS; attempt++) {
    const chips = chipsFromPreview(await fetchPlacePreview(placeUrl));
    if (chips.length) return chips;
    if (attempt < HARVEST_ATTEMPTS - 1) {
      console.warn(`[harvestTokens] preview returned 0 chips, retry ${attempt + 1}/${HARVEST_ATTEMPTS - 1}`);
      await Bun.sleep(HARVEST_DELAY_MS);
    }
  }
  return [];
}

export async function scoreHighlight(featureId: string, chip: ChipMeta): Promise<Highlight> {
  const reviews = await fetchAllForToken(featureId, chip.token);
  return {
    ...chip,
    fetched: reviews.length,
    score: statsForReviews(reviews),
    reviews,
  };
}
