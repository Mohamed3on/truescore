// Shared bits between truescore-web (Hetzner-hosted SPA) and the TrueScore
// browser extension. Anything that depends only on Google Maps' RPC schema
// or scoring math lives here so a Google-side change is fixed in one place.
//
// Storage, HTTP transport, DOM, and server routing stay in their respective
// packages — those diverge enough that abstraction would obscure more than
// it shares.

export type Review = {
  reviewId: string;
  stars: number;
  reviewerReviewCount: number;
  timestamp: number | null;
  text: string;
  // Exact words Google flagged as matching the active search/highlight, sliced
  // from `text`. Absent when none (incl. a shown translation, which carries no
  // offsets — see matchTermsFromEntry). Used only to highlight matches in the UI.
  matchTerms?: string[];
};

export type SortKey = 'relevant' | 'newest';
export type Histogram = number[]; // [5★, 4★, 3★, 2★, 1★]
export type Locale = { hl?: string; gl?: string };
export type SortStats = { totalReviews: number; trustedReviews: number; scorePct: number };
export type ChipMeta = { token: string; label: string; count: number };

export const PAGE_SIZE = 20;
export const TRUSTED_MIN_REVIEWS = 3;

export const isTrusted = (reviewerReviewCount: number) => reviewerReviewCount >= TRUSTED_MIN_REVIEWS;
export const starScore = (stars: number): number => (stars === 5 ? 1 : stars === 1 ? -1 : 0);

// Each entry is prefixed with `[YYYY-MM-DD] ` (or `[undated]` when Google's
// payload didn't carry a timestamp) so a model reading the block knows when
// each review was posted and can weight recent ones. Google review
// timestamps come in microseconds; values past ~1e14 get normalized to ms.
export const textReviewsFor = (reviews: Review[]): string[] =>
  reviews
    .filter((r) => r.text.length > 1)
    .map((r) => {
      const t = r.timestamp;
      if (t == null) return `[undated] ${r.text}`;
      const ms = t > 1e14 ? t / 1000 : t;
      const date = new Date(ms).toISOString().slice(0, 10);
      return `[${date}] ${r.text}`;
    })
    .sort((a, b) => b.length - a.length);

// Reviews for the label-search and highlight panels: drop ones too short to be
// worth a card, newest first. Web and extension render the cards differently
// but agree on which reviews to show and in what order.
export const sortedDisplayReviews = (reviews: Review[]): Review[] =>
  reviews
    .filter((r) => r.text.length >= 10)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

// '★'×n + '☆'×(5−n) — review stars and the 1–5 value rating both render it.
export const starString = (stars: number): string =>
  '★'.repeat(stars) + '☆'.repeat(Math.max(0, 5 - stars));

// Order topic chips for display: those scoring at-or-above the place's overall
// score first, then by impact = (pct/100)·|pct/100|·count — polarity-signed,
// weighted by how many reviews back the chip. Returns a new array. Shared
// because web and extension reverse-engineered the identical ordering.
export type ChipLike = { score?: { scorePct: number } | null; count: number };
export const sortChipsByImpact = <T extends ChipLike>(chips: T[], overallPct: number): T[] => {
  const impact = (c: T) => { const r = (c.score?.scorePct ?? 0) / 100; return r * Math.abs(r) * c.count; };
  const above = (c: T) => (c.score?.scorePct ?? 0) >= overallPct;
  return [...chips].sort((a, b) => (Number(above(b)) - Number(above(a))) || (impact(b) - impact(a)));
};

// Union review lists into one set, deduped by reviewId (last write wins) — the
// fold that pairs with the collection loop: relevant∪newest, or an OR-search
// fan-out, collapsed to a single deduped list.
export const mergeByReviewId = (...lists: Review[][]): Review[] => {
  const m = new Map<string, Review>();
  for (const list of lists) for (const r of list) m.set(r.reviewId, r);
  return [...m.values()];
};

