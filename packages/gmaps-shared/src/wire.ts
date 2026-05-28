// The truescore-web HTTP contract — the single source of truth for every
// /api/* request body, JSON response, and NDJSON stream-event shape. The
// server (producer), the web client, and the extension all import from here so
// a shape change is one edit checked on every end, instead of drifting between
// server route handlers and a re-declared copy in the client.
import type { ChipMeta, PlaceMeta, Review, SortStats } from './index';

// ---- payloads ----

// A verdict bullet from Gemini: one concrete line + its sentiment. Named apart
// from Chip so the two "highlights" (prose bullets vs scored topic chips) never
// collide again.
export type SummaryHighlight = { text: string; sentiment: string };
export type Summary = { highlights: SummaryHighlight[]; verdict: string; valueForMoney: number };

export type Score = {
  featureId: string;
  totalReviews: number;
  trustedReviews: number;
  scorePct: number;
  relevant: SortStats;
  newest: SortStats;
  reviews: Review[];
};
// Streamed progress omits the per-review array; the final `score` event carries it.
export type PartialScore = Omit<Score, 'reviews'>;

// A topic chip with its scraped review score. (Formerly `Highlight` in both
// highlights.ts and the client — the source of the collision.)
export type Chip = ChipMeta & { fetched?: number; score?: SortStats; reviews?: Review[] };

export type SearchResult = {
  query: string;
  totalReviews: number;
  trustedReviews: number;
  scorePct: number;
  reviews: Review[];
  summary?: Summary;
};

// ---- /api/lookup (NDJSON stream) ----
export type LookupPayload = {
  name: string;
  score: Score;
  summary?: Summary;
  highlights?: Chip[];
  histogram?: number[];
  overallPct?: number | null;
  meta?: PlaceMeta;
  resolvedUrl?: string;
  cached?: boolean;
  fetchMs?: number;
  error?: string;
};
export type LookupEvent =
  | ({ type: 'lookup' } & LookupPayload)
  | { type: 'refreshed'; name: string; score: Score; histogram?: number[]; overallPct?: number | null; meta?: PlaceMeta; resolvedUrl?: string }
  | { type: 'highlights-refreshed'; highlights: Chip[] }
  | { type: 'place'; name: string; featureId: string; resolvedUrl: string }
  | { type: 'preview'; histogram: number[] | null; overallPct: number | null; meta?: PlaceMeta }
  | { type: 'score-progress'; score: PartialScore }
  | { type: 'score'; score: Score; fetchMs: number }
  | { type: 'error'; error: string };

// ---- /api/highlights (NDJSON stream, or JSON on cache hit) ----
export type HighlightsResponse = { highlights?: Chip[]; cached?: boolean; error?: string };
export type HighlightEvent =
  | { type: 'chips'; chips: ChipMeta[] }
  | { type: 'chip'; highlight: Chip }
  | { type: 'chip-error'; token: string; label: string; error: string }
  | { type: 'done'; failures: number; totalFetched: number; cached: boolean }
  | { type: 'error'; error: string };

// ---- /api/search (NDJSON stream) ----
export type SearchResponse = { result?: SearchResult; cached?: boolean; error?: string };
export type SearchEvent =
  | ({ type: 'search-progress'; query: string } & SortStats)
  | { type: 'search'; result: SearchResult; cached: boolean }
  | { type: 'search-summary'; summary: Summary }
  | { type: 'error'; error: string };

// ---- JSON responses ----
export type SummarizeResponse = { summary?: Summary; cached?: boolean; error?: string };
export type HighlightSummaryResponse = { summary?: Summary; label?: string; cached?: boolean; error?: string };
export type HistogramResponse = { histogram?: number[]; overallPct?: number; cached?: boolean; error?: string };
export type AskResponse = { answer?: string; error?: string };
export type PlaceItem = { featureId: string; name: string; scorePct: number; resolvedUrl: string; lastAccessTs: number };
export type PlacesResponse = { places?: PlaceItem[]; error?: string };
export type CachedResponse = { found: boolean; summary?: Summary; highlights?: Chip[]; highlightSummaries?: Record<string, Summary> };
export type ContributeResponse = { ok?: boolean; error?: string };

// ---- request bodies ----
export type LookupRequest = { url: string };
export type SummarizeRequest = { featureId: string; name?: string; reviewTexts?: string[]; filter?: string; force?: boolean };
export type HighlightsRequest = { featureId: string; force?: boolean };
export type HighlightSummaryRequest = { featureId: string; token: string; name?: string; label?: string; reviewTexts?: string[]; force?: boolean };
export type SearchRequest = { featureId: string; query: string; force?: boolean; summarize?: boolean };
export type AskRequest = { featureId?: string; name?: string; reviewTexts?: string[]; question: string; filter?: string };
export type ContributeRequest = { featureId: string; name: string; summary?: Summary; highlights?: Chip[]; highlightSummaries?: Record<string, Summary> };
