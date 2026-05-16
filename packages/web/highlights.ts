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
    const preview = await fetchPlacePreview(placeUrl);
    const chips = chipsFromPreview(preview);
    if (chips.length) return chips;
    const shape = describePreviewShape(preview);
    if (attempt < HARVEST_ATTEMPTS - 1) {
      console.warn(`[harvestTokens] preview returned 0 chips, retry ${attempt + 1}/${HARVEST_ATTEMPTS - 1} — shape=${shape} url=${placeUrl}`);
      await Bun.sleep(HARVEST_DELAY_MS);
    } else {
      console.warn(`[harvestTokens] preview returned 0 chips, giving up — shape=${shape} url=${placeUrl}`);
    }
  }
  return [];
}

// When chipsFromPreview returns nothing, the RPC payload could be (a) the
// chip slot simply absent, (b) chips present but malformed, or (c) the whole
// preview struct missing. Surface enough shape info to tell these apart in
// logs without dumping the full JSON.
function describePreviewShape(preview: unknown): string {
  if (!preview || typeof preview !== 'object') return `not-object(${typeof preview})`;
  const root = preview as any;
  const place = root?.[6];
  if (!place) return 'no-data[6]';
  const placeKeys = Object.keys(place).slice(0, 8).join(',');
  const chipSlot = place?.[153];
  if (chipSlot === undefined) return `no-data[6][153] keys=[${placeKeys}]`;
  if (!Array.isArray(chipSlot)) return `data[6][153] not array (${typeof chipSlot})`;
  const chipList = chipSlot?.[0];
  if (!Array.isArray(chipList)) return `data[6][153][0] not array (${typeof chipList})`;
  return `data[6][153][0] empty array (len=${chipList.length})`;
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