// Split a review-search query on the Gmail-style ` OR ` operator (any case)
// into distinct non-empty terms: "breakfast OR parking" → ["breakfast",
// "parking"], a plain query → one term, "" → []. Server-side searches (Google
// RPC) run one upstream search per term and merge; client-side searches match
// ANY term. Capped so an OR chain can't fan out into unbounded upstream calls.
export const MAX_OR_TERMS = 6;
export const parseOrQuery = (query: string): string[] =>
  query
    .split(/\s+OR\s+/i)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, MAX_OR_TERMS);

// Strip combining diacritics so accented spellings fold to ASCII: "açaí" →
// "acai", "jalapeño" → "jalapeno". NFD separates each base letter from its
// accent; we drop the accent marks (U+0300–U+036F).
export const stripAccents = (s: string): string =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '');

// Search query for a keyword, broadened for recall: OR in the accent-folded
// spelling ("açaí" → "açaí OR acai") and swap hyphens↔spaces ("europa-park" →
// "europa-park OR europa park"). Google ranks "europa-park", "europa park" and
// the quoted phrase differently and returns different counts, so we search the
// spellings and union the hits rather than betting on one. Plain single words
// are unchanged. Variants fan out through parseOrQuery, capped at MAX_OR_TERMS.
export const accentVariantQuery = (term: string): string => {
  const variants = new Set<string>();
  for (const base of [term, stripAccents(term)]) {
    variants.add(base);
    if (base.includes('-')) variants.add(base.replace(/-/g, ' '));
    if (/\s/.test(base)) variants.add(base.replace(/\s+/g, '-'));
  }
  return [...variants].slice(0, MAX_OR_TERMS).join(' OR ');
};

// Upstream search terms for a query: split on OR, expand each to its
// accent/hyphen/space variants, dedupe, cap the fan-out. Both the extension and
// the server feed this to collectSearchTerms, so a typed query gets the same
// spelling-variant recall as a chip's auto-search.
export const expandSearchTerms = (query: string): string[] =>
  [...new Set(parseOrQuery(query).flatMap((t) => parseOrQuery(accentVariantQuery(t))))].slice(0, MAX_OR_TERMS);

// Google retired GET /maps/rpc/listugcposts — it now returns [null,…,1] for
// everyone, Maps' own page included. Reviews come only from the batchexecute
// RPC (rpcid qv9Egd → /MapsUgcPostService.ListUgcPosts), which requires a
// botguard-signed `x-maps-bgkey` minted by Google's page JS. We can't forge it;
// we lift creds off a request Google's own UI made (extension: capture bridge;
// web: headless browser) and replay them. One token is session-bound — reusable
// across sorts, pages, highlight-tokens, AND different places, until it expires
// (verified live), so callers cache a single set of creds globally.
export type MapsCreds = { bgkey: string; bgbind: string; sessionId: string; at: string; hl?: string };
export type MapsReq = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

let batchReqId = 1000;

// The inner ListUgcPosts request array. A free-text query sits in slot 2 and a
// highlight token in slot 4 (both optional); the trailing [2]/[1] picks
// newest/relevant. Page size + cursor sit in slot 1; sessionId pairs with the
// captured bgkey/bgbind.
const innerListReq = (featureId: string, sort: SortKey, token: string | null, query: string | null, cursor: string, sessionId: string): string =>
  JSON.stringify([
    [[featureId], null, query || null, null, token ? [[token]] : null, [null, null, null, [[1], [3]]]],
    [PAGE_SIZE, cursor],
    null, null,
    [sessionId, null, null, null, null, null, 81],
    null, null,
    [null, 1, 1, null, 1, null, 1, null, null, null, null, [1, 1, null, [[1]]]],
    null, null,
    [3, 1, null, null, null, [2]],
    null,
    [sort === 'newest' ? 2 : 1],
  ]);

const batchExecuteReq = (featureId: string, sort: SortKey, token: string | null, query: string | null, cursor: string, creds: MapsCreds): MapsReq => {
  const fReq = JSON.stringify([[['/MapsUgcPostService.ListUgcPosts', innerListReq(featureId, sort, token, query, cursor, creds.sessionId), null, 'generic']]]);
  return {
    url: `https://www.google.com/maps/_/MapsWizUi/data/batchexecute?rpcids=qv9Egd&hl=${creds.hl || 'en'}&_reqid=${(batchReqId += 100)}&rt=c`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-maps-bgkey': creds.bgkey,
        'x-maps-bgbind': creds.bgbind,
        'x-maps-diversion-context-bin': 'CAE=',
        'x-same-domain': '1',
      },
      body: `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(creds.at)}&`,
    },
  };
};

