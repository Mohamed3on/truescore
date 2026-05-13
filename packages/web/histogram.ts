import { fetchPlacePreview } from './browser';
import { histogramFromPreview, metaFromPreview, type Histogram, type PlaceMeta } from '@truescore/gmaps-shared';

export { overallPctFromHistogram, overallScoreFromHistogram, type Histogram, type PlaceMeta } from '@truescore/gmaps-shared';

export type PreviewBundle = { histogram: Histogram | null; meta: PlaceMeta };

export async function fetchPreviewBundle(placeUrl: string): Promise<PreviewBundle> {
  const data = await fetchPlacePreview(placeUrl);
  return { histogram: histogramFromPreview(data), meta: metaFromPreview(data) };
}
