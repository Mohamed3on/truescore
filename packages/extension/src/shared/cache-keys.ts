// Shared between gmaps.ts (writes) and background.ts (sweep) so renaming
// the prefix only needs one edit.
//
// v2 bump: pre-v2 entries cross-pollinated per-sort reviewMaps on hydration
// and didn't restore reviewData from cache. Over multiple visits the merged
// stats drifted away from the per-sort stats (merged total > sum of per-sort
// trusted reviews — see La Brioxeria's stale 195/164 vs 51+48 cache). v2
// entries store per-sort review IDs so hydration can rebuild each map
// without mixing sorts. Old keys are abandoned.
export const SCORE_CACHE_PREFIX = 'rc_score_v2_';