export const buildListReq = (featureId: string, sort: SortKey, creds: MapsCreds, cursor = ''): MapsReq =>
  batchExecuteReq(featureId, sort, null, null, cursor, creds);

// Highlight-token queries use the newest order within the filtered set.
export const buildTokenReq = (featureId: string, token: string, creds: MapsCreds, cursor = ''): MapsReq =>
  batchExecuteReq(featureId, 'newest', token, null, cursor, creds);

// Free-text review search: query in slot 2, relevant ordering (matches Maps'
// own review-search box). Was a per-package pb; the batchexecute shape is
// identical to sort/token now, so both packages share this.
export const buildSearchReq = (featureId: string, query: string, creds: MapsCreds, cursor = ''): MapsReq =>
  batchExecuteReq(featureId, 'relevant', null, query, cursor, creds);

// Review text lives at r[2][15]: an array of [text, mentions, range] tuples.
// [0] is the original-language text; [1] (if present) is the translation in the
// requested locale (`hl=en` → English). Prefer the translation when both exist.
const hasText = (entry: any): boolean => typeof entry?.[0] === 'string' && entry[0].length > 0;

// The tuple we actually display — and whose [1] match offsets therefore line up
// with the shown text. Google fills offsets only on the original, so a shown
// translation carries none and highlighting falls back to the query term.
const pickTextEntry = (r: any): any[] | null => {
  const arr = r?.[2]?.[15];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (arr.length > 1 && hasText(arr[1])) return arr[1];
  return hasText(arr[0]) ? arr[0] : null;
};

// Exact matched words, sliced from the displayed text using the offsets in
// entry[1]: [start, end] for a label search, [start, end, null, [[[token]]]] for
// a highlight chip — both read via [0]/[1]. Empty when the entry has no offsets.
const matchTermsFromEntry = (entry: any[] | null): string[] => {
  const text = entry?.[0];
  const spans = entry?.[1];
  if (typeof text !== 'string' || !Array.isArray(spans)) return [];
  const out: string[] = [];
  for (const m of spans) {
    const s = m?.[0];
    const e = m?.[1];
    if (typeof s === 'number' && typeof e === 'number' && e > s) {
      const w = text.slice(s, e).trim();
      if (w) out.push(w);
    }
  }
  return out;
};

// Unwrap a batchexecute reviews response to its parsed inner payload — the
// [null, cursor, [[wrappers]], …] array. The transport double-wraps it:
// )]}'\n\n<len>\n[["wrb.fr","/MapsUgcPost…","<escaped JSON string>",…],…], a
// length-prefixed envelope whose wrb.fr frame carries the real payload as an
// escaped JSON string (the same shape the legacy endpoint returned). Returns
// null when nothing parses. One copy of the unwrap, shared by the review parser
// and the stale-session detector below.
const computeUnwrap = (text: string): any[] | null => {
  let inner = text;
  if (text.includes('"wrb.fr"')) {
    const m = text.match(/"\/MapsUgcPostService\.ListUgcPosts","((?:\\.|[^"\\])*)"/);
    if (!m) return null;
    try { inner = JSON.parse(`"${m[1]}"`); } catch { return null; }
  }
  try { return JSON.parse(inner.replace(/^\)\]\}'\s*/, '')); } catch { return null; }
};

// Memoized so a body isn't unwrapped + JSON-parsed twice: the web transport
// sniffs each page for staleness (isStaleReviewsResponse) and collectPaged then
// parses the SAME string for reviews. The two calls share the exact string, so
// the lookup is a reference hit; bounded to a few entries so it retains nothing.
const unwrapCache: { raw: string; data: any[] | null }[] = [];
const unwrapBatchPayload = (text: string): any[] | null => {
  for (const e of unwrapCache) if (e.raw === text) return e.data;
  const data = computeUnwrap(text);
  unwrapCache.push({ raw: text, data });
  if (unwrapCache.length > 4) unwrapCache.shift();
  return data;
};

