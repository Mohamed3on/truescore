// AliExpress prints the seller's own star average on every search card and above
// every buy box. The item's real histogram — and its review bodies — come from
// `searchEvaluation.do`, the unsigned endpoint the listing page's review widget
// still calls: one request answers with the star counts and up to a hundred
// reviews, no cookies and no request signing.

import { npsStats } from './utils';
import { cacheGet, cacheSet } from './cache';

const ENDPOINT = 'https://feedback.aliexpress.com/pc/searchEvaluation.do';

const SCORE_TTL = 30 * 24 * 60 * 60 * 1000;

// A page is capped at a hundred review bodies however large a `pageSize` it is
// handed, so a single request is the whole budget. Zero is the one size the
// endpoint refuses to honour — it falls back to twenty — hence the score-only
// call asks for one review it then throws away.
const REVIEWS_PAGE_SIZE = 100;
const SCORE_ONLY_PAGE_SIZE = 1;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ItemScore {
  score: number;
  nps: number;
  total: number;
}

export interface AliReview {
  rating: number;
  text: string;
  skuInfo: string;
}

export interface Evaluation {
  score: ItemScore | null;
  reviews: AliReview[];
}

export const productId = (): string | null =>
  location.pathname.match(/\/item\/(\d+)\.html/)?.[1] ?? null;

const scoreKey = (id: string) => `nps_ali_${id}`;

// `buyerEval` is the share of five stars a review is worth, not a star count:
// 100 → 5★, 20 → 1★.
const stars = (buyerEval: number) => Math.round((buyerEval || 0) / 20);

const itemScore = (stat: any): ItemScore | null => {
  const total = stat?.totalNum;
  if (!total) return null;
  return { ...npsStats(stat.fiveStarNum || 0, stat.oneStarNum || 0, total), total };
};

// Every response carries the histogram, so whichever call runs first seeds the
// score cache — a search grid and the listing page never pay for it twice.
const evaluate = async (fetcher: Fetcher, id: string, pageSize: number): Promise<Evaluation> => {
  const qs = new URLSearchParams({
    productId: id,
    lang: 'en_US', // bodies arrive translated into `lang`; ask once, in one language
    filter: 'all',
    page: '1',
    pageSize: String(pageSize),
  });
  const res = await fetcher(`${ENDPOINT}?${qs}`);
  if (!res.ok) return { score: null, reviews: [] };

  const data = (await res.json())?.data;
  const score = itemScore(data?.productEvaluationStatistic);
  if (score) cacheSet(scoreKey(id), score);

  const reviews: AliReview[] = (data?.evaViewList ?? []).map((r: any) => ({
    rating: stars(r.buyerEval),
    text: (r.buyerTranslationFeedback || r.buyerFeedback || '').trim(),
    skuInfo: (r.skuInfo ?? '').trim(),
  }));
  return { score, reviews };
};

export const fetchItemScore = async (fetcher: Fetcher, id: string): Promise<ItemScore | null> => {
  const cached = cacheGet(scoreKey(id), SCORE_TTL);
  if (cached) return cached;
  return (await evaluate(fetcher, id, SCORE_ONLY_PAGE_SIZE)).score;
};

export const fetchEvaluation = (fetcher: Fetcher, id: string) =>
  evaluate(fetcher, id, REVIEWS_PAGE_SIZE);

// The longest run of trailing words every chunk shares, stopping one word short
// of consuming a whole chunk — the value in front of the name can't be empty.
const commonTail = (chunks: string[]): string | null => {
  const rows = chunks.map((c) => c.split(/\s+/));
  const wordAt = (row: string[], n: number) => row[row.length - 1 - n];
  let n = 0;
  while (rows.every((row) => row.length - 1 - n > 0 && wordAt(row, n) === wordAt(rows[0], n))) n++;
  return n ? rows[0].slice(rows[0].length - n).join(' ') : null;
};

// Property names are title-cased (`Size`, `Ships From`, `Cable length`), so a
// lowercase word leading the shared tail can't have started the name: it is the
// last word of a value every reviewer happened to share (`1ct moissanite`,
// `3ct moissanite`). Hand it back. Names that are lowercase throughout, or not
// Latin at all, keep every word.
const nameWithin = (tail: string) => {
  const words = tail.split(' ');
  const start = words.findIndex((word) => /^[A-Z]/.test(word));
  return start > 0 ? words.slice(start).join(' ') : tail;
};

// A review names the variant it bought as one flat string — `Gem Color:White
// Metal Color:1ct moissanite Ships From:CHINA` — and AliExpress itself renders
// it unsplit, because nothing separates a value from the next property's name
// but a space. What does hold: every name repeats across reviews while its
// values differ, so each name is the trailing words the reviews agree on and
// the value is whatever precedes them. A shared *capitalized* last word is the
// one case that stays ambiguous (`Rose Gold`, `White Gold` → a `Gold Type`
// label); reviews still group under the value they belong to, so only the
// wording suffers, never the ranking.
//
// Returns one `[name, value]` list per input, aligned by index, empty where the
// string doesn't fit the shape the rest of the product's reviews agree on.
export const parseVariations = (skuInfos: string[]): [string, string][][] => {
  const none = () => skuInfos.map(() => []);
  const rows = skuInfos.map((s) => s.split(':').map((chunk) => chunk.trim()));
  const width = rows.find((row) => row.length > 1)?.length ?? 0;
  const agreeing = rows.filter((row) => row.length === width);
  if (width < 2 || agreeing.length < 2) return none();

  const names = [agreeing[0][0]];
  for (let i = 1; i < width - 1; i++) {
    const tail = commonTail(agreeing.map((row) => row[i]));
    if (!tail) return none();
    names.push(nameWithin(tail));
  }

  return rows.map((row) =>
    row.length !== width
      ? []
      : names.map((name, i) => {
          const chunk = row[i + 1];
          const next = names[i + 1];
          return [name, next ? chunk.slice(0, chunk.length - next.length).trim() : chunk];
        })
  );
};
