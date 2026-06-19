import { test, expect, describe } from 'bun:test';
import {
  parseReviewsResponse,
  isStaleReviewsResponse,
  chipsFromPreview,
  histogramFromPreview,
  metaFromPreview,
} from './index';

const mkWrapper = (id: string, stars: number, count: number, textEntry?: any[]) => {
  const r1: any = []; r1[2] = 1_700_000_000_000; r1[4] = []; r1[4][5] = []; r1[4][5][5] = count;
  const r2: any = []; r2[0] = [stars]; r2[15] = textEntry ?? [[`text-${id}`]];
  return [[id, r1, r2]];
};
const page = (wrappers: any[], nextCursor: string | null) =>
  ")]}'\n" + JSON.stringify([null, nextCursor, wrappers]);

// The batchexecute transport wraps the same [null, cursor, [[wrappers]]] payload
// (now a JSON string) inside a length-prefixed wrb.fr envelope.
const envelope = (rpc: string, payload: string) =>
  ")]}'\n\n123\n" + JSON.stringify([
    ['wrb.fr', rpc, payload, null, null, null, 'generic'],
    ['di', 42], ['af.httprm', 42, 'hash', 9],
  ]);
const batchPage = (wrappers: any[], nextCursor: string | null) =>
  envelope('/MapsUgcPostService.ListUgcPosts', JSON.stringify([null, nextCursor, wrappers]));

describe('parseReviewsResponse', () => {
  test('parses reviews and the next cursor (XSSI prefix stripped)', () => {
    const { reviews, nextCursor } = parseReviewsResponse(
      page([mkWrapper('a', 5, 9), mkWrapper('b', 1, 4)], 'cur1'),
    );
    expect(reviews.map((r) => r.reviewId)).toEqual(['a', 'b']);
    expect(reviews[0]!.stars).toBe(5);
    expect(reviews[0]!.reviewerReviewCount).toBe(9);
    expect(reviews[0]!.text).toBe('text-a');
    expect(nextCursor).toBe('cur1');
  });
  test('a falsy next cursor becomes null', () => {
    expect(parseReviewsResponse(page([mkWrapper('a', 5, 9)], null)).nextCursor).toBeNull();
    expect(parseReviewsResponse(page([mkWrapper('a', 5, 9)], '')).nextCursor).toBeNull();
  });
  test('malformed JSON → empty result, never throws', () => {
    expect(parseReviewsResponse(")]}'\n{not json")).toEqual({ reviews: [], nextCursor: null });
    expect(parseReviewsResponse('')).toEqual({ reviews: [], nextCursor: null });
  });
  test('no review array → empty', () => {
    expect(parseReviewsResponse(page([], 'cur')).reviews).toEqual([]);
  });
  test('missing reviewerReviewCount defaults to 1 (untrusted)', () => {
    const r1: any = []; r1[2] = 1;
    const r2: any = []; r2[0] = [5]; r2[15] = [['hi']];
    const { reviews } = parseReviewsResponse(page([[['id', r1, r2]]], null));
    expect(reviews[0]!.reviewerReviewCount).toBe(1);
  });
  test('prefers the translation entry when it has text', () => {
    const entry = [['original text'], ['translated text']];
    const { reviews } = parseReviewsResponse(page([mkWrapper('a', 5, 9, entry)], null));
    expect(reviews[0]!.text).toBe('translated text');
  });
  test('extracts matchTerms from offset spans on the chosen entry', () => {
    const entry = [['great food', [[0, 5]]]];
    const { reviews } = parseReviewsResponse(page([mkWrapper('a', 5, 9, entry)], null));
    expect(reviews[0]!.matchTerms).toEqual(['great']);
  });
  test('skips a wrapper with no stars', () => {
    const r1: any = []; r1[2] = 1; r1[4] = []; r1[4][5] = []; r1[4][5][5] = 9;
    const r2: any = []; r2[15] = [['hi']];
    const { reviews } = parseReviewsResponse(page([[['id', r1, r2]]], null));
    expect(reviews).toEqual([]);
  });
});

