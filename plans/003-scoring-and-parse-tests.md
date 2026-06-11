# Plan 003: Unit-test the scoring math and the Google RPC parsers

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4a3a843..HEAD -- packages/gmaps-shared/src/index.ts`
> If `index.ts` changed since this plan was written, compare the "Current state"
> excerpts of the functions under test against the live code; on a behavior
> mismatch, treat it as a STOP condition (the expected values below may be wrong).

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `4a3a843`, 2026-06-11

## Why this matters

The scoring math and the parsers for Google's undocumented nested-array RPC JSON
are the reason this project exists, and they are almost entirely untested. The
only safety net is the deploy smoke test (one hardcoded Eiffel-Tower lookup). When
Google shifts a slot in its response shape — which it does — these functions fail
**silently** (reviews vanish, scores read 0) with nothing to catch it. Pure
functions are the cheapest possible thing to test and the highest-value safety
net here.

After this plan: `bun test` covers the headline score derivations and every
Google-shape parser, so a regression (a bad refactor, or a characterization of
what Google currently returns) is caught locally and in CI.

## Current state

All functions under test live in `packages/gmaps-shared/src/index.ts` and are
already exported. Existing tests in that package:
- `packages/gmaps-shared/src/search.test.ts` — covers `parseOrQuery`,
  `accentVariantQuery`, `mergeByReviewId`, `collectSearchTerms`. **It already
  defines the exact wire-shape builder you should reuse** (`mkWrapper` / `page`,
  lines 77-84) — copy that pattern.
- `packages/gmaps-shared/src/view.test.ts` — covers `starString`, `sortChipsByImpact`.

**Untested** (this plan adds them):

`statsForReviews` (line 209) — trusted = `reviewerReviewCount >= 3`; star score is
`5★ → +1, 1★ → −1, else 0`; `scorePct = trusted ? round(score/trusted*100) : 0`:
```ts
export const statsForReviews = (reviews: Review[]): SortStats => {
  let trusted = 0, score = 0;
  for (const r of reviews) {
    if (!isTrusted(r.reviewerReviewCount)) continue;
    trusted++;
    score += starScore(r.stars);
  }
  return { totalReviews: reviews.length, trustedReviews: trusted,
           scorePct: trusted ? Math.round((score / trusted) * 100) : 0 };
};
```

`overallPctFromHistogram` (line 327) and `overallScoreFromHistogram` (line 336) —
`h` is `[5★,4★,3★,2★,1★]`:
```ts
export const overallPctFromHistogram = (h) => {
  const total = h.reduce((a,b)=>a+b,0); if (!total) return 0;
  return Math.round(((h[0] - h[4]) / total) * 100);
};
export const overallScoreFromHistogram = (h) => {
  const total = h.reduce((a,b)=>a+b,0); if (!total) return 0;
  const diff = h[0] - h[4];
  return Math.round((diff * Math.abs(diff)) / total);
};
```
> NOTE: plan 002 rewrites the `h[0]`/`h[4]` accesses as `(h[0] ?? 0)` /
> `(h[4] ?? 0)` for type-safety. That is value-preserving for valid 5-bucket
> histograms, so the expected values below hold whether or not 002 has landed.

`parseReviewsResponse` (line 175) — strips the `)]}'` XSSI prefix, reads `data[2]`
as the review array and `data[1]` as the next cursor; per review:
`reviewId=r[0]`, `stars=r[2][0][0]`, `reviewerReviewCount=r[1][4][5][5] || 1`,
`timestamp=r[1][2] ?? null`, text via `pickTextEntry` (prefers the translation
`r[2][15][1]` when it has text, else the original `r[2][15][0]`), and `matchTerms`
sliced from offset spans in the chosen entry's `[1]`. A review is kept only if
`reviewId && stars` are truthy. Malformed JSON → `{ reviews: [], nextCursor: null }`.

`chipsFromPreview` (line 226) — chips at `data[6][153][0]`; per chip:
`token=c[0][0]`, `label=c[1]`, `count=c[3][4] ?? 0`; deduped by `label.toLowerCase()`;
skipped if token/label aren't strings.

`histogramFromPreview` (line 244) — counts at `data[6][175][3]`; must be an array
of length 5 (Google order is 1★→5★); returns it **reversed** to `[5★,4★,3★,2★,1★]`,
else `null`.

