// Shared between gmaps.ts (writes) and background.ts (sweep). v2 entries
// store per-sort review IDs so hydration rebuilds each reviewMap separately.
export const SCORE_CACHE_PREFIX = 'rc_score_v2_';
export const SUMMARY_CACHE_PREFIX = 'rc_summary_';
export const HIGHLIGHTS_CACHE_PREFIX = 'rc_highlights_';
