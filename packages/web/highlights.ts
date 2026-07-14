import { chipsFromPreview, statsForReviews, type Chip, type ChipMeta } from '@truescore/gmaps-shared';
import { fetchPlacePreview } from './browser';
import { fetchAllForToken } from './gmaps';

const HARVEST_CONCURRENCY = 5;
const HARVEST_ROUNDS = 3;

// Google's /maps/preview/place RPC populates the review-topic chip slot
// ([6][153][0]) in only ~15-20% of responses — most come back with the slot
// null or empty, independently per request (Decodo rotates the exit IP each
// fetch). The slot location is stable; it's just intermittently unfilled. So
// rather than a few sequential retries — which at that rate give up >50% of the
// time — fire a small parallel batch each round and take the first populated
// result. One round-trip of latency instead of N, and reliability compounds
// with the shot count (miss rate ≈ 0.85^shots). Runs once per place: a success
// is cached (entry.highlights), so this cost isn't paid on repeat requests.
export async function harvestTokens(placeUrl: string): Promise<ChipMeta[]> {
  for (let round = 1; round <= HARVEST_ROUNDS; round++) {
    const batch = await Promise.all(
      Array.from({ length: HARVEST_CONCURRENCY }, () =>
        fetchPlacePreview(placeUrl).then(chipsFromPreview).catch(() => [] as ChipMeta[])),
    );
    const hit = batch.find((chips) => chips.length);
    if (hit) return hit;
    const shots = HARVEST_CONCURRENCY * round;
    const tail = round === HARVEST_ROUNDS ? ', giving up' : `, round ${round}/${HARVEST_ROUNDS}`;
    console.warn(`[harvestTokens] 0 chips from ${shots} parallel shots${tail} — url=${placeUrl}`);
  }
  return [];
}

export async function scoreHighlight(featureId: string, chip: ChipMeta): Promise<Chip> {
  const reviews = await fetchAllForToken(featureId, chip.token);
  return {
    ...chip,
    fetched: reviews.length,
    score: statsForReviews(reviews),
    reviews,
  };
}
