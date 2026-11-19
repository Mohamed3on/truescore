import * as z from 'zod/mini';

// Shared between gmaps.ts (writes) and background.ts (sweep). v2 entries
// store per-sort review IDs so hydration rebuilds each reviewMap separately.
export const SCORE_CACHE_PREFIX = 'rc_score_v2_';
export const SUMMARY_CACHE_PREFIX = 'rc_summary_';
export const HIGHLIGHTS_CACHE_PREFIX = 'rc_highlights_';

// Per-place map of label-search query → its summary, so a search summary
// survives navigation and re-search instead of recomputing each time.
export const SEARCH_SUMMARY_CACHE_PREFIX = 'rc_search_summary_';

// Per-place auto-search scores for the standout + alternative chips, with the
// newest review id at compute time so they re-run when reviews drift (like
// highlights). v2 entries carry what the reviews say about each item.
export const SCORE_GROUP_CACHE_PREFIX = 'rc_scored_v2_';

// What content scripts kept in the host page's own storage before shared/cache.ts
// moved everything to chrome.storage: localStorage keys starting with one of these,
// and the whole IndexedDB database. Each prefix is specific to TrueScore, so the
// move never touches a key the site itself wrote.
const LEGACY_HOST_KEY_PREFIXES = [
  // Google Maps, and what every site shares: Jev answers, Tally Q&A, the rate limit.
  'rc_', 'ts_jev_', 'ts-tally-', 'ars-gemini-rate-limit',
  // Amazon
  'ars-scores-', 'ars-reviews-', 'review-summary-', 'amz-rating-cache',
  // Scores most sites keep
  'nps_',
  'gr_', 'lbx_', 'tmSorter_', 'truescore-vinted-', 'airbnb-summary-',
  'ali_eval_', 'ali-summary-', 'bk-reviews-', 'bk-summary-', 'dkt-reviews-', 'dkt-summary-',
  'etsy_reviews_', 'etsy-summary-', 'etsy-topic-', 'ikea-reviews-', 'ikea-summary-', 'uniqlo-summary-',
  'otto_histogram_', 'otto_reviews_', 'otto-summary-',
  'printful_id_', 'printful_counts_', 'printful_reviews_', 'printful-summary-',
  'helpfulcrowd-reviews-', 'helpfulcrowd-summary-',
  'bjj-reviews-', 'bjj-summary-', 'progress-reviews-', 'progress-summary-', 'tatami-reviews-', 'tatami-summary-', 'stamped-census-',
  ...['dm', 'docmorris', 'rossmann', 'mediamarkt', 'saturn'].flatMap((site) => [`${site}_rating_labels`, `${site}_reviews_`, `${site}-summary-`]),
];

export const isLegacyHostKey = (key: string) => LEGACY_HOST_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

export const LEGACY_HOST_DB = 'truescore';

// A cache entry as shared/cache.ts's cacheSet writes it. Summaries, Q&A history and
// settings are stored without `data`, so never read as one (or swept as one).
export const CACHE_ENTRY = z.object({ data: z.any(), ts: z.number() });