`metaFromPreview` (line 302) — reads `data[6]` (returns `{}` if absent);
`canonicalName=six[11]`, `address=six[39]`, `googleRating=six[4][7]`,
`googleReviewCount=six[4][8]`, `category=decodeCategory(six[88][1])`
(`SearchResult.TYPE_ICE_CREAM_SHOP` → `Ice cream shop`).

Test conventions: `bun:test`, files named `*.test.ts` next to the source, excluded
from the package's `tsc` include. Run with `bun test`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Run only the new tests | `bun test packages/gmaps-shared/src/score.test.ts packages/gmaps-shared/src/parse.test.ts` | all pass |
| Run the whole suite | `bun test` | all pass (37 existing + new) |

## Scope

**In scope** (create these two files only):
- `packages/gmaps-shared/src/score.test.ts` (create)
- `packages/gmaps-shared/src/parse.test.ts` (create)

**Out of scope** (do NOT modify):
- `packages/gmaps-shared/src/index.ts` — this is a test-only plan; do not change
  the functions. If a test you wrote from this plan fails because the function
  behaves differently than described, that is a STOP condition (either the plan
  drifted or you found a real bug — report it, don't "fix" either side).
- Any other package.

## Git workflow

- Branch: `advisor/003-scoring-and-parse-tests`
- Commit style `gmaps-shared: …` to match `git log` (e.g. `gmaps-shared: share starString + chip impact-sort across web and extension`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Create `score.test.ts`

Create `packages/gmaps-shared/src/score.test.ts` with exactly:
```ts
import { test, expect, describe } from 'bun:test';
import {
  statsForReviews,
  overallPctFromHistogram,
  overallScoreFromHistogram,
  type Review,
} from './index';

const rv = (stars: number, count: number): Review =>
  ({ reviewId: `r${Math.round(stars * 1000 + count)}`, stars, reviewerReviewCount: count, timestamp: 1_700_000_000_000, text: 'x' });

describe('statsForReviews', () => {
  test('empty → all zero', () => {
    expect(statsForReviews([])).toEqual({ totalReviews: 0, trustedReviews: 0, scorePct: 0 });
  });

  test('only trusted authors (>=3 reviews) score; untrusted count toward total only', () => {
    const s = statsForReviews([rv(5, 9), rv(5, 1)]); // second is untrusted
    expect(s.totalReviews).toBe(2);
    expect(s.trustedReviews).toBe(1);
    expect(s.scorePct).toBe(100); // +1 / 1 trusted
  });

  test('3★ is neutral (does not move the score)', () => {
    const s = statsForReviews([rv(5, 9), rv(3, 9)]);
    expect(s.trustedReviews).toBe(2);
    expect(s.scorePct).toBe(50); // (+1 + 0) / 2 = 0.5 → 50
  });

  test('1★ subtracts; rounding to nearest integer percent', () => {
    const s = statsForReviews([rv(5, 9), rv(5, 9), rv(1, 9)]);
    expect(s.scorePct).toBe(33); // (+1 +1 -1) / 3 = 0.333 → 33
  });

  test('all untrusted → scorePct 0 (no division by zero)', () => {
    expect(statsForReviews([rv(5, 1), rv(1, 2)]).scorePct).toBe(0);
  });
});

describe('overallPctFromHistogram ([5★,4★,3★,2★,1★])', () => {
  test('empty / all-zero → 0', () => {
    expect(overallPctFromHistogram([])).toBe(0);
    expect(overallPctFromHistogram([0, 0, 0, 0, 0])).toBe(0);
  });
  test('all 5★ → 100, all 1★ → -100', () => {
    expect(overallPctFromHistogram([10, 0, 0, 0, 0])).toBe(100);
    expect(overallPctFromHistogram([0, 0, 0, 0, 10])).toBe(-100);
  });
  test('balanced extremes → 0', () => {
    expect(overallPctFromHistogram([5, 0, 0, 0, 5])).toBe(0);
  });
  test('rounds to nearest integer', () => {
    expect(overallPctFromHistogram([3, 1, 1, 1, 1])).toBe(29); // 2/7 = 0.2857 → 29
  });
});

describe('overallScoreFromHistogram (diff·|diff|/total)', () => {
  test('empty → 0', () => {
    expect(overallScoreFromHistogram([])).toBe(0);
    expect(overallScoreFromHistogram([0, 0, 0, 0, 0])).toBe(0);
  });
  test('sign tracks polarity, magnitude scales with the gap', () => {
    expect(overallScoreFromHistogram([10, 0, 0, 0, 0])).toBe(10);   // 10·10/10
    expect(overallScoreFromHistogram([0, 0, 0, 0, 10])).toBe(-10);  // -10·10/10
  });
  test('equal 5★/1★ → 0 regardless of volume', () => {
    expect(overallScoreFromHistogram([5, 0, 0, 0, 5])).toBe(0);
  });
});
```

**Verify**: `bun test packages/gmaps-shared/src/score.test.ts` → all pass.

### Step 2: Create `parse.test.ts`

Create `packages/gmaps-shared/src/parse.test.ts`. The `mkWrapper`/`page` helpers
are copied from `search.test.ts:77-84` and extended for the cases below:
```ts
import { test, expect, describe } from 'bun:test';
import {
  parseReviewsResponse,
  chipsFromPreview,
  histogramFromPreview,
  metaFromPreview,
} from './index';

// Minimal Google listugcposts wire shape parseReviewsResponse reads:
// wrapper[0] = r; r[0]=id, r[1][2]=ts, r[1][4][5][5]=reviewerReviewCount,
// r[2][0][0]=stars, r[2][15]=[ [text, spans?], [translation]? ].
const mkWrapper = (id: string, stars: number, count: number, textEntry?: any[]) => {
  const r1: any = []; r1[2] = 1_700_000_000_000; r1[4] = []; r1[4][5] = []; r1[4][5][5] = count;
  const r2: any = []; r2[0] = [stars]; r2[15] = textEntry ?? [[`text-${id}`]];
  return [[id, r1, r2]];
};
const page = (wrappers: any[], nextCursor: string | null) =>
  ")]}'\n" + JSON.stringify([null, nextCursor, wrappers]);

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
    const r1: any = []; r1[2] = 1; // no r1[4]
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
    const entry = [['great food', [[0, 5]]]]; // slice(0,5) of "great food" = "great"
    const { reviews } = parseReviewsResponse(page([mkWrapper('a', 5, 9, entry)], null));
    expect(reviews[0]!.matchTerms).toEqual(['great']);
  });

  test('skips a wrapper with no stars', () => {
    const r1: any = []; r1[2] = 1; r1[4] = []; r1[4][5] = []; r1[4][5][5] = 9;
    const r2: any = []; r2[15] = [['hi']]; // no r2[0] → stars undefined
    const { reviews } = parseReviewsResponse(page([[['id', r1, r2]]], null));
    expect(reviews).toEqual([]);
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
```

**Verify**: `bun test packages/gmaps-shared/src/parse.test.ts` → all pass.

### Step 3: Whole-suite green

**Verify**: `bun test` → all pass (37 existing + the new tests; expect ~60+ total).

## Test plan

This plan *is* the test plan. Cases cover: trust filtering, neutral 3★, rounding,
zero-division guards (scoring); empty/all-5★/all-1★/rounding (histogram pct &
score); cursor handling, XSSI-prefix strip, malformed-JSON resilience, count
fallback, translation preference, matchTerms offsets, skip-on-missing-stars
(review parse); token/label/count read, case-insensitive dedup, type-skip (chips);
reversal + length guard (histogram); category decode + empty (meta). Pattern
followed: `packages/gmaps-shared/src/search.test.ts`.

## Done criteria

ALL must hold:

- [ ] `packages/gmaps-shared/src/score.test.ts` and `…/parse.test.ts` exist.
- [ ] `bun test packages/gmaps-shared/src/score.test.ts packages/gmaps-shared/src/parse.test.ts` → all pass.
- [ ] `bun test` → all pass, total count increased by the new tests.
- [ ] `packages/gmaps-shared/src/index.ts` is unchanged (`git diff --stat` shows only the two new test files).
- [ ] `plans/README.md` status row for 003 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Any test fails because the function's actual output differs from the expected
  value in this plan. Do NOT edit `index.ts` to make it pass and do NOT silently
  change the expectation — report the function, input, expected, and actual.
  (Either the plan drifted from the code, or you found a real bug.)
- The drift check shows `index.ts` changed since `4a3a843` and the cited function
  bodies no longer match the "Current state" excerpts.

## Maintenance notes

- These are characterization tests: they pin **what the code does today**, which
  is also a partial record of **what Google's RPC currently returns**. If Google
  changes its shape and you update `mkWrapper`/the `data[6][…]` indices in
  `index.ts`, update these builders in lockstep — a failure here is the early
  warning that the shape moved.
- Natural follow-up (not in this plan): `collectPaged` stop-condition tests in
  `packages/gmaps-shared/src/collect.ts` (stabilize / maxPages / abort). Recorded
  in `plans/README.md` under lower-leverage findings.
