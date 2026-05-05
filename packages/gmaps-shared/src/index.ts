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

const localeQuery = (locale: Locale = {}) => `hl=${locale.hl || 'en'}&gl=${locale.gl || ''}`;

export const buildListUrl = (featureId: string, sort: SortKey, cursor = '', locale: Locale = {}) => {
  const sortVal = sort === 'newest' ? 2 : 1;
  const pb = [
    `!1m6!1s${featureId}!6m4!4m1!1e1!4m1!1e3`,
    `!2m2!1i${PAGE_SIZE}!2s${encodeURIComponent(cursor)}`,
    `!5m2!1s!7e81`,
    `!8m9!2b1!3b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1`,
    `!11m4!1e3!2e1!6m1!1i2`,
    `!13m1!1e${sortVal}`,
  ].join('');
  return `https://www.google.com/maps/rpc/listugcposts?authuser=0&${localeQuery(locale)}&pb=${pb}`;
};

// Search URL is intentionally NOT shared. Web and extension reverse-engineered
// different pb encodings for arbitrary review search; both work but the slots
// differ enough that unifying risks behavior drift. Each package owns its own.

export const buildTokenUrl = (featureId: string, token: string, cursor = '', locale: Locale = {}) => {
  const pb = [
    `!1m9!1s${featureId}`,
    `!5m2!1m1!1s${encodeURIComponent(token)}`,
    `!6m4!4m1!1e1!4m1!1e3`,
    `!2m2!1i${PAGE_SIZE}!2s${encodeURIComponent(cursor)}`,
    `!5m2!1s!7e81`,
    `!8m9!2b1!3b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1`,
    `!11m4!1e3!2e1!6m1!1i2`,
    `!13m1!1e1`,
  ].join('');
  return `https://www.google.com/maps/rpc/listugcposts?authuser=0&${localeQuery(locale)}&pb=${pb}`;
};

// Review text lives at r[2][15]: an array of [text, mentions, range] tuples.
// [0] is the original-language text; [1] (if present) is the translation in the
// requested locale (`hl=en` → English). Prefer the translation when both exist.
export const extractReviewText = (r: any): string => {
  const arr = r?.[2]?.[15];
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const pick = (entry: any): string => {
    const t = entry?.[0];
    return typeof t === 'string' && t.length > 0 ? t : '';
  };
  const translated = arr.length > 1 ? pick(arr[1]) : '';
  return translated || pick(arr[0]);
};

export const parseReviewsResponse = (text: string): { reviews: Review[]; nextCursor: string | null } => {
  const cleaned = text.replace(/^\)\]\}'\s*/, '');
  let data: any;
  try { data = JSON.parse(cleaned); } catch { return { reviews: [], nextCursor: null }; }
  const arr = data[2];
  if (!arr?.length) return { reviews: [], nextCursor: null };
  const reviews: Review[] = [];
  for (const wrapper of arr) {
    if (!wrapper?.[0]) continue;
    const r = wrapper[0];
    const reviewId = r[0];
    const stars = r[2]?.[0]?.[0];
    const reviewerReviewCount = r[1]?.[4]?.[5]?.[5] || 1;
    const timestamp = r[1]?.[2] ?? null;
    const text = extractReviewText(r);
    if (reviewId && stars) reviews.push({ reviewId, stars, reviewerReviewCount, timestamp, text });
  }
  return { reviews, nextCursor: data[1] || null };
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

export const overallPctFromHistogram = (h: Histogram): number => {
  const total = h.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  return Math.round(((h[0] - h[4]) / total) * 100);
};