// parseReviewsResponse unwraps the wrb.fr envelope to the inner string, then
// runs the identical parse as above.
describe('parseReviewsResponse — batchexecute envelope', () => {
  test('unwraps the envelope and parses the inner payload + cursor', () => {
    const { reviews, nextCursor } = parseReviewsResponse(batchPage([mkWrapper('a', 5, 9), mkWrapper('b', 1, 4)], 'cur1'));
    expect(reviews.map((r) => r.reviewId)).toEqual(['a', 'b']);
    expect(reviews[0]!.stars).toBe(5);
    expect(nextCursor).toBe('cur1');
  });
  test('an empty/expired payload ([null,…,true]) → no reviews', () => {
    expect(parseReviewsResponse(batchPage([], null))).toEqual({ reviews: [], nextCursor: null });
    const expired = envelope('/MapsUgcPostService.ListUgcPosts', JSON.stringify([null, null, null, null, null, true]));
    expect(parseReviewsResponse(expired)).toEqual({ reviews: [], nextCursor: null });
  });
  test('envelope without a ListUgcPosts payload → empty, never throws', () => {
    expect(parseReviewsResponse(envelope('/Some.Other.Rpc', '[]'))).toEqual({ reviews: [], nextCursor: null });
  });
});

describe('isStaleReviewsResponse', () => {
  test('true for the [null,…,true] expired/rejected-session payload', () => {
    const expired = envelope('/MapsUgcPostService.ListUgcPosts', JSON.stringify([null, null, null, null, null, true]));
    expect(isStaleReviewsResponse(expired)).toBe(true);
  });
  test('false for a valid response, even with zero matching reviews', () => {
    expect(isStaleReviewsResponse(batchPage([], 'cur'))).toBe(false);
    expect(isStaleReviewsResponse(batchPage([mkWrapper('a', 5, 9)], null))).toBe(false);
  });
  test('false for malformed / non-ListUgcPosts bodies (not a stale-session signal)', () => {
    expect(isStaleReviewsResponse(envelope('/Some.Other.Rpc', '[]'))).toBe(false);
    expect(isStaleReviewsResponse(")]}'\n{not json")).toBe(false);
  });
});

describe('chipsFromPreview', () => {
  const mk = (chips: any[]) => { const d: any = []; d[6] = []; d[6][153] = []; d[6][153][0] = chips; return d; };
  const chip = (token: string, label: string, count: number) => {
    const c: any = []; c[0] = [token]; c[1] = label; c[3] = []; c[3][4] = count; return c;
  };
  test('reads token/label/count', () => {
    expect(chipsFromPreview(mk([chip('t1', 'Light show', 12)]))).toEqual([
      { token: 't1', label: 'Light show', count: 12 },
    ]);
  });
  test('dedupes by lowercased label (first wins)', () => {
    const out = chipsFromPreview(mk([chip('t1', 'Elevator', 3), chip('t2', 'elevator', 9)]));
    expect(out).toHaveLength(1);
    expect(out[0]!.token).toBe('t1');
  });
  test('skips a chip whose token/label is not a string, and missing data → []', () => {
    const bad: any = []; bad[0] = [123]; bad[1] = 'x';
    expect(chipsFromPreview(mk([bad]))).toEqual([]);
    expect(chipsFromPreview({})).toEqual([]);
    expect(chipsFromPreview(null)).toEqual([]);
  });
});

describe('histogramFromPreview', () => {
  const mk = (counts: any) => { const d: any = []; d[6] = []; d[6][175] = []; d[6][175][3] = counts; return d; };
  test('reverses Google 1★→5★ counts into [5★,4★,3★,2★,1★]', () => {
    expect(histogramFromPreview(mk([10, 20, 30, 40, 50]))).toEqual([50, 40, 30, 20, 10]);
  });
  test('non-length-5 or missing → null', () => {
    expect(histogramFromPreview(mk([1, 2, 3]))).toBeNull();
    expect(histogramFromPreview({})).toBeNull();
    expect(histogramFromPreview(null)).toBeNull();
  });
});

describe('metaFromPreview', () => {
  test('absent data[6] → {}', () => {
    expect(metaFromPreview({})).toEqual({});
    expect(metaFromPreview(null)).toEqual({});
  });
  test('reads name/address/rating/count and decodes the category', () => {
    const six: any = [];
    six[11] = 'Blue Bottle Coffee';
    six[39] = '1 Main St';
    six[4] = []; six[4][7] = 4.6; six[4][8] = 1234;
    six[88] = []; six[88][1] = 'SearchResult.TYPE_ICE_CREAM_SHOP';
    const d: any = []; d[6] = six;
    const meta = metaFromPreview(d);
    expect(meta.canonicalName).toBe('Blue Bottle Coffee');
    expect(meta.address).toBe('1 Main St');
    expect(meta.googleRating).toBe(4.6);
    expect(meta.googleReviewCount).toBe(1234);
    expect(meta.category).toBe('Ice cream shop');
  });
});
