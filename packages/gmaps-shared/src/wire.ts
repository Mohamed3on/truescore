// The truescore-web HTTP contract — the single source of truth for every
// /api/* request body, JSON response, and NDJSON stream-event shape. The
// server (producer), the web client, and the extension all import from here so
// a shape change is one edit checked on every end, instead of drifting between
// server route handlers and a re-declared copy in the client.
import type { UIMessage } from 'ai';
import type { ChipMeta, PlaceMeta, RemovedReviews, Review, SortStats } from './index';
import type { Answer, AnswerCounts, Stance, StanceResult } from './stance';
import type { Thread } from './thread';

// ---- payloads ----

// A verdict bullet from the LLM: one concrete line + its sentiment. Named apart
// from Chip so the two "highlights" (prose bullets vs scored topic chips) never
// collide again. `support`: how many of the summarized reviews make the point,
// as Jev read them (web/jev.ts), and `quotes` the first of those reviews — a
// bullet fewer than two reviews make is dropped before it's ever shown. Both
// absent on summaries Jev didn't check.
export type SummaryHighlight = { text: string; sentiment: string; support?: number; quotes?: string[] };
// `items`: specific things reviewers single out (dishes, animals, exhibits…),
// as short label-search terms (e.g. "alfajores", "gorilla"). Rendered as their
// own clickable chips below the topic chips, each auto-scored by a label search.
// `alternatives`: proper names of OTHER places reviewers point to as somewhere
// they'd go instead — kept apart from `items` because such a place scores low
// here precisely because it's a rival, so auto-scoring it as a feature misleads.
// Both optional — older cached summaries predate them. valueForMoney is unset
// when fewer than two reviews judge the price, or a truncated reply was cut
// before it (summary-parse.salvageStructured).
// `preferredBy`: per alternative, how many reviews say they'd rather go there;
// an alternative fewer than two reviews prefer is dropped. Absent when unchecked.
export type Summary = { highlights: SummaryHighlight[]; verdict: string; valueForMoney?: number; items?: string[]; alternatives?: string[]; preferredBy?: Record<string, number> };

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
// A Score without its reviews: streamed progress, and an extension's contribution.
export type PartialScore = Omit<Score, 'reviews'>;
// A place's Score as a lookup streams it: the numbers, and when its newest review
// was written (ms; null when none is dated) for the freshness label. Not the
// reviews themselves — they run to megabytes, and no client read them for more.
export type LookupScore = PartialScore & { latestReviewTs: number | null };

// A topic chip with its scraped review score, and what its trusted reviews say
// about the topic (StanceResult) when Jev could read them. (Formerly `Highlight`
// in both highlights.ts and the client — the source of the collision.)
export type Chip = ChipMeta & { fetched?: number; score?: SortStats; reviews?: Review[] } & Partial<StanceResult>;

export type SearchResult = {
  query: string;
  totalReviews: number;
  trustedReviews: number;
  scorePct: number;
  reviews: Review[];
  summary?: Summary;
} & Partial<StanceResult>;