export const parseReviewsResponse = (text: string): { reviews: Review[]; nextCursor: string | null } => {
  const data = unwrapBatchPayload(text);
  const arr = data?.[2];
  if (!data || !Array.isArray(arr) || !arr.length) return { reviews: [], nextCursor: null };
  const reviews: Review[] = [];
  for (const wrapper of arr) {
    if (!wrapper?.[0]) continue;
    const r = wrapper[0];
    const reviewId = r[0];
    const stars = r[2]?.[0]?.[0];
    const reviewerReviewCount = r[1]?.[4]?.[5]?.[5] || 1;
    const timestamp = r[1]?.[2] ?? null;
    const entry = pickTextEntry(r);
    const text = typeof entry?.[0] === 'string' ? entry[0] : '';
    const matchTerms = matchTermsFromEntry(entry);
    if (reviewId && stars) reviews.push({ reviewId, stars, reviewerReviewCount, timestamp, text, ...(matchTerms.length ? { matchTerms } : {}) });
  }
  return { reviews, nextCursor: data[1] || null };
};

// A valid reviews response always carries a review container at data[2] (an
// array, possibly empty). The [null,…,true] shape Google returns for an expired
// or rejected session has none — so this tells a stale session apart from a
// place that genuinely has zero matching reviews, letting a caller log + reseed
// instead of silently serving "0 reviews". Malformed/other-RPC bodies aren't
// stale (they didn't parse to a payload at all), so they report false.
export const isStaleReviewsResponse = (text: string): boolean => {
  const data = unwrapBatchPayload(text);
  return data !== null && !Array.isArray(data[2]);
};

// Compile a case-insensitive matcher for `terms` — deduped, trimmed, dropping
// any under 2 chars, longest first so a phrase wins over its own words. Returns
// null when nothing is left to match. Pure string logic shared by both UIs;
// each owns how it applies the regex to its own DOM.
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const compileMatchRegex = (terms: string[]): RegExp | null => {
  const uniq = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))];
  if (!uniq.length) return null;
  uniq.sort((a, b) => b.length - a.length);
  return new RegExp(uniq.map(escapeRegExp).join('|'), 'gi');
};

export const statsForReviews = (reviews: Review[]): SortStats => {
  let trusted = 0, score = 0;
  for (const r of reviews) {
    if (!isTrusted(r.reviewerReviewCount)) continue;
    trusted++;
    score += starScore(r.stars);
  }
  return {
    totalReviews: reviews.length,
    trustedReviews: trusted,
    scorePct: trusted ? Math.round((score / trusted) * 100) : 0,
  };
};

export const scorePct = (reviews: Review[]): number => statsForReviews(reviews).scorePct;

// Preview JSON readers — shape comes from /maps/preview/place RPC.
export const chipsFromPreview = (data: any): ChipMeta[] => {
  const chips = data?.[6]?.[153]?.[0];
  if (!Array.isArray(chips)) return [];
  const out: ChipMeta[] = [];
  const seen = new Set<string>();
  for (const c of chips) {
    const token = c?.[0]?.[0];
    const label = c?.[1];
    const count = c?.[3]?.[4] ?? 0;
    if (typeof token !== 'string' || typeof label !== 'string') continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ token, label, count });
  }
  return out;
};

export const histogramFromPreview = (data: any): Histogram | null => {
  const counts = data?.[6]?.[175]?.[3];
  if (!Array.isArray(counts) || counts.length !== 5) return null;
  return [counts[4], counts[3], counts[2], counts[1], counts[0]];
};

export type DayHours = { day: string; label: string; openHour?: number; closeHour?: number };
export type PlaceMeta = {
  canonicalName?: string;
  address?: string;
  locality?: string;
  lat?: number;
  lng?: number;
  googleRating?: number;
  googleReviewCount?: number;
  priceRange?: string;
  category?: string;
  photoUrl?: string;
  timezone?: string;
  hoursWeek?: DayHours[];
};

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

