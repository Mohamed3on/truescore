import { test, expect, describe } from 'bun:test';
import { parseOrQuery, spellingVariants, expandSearchTerms, stripAccents, mergeByReviewId, collectSearchTerms, type Review } from './index';

const review = (id: string, stars = 5, count = 9): Review =>
  ({ reviewId: id, stars, reviewerReviewCount: count, timestamp: 1_700_000_000_000, text: `text-${id}` });

describe('parseOrQuery', () => {
  test('splits on the Gmail-style OR operator, any case', () => {
    expect(parseOrQuery('breakfast OR parking')).toEqual(['breakfast', 'parking']);
    expect(parseOrQuery('breakfast or parking')).toEqual(['breakfast', 'parking']);
  });

  test('keeps multi-word phrases as whole terms', () => {
    expect(parseOrQuery('de la riva OR half guard')).toEqual(['de la riva', 'half guard']);
  });

  test('plain query → one term; does not split on a substring "or"', () => {
    expect(parseOrQuery('wifi')).toEqual(['wifi']);
    expect(parseOrQuery('doctor')).toEqual(['doctor']);
  });

  test('blank / whitespace → []', () => {
    expect(parseOrQuery('')).toEqual([]);
    expect(parseOrQuery('   ')).toEqual([]);
  });

  test('trims and drops empties from dangling operators', () => {
    expect(parseOrQuery('quiet  OR   clean')).toEqual(['quiet', 'clean']);
  });

  test('never drops a term — a long OR chain is paced upstream, not cut', () => {
    expect(parseOrQuery('a OR b OR c OR d OR e OR f OR g OR h')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });
});

describe('spellingVariants', () => {
  test('strips combining diacritics to ASCII', () => {
    expect(stripAccents('açaí')).toBe('acai');
    expect(stripAccents('jalapeño')).toBe('jalapeno');
    expect(stripAccents('crème brûlée')).toBe('creme brulee');
  });

  test('accented term → itself and its folded spelling', () => {
    expect(spellingVariants('açaí')).toEqual(['açaí', 'acai']);
  });

  test('plain single ASCII word is just itself', () => {
    expect(spellingVariants('burger')).toEqual(['burger']);
  });

  test('hyphen and space spellings are unioned for recall', () => {
    expect(spellingVariants('europa-park')).toEqual(['europa-park', 'europa park']);
    expect(spellingVariants('europa park')).toEqual(['europa park', 'europa-park']);
    expect(spellingVariants('dirty burger')).toEqual(['dirty burger', 'dirty-burger']);
  });
});

describe('expandSearchTerms', () => {
  test('expands each OR term to its spelling variants, deduped', () => {
    expect(expandSearchTerms('europa-park')).toEqual(['europa-park', 'europa park']);
    expect(expandSearchTerms('wifi OR europa park')).toEqual(['wifi', 'europa park', 'europa-park']);
    // Already-expanded input (e.g. a chip query) is idempotent.
    expect(expandSearchTerms('europa-park OR europa park')).toEqual(['europa-park', 'europa park']);
  });

  test('every term and spelling is searched — a later term is never crowded out', () => {
    // Six spellings from the first two terms used to fill a cap, so phở was never searched.
    expect(expandSearchTerms('europa-park OR crème brûlée OR phở')).toEqual([
      'europa-park', 'europa park', 'crème brûlée', 'crème-brûlée', 'creme brulee', 'creme-brulee', 'phở', 'pho',
    ]);
    expect(expandSearchTerms('a OR b OR c OR d OR e OR f OR g')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  test('an "or" inside a hyphenated word is not an operator', () => {
    expect(expandSearchTerms('hit-or-miss')).toEqual(['hit-or-miss', 'hit or miss']);
  });
});

describe('mergeByReviewId', () => {
  test('unions lists, deduped by reviewId', () => {
    const a = [review('r1'), review('r2')];
    const b = [review('r2'), review('r3')];
    expect(mergeByReviewId(a, b).map((r) => r.reviewId)).toEqual(['r1', 'r2', 'r3']);
  });

  test('last write wins on a duplicate id', () => {
    const merged = mergeByReviewId([review('r1', 5)], [review('r1', 1)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.stars).toBe(1);
  });

  test('handles a single list and no lists', () => {
    expect(mergeByReviewId([review('r1')]).map((r) => r.reviewId)).toEqual(['r1']);
    expect(mergeByReviewId()).toEqual([]);
  });
});

describe('collectSearchTerms', () => {
  // Minimal Google listugcposts wire shape that parseReviewsResponse reads:
  // r[0]=id, r[1][2]=ts, r[1][4][5][5]=reviewerReviewCount, r[2][0][0]=stars, r[2][15]=[[text]].
  const mkWrapper = (id: string, stars: number, count: number) => {
    const r1: any = []; r1[2] = 1_700_000_000_000; r1[4] = []; r1[4][5] = []; r1[4][5][5] = count;
    const r2: any = []; r2[0] = [stars]; r2[15] = [[`text-${id}`]];
    return [[id, r1, r2]];
  };
  const page = (wrappers: any[], nextCursor: string | null) =>
    ")]}'\n" + JSON.stringify([null, nextCursor, wrappers]);
  const urlFor = (term: string, cursor: string) => ({ url: `${term}|${cursor}` });

  test('fans out one search per term and unions, deduped across terms', async () => {
    // term a: 2 pages (r1,r2 → r3). term b: 1 page (r2,r4). r2 is shared → counted once.
    const pages: Record<string, string> = {
      'a|': page([mkWrapper('r1', 5, 9), mkWrapper('r2', 1, 9)], 'a1'),
      'a|a1': page([mkWrapper('r3', 5, 9)], null),
      'b|': page([mkWrapper('r2', 1, 9), mkWrapper('r4', 4, 9)], null),
    };
    const transport = async (url: string) => pages[url] ?? page([], null);

    const snapshots: number[] = [];
    const merged = await collectSearchTerms(['a', 'b'], urlFor, transport, (m) => snapshots.push(m.length));

    expect(merged.map((r) => r.reviewId).sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(snapshots).toEqual([2, 3, 4]); // one snapshot per page; union grows monotonically
  });

  test('single term works without an onMerged callback (the extension path)', async () => {
    const transport = async () => page([mkWrapper('r1', 5, 9), mkWrapper('r2', 4, 9)], null);
    const merged = await collectSearchTerms(['solo'], urlFor, transport);
    expect(merged.map((r) => r.reviewId).sort()).toEqual(['r1', 'r2']);
  });

  test('searches every term, but never more than six paging chains at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const terms = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const transport = async (url: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return page([mkWrapper(url.split('|')[0]!, 5, 9)], null);
    };
    const merged = await collectSearchTerms(terms, urlFor, transport);
    expect(merged.map((r) => r.reviewId).sort()).toEqual([...terms].sort());
    expect(peak).toBe(6);
  });

  test('no terms → [] and never touches the transport', async () => {
    let calls = 0;
    const transport = async () => { calls++; return page([], null); };
    expect(await collectSearchTerms([], urlFor, transport)).toEqual([]);
    expect(calls).toBe(0);
  });
});