// ---- /api/lookup (NDJSON stream) ----
export type LookupPayload = {
  name: string;
  score: LookupScore;
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
  | { type: 'refreshed'; name: string; score: LookupScore; histogram?: number[]; overallPct?: number | null; meta?: PlaceMeta; resolvedUrl?: string }
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
  | { type: 'score'; score: LookupScore; fetchMs: number; throttled: boolean }
  | { type: 'error'; error: string };

// ---- /api/highlights (NDJSON stream, or JSON on cache hit) ----
// `pending` (HTTP 202): topic chips aren't cached yet and the server is
// harvesting them in the background (the preview RPC only serves them
// intermittently) — the client re-polls until they arrive or it 404s. A client
// that asks to `wait` gets the stream instead, held open through the harvest by a
// `pending` line every 20s; one that closes without `chips` found none.
export type HighlightsResponse = { highlights?: Chip[]; cached?: boolean; pending?: boolean; error?: string };
export type HighlightEvent =
  | { type: 'pending' }
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

// ---- /api/tally (NDJSON stream) ----
// A Reddit Thread's Tally (CONTEXT.md). Each Option streams as the model names
// it (`listed`), then again once Jev has read every comment naming it. `reads`: what each
// counted comment says of it, by comment id, the comments behind its count. A
// count holds each commenter once (for, against, or `mixed` when they say both
// or neither), and the upvotes of the comments for and against.
export type TallyCount = { for: number; against: number; mixed: number; upFor: number; upAgainst: number };
// Fewer people than this speak of an Option and the drawer folds it into
// "named once", with no reason written for it.
export const MIN_TALLY_PEOPLE = 2;
export const speakersOf = (c: TallyCount) => c.for + c.against + c.mixed;
export type TitleTally = { key: string; name: string; count: TallyCount; reads: Record<string, Stance> };
// An Option with the narrower ones named under it (an instructor's courses).
export type OptionTally = TitleTally & { titles: TitleTally[] };
export type ListedOption = { key: string; name: string; titles: { key: string; name: string }[] };
export type TallyEvent =
  | { type: 'listed'; option: ListedOption }
  | { type: 'option'; option: OptionTally }
  // Why people back or warn against an Option, in a line, written from the
  // comments behind its count once every Option is counted.
  | { type: 'why'; key: string; text: string }
  | { type: 'done' }
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
// `answers`: how its matches answer the question, once Jev has read them.
export type AskSearch = { query: string; found: number | null; done: boolean; scorePct?: number; trustedReviews?: number; answers?: AnswerCounts };
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
// Jev's read of texts the caller already holds — the extension's own searches,
// chips and Ask matches: each one's stance on `topic`, or its answer to
// `question`, aligned with `texts` (null where it couldn't be read).
export type StanceRequest = { texts: string[]; topic?: string; question?: string };
export type StanceResponse = { stances?: (Stance | null)[]; answers?: (Answer | null)[]; error?: string };
// Which of `texts` make each summary point (indices, per point), and per rival
// how many say they'd rather go there than `place`.
export type ReceiptsRequest = { points: string[]; texts: string[]; place?: string; rivals?: string[] };
export type ReceiptsResponse = { support?: number[][]; preferredBy?: number[]; error?: string };

// ---- LLM provider selection (server-side; the popup threads its choice) ----
// The full set of summarization providers and reasoning levels the server
// accepts. Canonical here so web/llm.ts and the extension's config.ts share one
// definition instead of each re-declaring the union + its validation list.
export const LLM_PROVIDERS = ['gemini', 'openai', 'deepseek'] as const;
export type Provider = (typeof LLM_PROVIDERS)[number];
// No 'none': the AI SDK won't send it to GPT-6 models, which then run at the
// API default (medium) instead.
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
// Optional per-request overrides on the summarize/ask bodies. Unset leaves the
// server on its own default (LLM_PROVIDER env, luna:low). reasoningEffort is
// gpt-6-luna only; the server ignores it on Gemini/DeepSeek.
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
// `wait`: hold the request through a background harvest rather than answer 202
// (see HighlightsResponse). The web client opts in; the extension still polls.
// `token`: just that chip, read from the cache — the web client opening one.
export type HighlightsRequest = { featureId: string; force?: boolean; wait?: boolean; token?: string };
export type HighlightSummaryRequest = { featureId: string; token: string; name?: string; label?: string; reviewTexts?: string[]; force?: boolean } & LlmOverrides;
export type SearchRequest = { featureId: string; query: string; force?: boolean; summarize?: boolean } & LlmOverrides;
// A Search's matches as a client finds them: review texts and their TrueScore.
export type SearchMatches = { texts: string[]; scorePct: number; trustedReviews: number };
// `messages`: the Ask so far (see AskMessage). `force`: skip a replayed Answer.
export type AskRequest = { messages: AskMessage[]; featureId?: string; name?: string; reviewTexts?: string[]; filter?: string; removedReviews?: RemovedReviews | null; force?: boolean } & LlmOverrides;
// The Thread as the page loaded it (threadFromListing).
export type TallyRequest = { thread: Thread } & LlmOverrides;
// `score` omits the per-review array — the web only needs the numbers to paint,
// and a place's reviews run to megabytes. It is the extension's RAW score: the
// removal penalty is applied by whoever renders, off their own preview meta, so
// the penalty has exactly one implementation.
export type ContributeRequest = { featureId: string; name: string; summary?: Summary; highlights?: Chip[]; highlightSummaries?: Record<string, Summary>; score?: PartialScore };
