// The truescore-web HTTP contract — the single source of truth for every
// /api/* request body, JSON response, and NDJSON stream-event shape. The
// server (producer), the web client, and the extension all import from here so
// a shape change is one edit checked on every end, instead of drifting between
// server route handlers and a re-declared copy in the client.
import type { UIMessage } from 'ai';
import type { ChipMeta, PlaceMeta, RemovedReviews, Review, SortStats } from './index';

// ---- payloads ----

// A verdict bullet from the LLM: one concrete line + its sentiment. Named apart
// from Chip so the two "highlights" (prose bullets vs scored topic chips) never
// collide again.
export type SummaryHighlight = { text: string; sentiment: string };
// `items`: specific things reviewers single out (dishes, animals, exhibits…),
// as short label-search terms (e.g. "alfajores", "gorilla"). Rendered as their
// own clickable chips below the topic chips, each auto-scored by a label search.
// `alternatives`: proper names of OTHER places reviewers point to as somewhere
// they'd go instead — kept apart from `items` because such a place scores low
// here precisely because it's a rival, so auto-scoring it as a feature misleads.
// Both optional — older cached summaries predate them. valueForMoney is unset
// when a truncated reply was cut before it (summary-parse.salvageStructured).
export type Summary = { highlights: SummaryHighlight[]; verdict: string; valueForMoney?: number; items?: string[]; alternatives?: string[] };

export type Score = {
  featureId: string;
  totalReviews: number;
  trustedReviews: number;
  scorePct: number;
  ratio?: number; // unrounded — see SortStats
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
  // A score the extension already computed for this place and contributed, sent
  // before our own scrape starts so the panel paints immediately instead of
  // sitting empty for the whole pagination. The scrape still runs and the final
  // `score` event replaces it — this is a rehydrate, not a cache hit.
  | { type: 'provisional'; score: PartialScore; contributedAt: number }
  | { type: 'preview'; histogram: number[] | null; overallPct: number | null; meta?: PlaceMeta }
  | { type: 'score-progress'; score: PartialScore }
  // `throttled`: the server refused to cache this scrape — Google returned no
  // reviews, or left one sort empty, for a place that has them. It is not the
  // place's score; never paint it.
  | { type: 'score'; score: Score; fetchMs: number; throttled: boolean }
  | { type: 'error'; error: string };

// ---- /api/highlights (NDJSON stream, or JSON on cache hit) ----
// `pending` (HTTP 202): topic chips aren't cached yet and the server is
// harvesting them in the background (the preview RPC only serves them
// intermittently) — the client re-polls until they arrive or it 404s.
export type HighlightsResponse = { highlights?: Chip[]; cached?: boolean; pending?: boolean; error?: string };
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

// ---- /api/ask (AI SDK UI message stream) ----
// An Ask is a chat: the question, then the model's message. Calling
// searchReviews ends a round; the client runs the Search its own way and sends
// the Ask back with the matches as the call's output (see ask.ts), so the
// server keeps nothing between rounds. A question asked of the place in the
// last day comes back at once, with the Searches that reached it and when it
// was written (`answeredAt`).
//
// AskSearch is one of those Searches as a row: its query, matches found so far,
// and once settled their TrueScore — `found: null` if it couldn't run.
export type AskSearch = { query: string; found: number | null; done: boolean; scorePct?: number; trustedReviews?: number };
export type AskSearchOutput = SearchMatches & { found: number };
export type AskMessage = UIMessage<{ answeredAt?: number }, never, { searchReviews: { input: { query: string }; output: AskSearchOutput } }>;

// ---- JSON responses ----
export type SummarizeResponse = { summary?: Summary; cached?: boolean; error?: string };
export type HighlightSummaryResponse = { summary?: Summary; label?: string; cached?: boolean; error?: string };
export type HistogramResponse = { histogram?: number[]; overallPct?: number; cached?: boolean; error?: string };
// `scorePct` is the DISPLAY score — the removal penalty already applied, so a
// tile and the detail page it opens can never show two different numbers.
export type PlaceItem = { featureId: string; name: string; scorePct: number; adjusted?: boolean; resolvedUrl: string; lastAccessTs: number };
export type PlacesResponse = { places?: PlaceItem[]; error?: string };
export type CachedResponse = { found: boolean; summary?: Summary; highlights?: Chip[]; highlightSummaries?: Record<string, Summary> };
export type ContributeResponse = { ok?: boolean; error?: string };

// ---- LLM provider selection (server-side; the popup threads its choice) ----
// The full set of summarization providers and reasoning levels the server
// accepts. Canonical here so web/llm.ts and the extension's config.ts share one
// definition instead of each re-declaring the union + its validation list.
export const LLM_PROVIDERS = ['gemini', 'openai', 'deepseek'] as const;
export type Provider = (typeof LLM_PROVIDERS)[number];
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
// Optional per-request overrides on the summarize/ask bodies. Unset leaves the
// server on its own default (LLM_PROVIDER env, luna:low). reasoningEffort is
// gpt-5.6-luna only; the server ignores it on Gemini/DeepSeek.
export type LlmOverrides = { reasoningEffort?: ReasoningEffort; provider?: Provider };

// ---- request bodies ----
export type LookupRequest = { url: string };
// `removedReviews`: Google's takedown notice for the place, when the caller has
// it (the extension reads it off the preview Maps fetched for itself). The
// server otherwise falls back to the notice on its own cached preview meta; a
// caller that has neither just gets an uncouched summary. It goes to the model
// so it can weigh a survivor-only review set and hedge its verdict.
export type SummarizeRequest = { featureId: string; name?: string; reviewTexts?: string[]; filter?: string; force?: boolean; removedReviews?: RemovedReviews | null } & LlmOverrides;
export type HistogramRequest = { featureId: string };
export type HighlightsRequest = { featureId: string; force?: boolean };
export type HighlightSummaryRequest = { featureId: string; token: string; name?: string; label?: string; reviewTexts?: string[]; force?: boolean } & LlmOverrides;
export type SearchRequest = { featureId: string; query: string; force?: boolean; summarize?: boolean } & LlmOverrides;
// A Search's matches as a client finds them: review texts and their TrueScore.
export type SearchMatches = { texts: string[]; scorePct: number; trustedReviews: number };
// `messages`: the Ask so far (see AskMessage). `force`: skip a replayed Answer.
export type AskRequest = { messages: AskMessage[]; featureId?: string; name?: string; reviewTexts?: string[]; filter?: string; removedReviews?: RemovedReviews | null; force?: boolean } & LlmOverrides;
// `score` omits the per-review array — the web only needs the numbers to paint,
// and a place's reviews run to megabytes. It is the extension's RAW score: the
// removal penalty is applied by whoever renders, off their own preview meta, so
// the penalty has exactly one implementation.
export type ContributeRequest = { featureId: string; name: string; summary?: Summary; highlights?: Chip[]; highlightSummaries?: Record<string, Summary>; score?: PartialScore };
