import { chipsFromPreview, statsForReviews, type Chip, type ChipMeta } from '@truescore/gmaps-shared';
import { fetchPlacePreview } from './browser';
import { fetchAllForToken } from './gmaps';

const QUICK_SHOTS = 5;
const WARM_SHOTS = 3;
const WARM_ROUNDS = 15;
const WARM_GAP_MS = 2500;

// Google's /maps/preview/place RPC populates the review-topic chip slot
// ([6][153][0]) in only ~15-20% of responses — most come back with the slot
// null or empty, server-random per request (no request-level lever; verified
// live) and independent across requests (Decodo rotates the exit IP each fetch).
// So one round = a small parallel batch of shots, first populated wins: one
// round-trip of latency, miss rate ≈ 0.85^shots.
async function harvestRound(placeUrl: string, shots: number): Promise<ChipMeta[]> {
  const batch = await Promise.all(
    Array.from({ length: shots }, () =>
      fetchPlacePreview(placeUrl).then(chipsFromPreview).catch(() => [] as ChipMeta[])),
  );
  return batch.find((chips) => chips.length) ?? [];
}

// Fast request-path try: one round-trip. Gets lucky ~55-70% of the time; the
// caller falls back to the background warm below when it comes up empty.
export const harvestQuick = (placeUrl: string): Promise<ChipMeta[]> => harvestRound(placeUrl, QUICK_SHOTS);

// Persistent background harvest. Since the tokens are stable per place, a single
// success caches the chips for good — so spread spaced rounds over a budget and
// the cumulative success approaches 1, even in a low window. Bounded so a
// genuinely topic-less place gives up instead of looping forever; spaced (not a
// burst) to stay polite on the proxy.
export async function harvestTokens(placeUrl: string): Promise<ChipMeta[]> {
  for (let round = 1; round <= WARM_ROUNDS; round++) {
    const chips = await harvestRound(placeUrl, WARM_SHOTS);
    if (chips.length) return chips;
    if (round < WARM_ROUNDS) await Bun.sleep(WARM_GAP_MS);
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
