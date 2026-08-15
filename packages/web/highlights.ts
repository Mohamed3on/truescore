import { chipsFromPreview, statsForReviews, type Chip, type ChipMeta } from '@truescore/gmaps-shared';
import { fetchPlacePreview } from './browser';
import { fetchAllForToken } from './gmaps';

const QUICK_SHOTS = 5;
const WARM_SHOTS = 3;
const WARM_ROUNDS = 15;
const WARM_GAP_MS = 2500;
// Consecutive all-shots-errored rounds before we stop hammering. A dead proxy or
// an expired cookie jar fails every shot the same way, and 15 spaced rounds of
// that is ~90s of pointless traffic while the client waits on a 202.
const WARM_DEAD_ROUNDS = 3;
// One retry when a chip that Google says has reviews fetches none — the
// listugcposts 200-with-empty-body throttle. Same "never trust a 0" rule the
// score path uses (cache.isThrottledScrape).
const TOKEN_RETRY_MS = 700;

// A harvest attempt. `ok` means at least one shot came back with a parsed
// preview payload, so an empty `chips` is Google's answer ("no topic chips
// here") rather than ours ("we never got to ask"). Callers must not cache a
// `!ok` empty as topic-less — that turns a transient proxy failure into six
// hours of a blank highlights row.
export type Harvest = { chips: ChipMeta[]; ok: boolean };

// Google's /maps/preview/place RPC populates the review-topic chip slot
// ([6][153][0]) in only ~15-20% of responses — most come back with the slot
// null or empty, server-random per request (no request-level lever; verified
// live) and independent across requests (Decodo rotates the exit IP each fetch).
// So one round = a small parallel batch of shots, first populated wins: one
// round-trip of latency, miss rate ≈ 0.85^shots.
async function harvestRound(placeUrl: string, shots: number): Promise<Harvest> {
  const batch = await Promise.allSettled(
    Array.from({ length: shots }, () => fetchPlacePreview(placeUrl).then(chipsFromPreview)),
  );
  const chips = batch.find((r) => r.status === 'fulfilled' && r.value.length);
  const failures = batch.filter((r) => r.status === 'rejected');
  // Errors used to be swallowed per-shot, which made a proxy/cookie outage
  // indistinguishable from a topic-less place in both the cache and the logs.
  if (failures.length) {
    const reason = failures[0]!.reason;
    console.warn(
      `[harvest] ${failures.length}/${shots} preview shots failed: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  }
  return {
    chips: chips?.status === 'fulfilled' ? chips.value : [],
    ok: failures.length < batch.length,
  };
}

// Fast request-path try: one round-trip. Gets lucky ~55-70% of the time; the
// caller falls back to the background warm below when it comes up empty.
export const harvestQuick = (placeUrl: string): Promise<Harvest> => harvestRound(placeUrl, QUICK_SHOTS);

// Persistent background harvest. Since the tokens are stable per place, a single
// success caches the chips for good — so spread spaced rounds over a budget and
// the cumulative success approaches 1, even in a low window. Bounded so a
// genuinely topic-less place gives up instead of looping forever; spaced (not a
// burst) to stay polite on the proxy. `ok` stays false if every shot of every
// round errored, so the caller retries later instead of caching the empty.
export async function harvestTokens(placeUrl: string): Promise<Harvest> {
  let ok = false;
  let deadRounds = 0;
  for (let round = 1; round <= WARM_ROUNDS; round++) {
    const result = await harvestRound(placeUrl, WARM_SHOTS);
    if (result.chips.length) return result;
    if (result.ok) { ok = true; deadRounds = 0; }
    else if (++deadRounds >= WARM_DEAD_ROUNDS) {
      console.warn(`[harvest] giving up after ${deadRounds} rounds with no usable preview response`);
      break;
    }
    if (round < WARM_ROUNDS) await Bun.sleep(WARM_GAP_MS);
  }
  return { chips: [], ok };
}

export async function scoreHighlight(featureId: string, chip: ChipMeta): Promise<Chip> {
  let reviews = await fetchAllForToken(featureId, chip.token);
  // Google says this topic has reviews but the token fetch returned none: an
  // upstream throttle, not an empty topic. One retry lands on a fresh proxy exit.
  if (!reviews.length && chip.count > 0) {
    await Bun.sleep(TOKEN_RETRY_MS);
    reviews = await fetchAllForToken(featureId, chip.token);
  }
  return {
    ...chip,
    fetched: reviews.length,
    score: statsForReviews(reviews),
    reviews,
  };
}
