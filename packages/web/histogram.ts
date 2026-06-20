import { fetchPlacePreview } from './browser';
import { chipsFromPreview, histogramFromPreview, metaFromPreview, type ChipMeta, type Histogram, type PlaceMeta } from '@truescore/gmaps-shared';

export { histogramTotal, overallPctFromHistogram, overallScoreFromHistogram, type Histogram, type PlaceMeta } from '@truescore/gmaps-shared';

// Chips ride along on the same preview RPC as the histogram + meta — capturing
// them here lets /api/highlights score them without a second full preview fetch.
export type PreviewBundle = { histogram: Histogram | null; meta: PlaceMeta; chips: ChipMeta[] };

export async function fetchPreviewBundle(placeUrl: string): Promise<PreviewBundle> {
  const data = await fetchPlacePreview(placeUrl);
  return { histogram: histogramFromPreview(data), meta: metaFromPreview(data), chips: chipsFromPreview(data) };
}
