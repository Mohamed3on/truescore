import { fetchPlacePreview } from './browser';
import { histogramFromPreview, type Histogram } from '@truescore/gmaps-shared';

export { overallPctFromHistogram, type Histogram } from '@truescore/gmaps-shared';

export async function fetchHistogram(placeUrl: string): Promise<Histogram | null> {
  try {
    return histogramFromPreview(await fetchPlacePreview(placeUrl));
  } catch {
    return null;
  }
}