const decodeCategory = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const s = raw.replace(/^SearchResult\.TYPE_/, '').toLowerCase().replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : undefined;
};

// Find the first lh3 photo URL anywhere inside a photos block. The exact path
// drifts between place types; deep-search is more robust than fixed indices.
const findPhotoUrl = (v: any, depth = 0): string | undefined => {
  if (depth > 8 || v == null) return undefined;
  if (typeof v === 'string' && v.startsWith('https://lh3.googleusercontent.com/')) return v;
  if (Array.isArray(v)) {
    for (const c of v) { const r = findPhotoUrl(c, depth + 1); if (r) return r; }
  }
  return undefined;
};

const resizePhoto = (url: string, w: number, h: number): string =>
  url.replace(/=w\d+-h\d+(-k)?(-no)?$/, '') + `=w${w}-h${h}-k-no`;

const parseHoursDay = (entry: any): DayHours | null => {
  const day = asString(entry?.[0]);
  if (!day) return null;
  const slot = entry?.[3]?.[0];
  if (!slot) return { day, label: 'Closed' };
  return {
    day,
    label: asString(slot[0]) || '—',
    openHour: asNumber(slot?.[1]?.[0]?.[0]),
    closeHour: asNumber(slot?.[1]?.[1]?.[0]),
  };
};

export const metaFromPreview = (data: any): PlaceMeta => {
  const six = data?.[6];
  if (!six) return {};
  const ratingBlock = six[4];
  const photo = findPhotoUrl(six[51]) ?? findPhotoUrl(six[37]);
  const hoursRaw = six[203]?.[0];
  const hoursWeek = Array.isArray(hoursRaw)
    ? hoursRaw.map(parseHoursDay).filter((d): d is DayHours => d !== null)
    : undefined;
  return {
    canonicalName: asString(six[11]),
    address: asString(six[39]),
    locality: asString(six[166]),
    lat: asNumber(six[9]?.[2]),
    lng: asNumber(six[9]?.[3]),
    googleRating: asNumber(ratingBlock?.[7]),
    googleReviewCount: asNumber(ratingBlock?.[8]),
    priceRange: asString(ratingBlock?.[2]),
    category: decodeCategory(six[88]?.[1]),
    photoUrl: photo ? resizePhoto(photo, 800, 320) : undefined,
    timezone: asString(six[30]),
    hoursWeek: hoursWeek?.length ? hoursWeek : undefined,
  };
};

export const histogramTotal = (h: Histogram): number => h.reduce((a, b) => a + b, 0);

export const overallPctFromHistogram = (h: Histogram): number => {
  const total = histogramTotal(h);
  if (!total) return 0;
  return Math.round((((h[0] ?? 0) - (h[4] ?? 0)) / total) * 100);
};

// (5★ − 1★) · |5★ − 1★| / total — the integer "score" shown next to the
// place name. Sign tracks net polarity; magnitude scales with both the gap
// between 5★/1★ counts and how decisively reviewers chose.
export const overallScoreFromHistogram = (h: Histogram): number => {
  const total = histogramTotal(h);
  if (!total) return 0;
  const diff = (h[0] ?? 0) - (h[4] ?? 0);
  return Math.round((diff * Math.abs(diff)) / total);
};

export const timeAgo = (ms: number): string => {
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400 / 7)}w ago`;
  if (sec < 86400 * 365) return `${Math.floor(sec / 86400 / 30)}mo ago`;
  return `${Math.floor(sec / 86400 / 365)}y ago`;
};

// Google review timestamps come in microseconds (values past ~1e14); normalise
// to ms and render a compact age. Empty string when the payload was undated.
export const reviewAge = (timestamp: number | null): string =>
  timestamp == null ? '' : timeAgo(timestamp > 1e14 ? timestamp / 1000 : timestamp);

// Review-collection loop (paginate → dedup → stop), shared by web + extension.
// Defined after the schema/scoring fns above; it consumes them at call time.
export * from './collect';

// The truescore-web HTTP contract (request / response / stream-event shapes),
// shared by the server, the web client, and the extension.
export * from './wire';
