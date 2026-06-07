import { test, expect, describe } from 'bun:test';
import { parseOrQuery, accentVariantQuery, stripAccents, mergeByReviewId, collectSearchTerms, type Review } from './index';

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

  test('caps fan-out at MAX_OR_TERMS (6)', () => {
    expect(parseOrQuery('a OR b OR c OR d OR e OR f OR g OR h')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('accentVariantQuery', () => {
  test('strips combining diacritics to ASCII', () => {
    expect(stripAccents('açaí')).toBe('acai');
    expect(stripAccents('jalapeño')).toBe('jalapeno');
    expect(stripAccents('crème brûlée')).toBe('creme brulee');
  });

  test('accented term → "term OR folded" so both spellings are caught', () => {
    expect(accentVariantQuery('açaí')).toBe('açaí OR acai');
    // The result feeds parseOrQuery, which yields both spellings as terms.
    expect(parseOrQuery(accentVariantQuery('açaí'))).toEqual(['açaí', 'acai']);
  });

  test('plain ASCII term is returned unchanged', () => {
    expect(accentVariantQuery('burger')).toBe('burger');
    expect(accentVariantQuery('dirty burger')).toBe('dirty burger');
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
  const urlFor = (term: string, cursor: string) => `${term}|${cursor}`;

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

  test('no terms → [] and never touches the transport', async () => {
    let calls = 0;
    const transport = async () => { calls++; return page([], null); };
    expect(await collectSearchTerms([], urlFor, transport)).toEqual([]);
    expect(calls).toBe(0);
  });
});
