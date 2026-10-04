import { describe, expect, test } from 'bun:test';
import { chipRowOrder, pooledReads, type ChipState } from './chip-row';
import type { Review } from './index';
import type { StanceCounts } from './stance';

const review = (reviewId: string, stars: number, reviewerReviewCount = 10): Review => ({ reviewId, stars, reviewerReviewCount, timestamp: null, text: 'about the bibimbap' });

describe('pooledReads', () => {
  test('pools both review sets, each review once, with both reads', () => {
    const topic = { reviews: [review('a', 5), review('b', 1)], stances: { a: 'praise', b: 'complain' } as const };
    const standout = { reviews: [review('b', 1), review('c', 5)], stances: { b: 'complain', c: 'praise' } as const };
    expect(pooledReads(topic, standout)).toMatchObject({
      count: 3,
      stance: { praise: 2, complain: 1, mixed: 0, off: 0 },
      of: undefined,
      score: { totalReviews: 3, trustedReviews: 3, scorePct: 33 },
    });
  });

  test('unread unless both sides were read', () => {
    const pooled = pooledReads({ reviews: [review('a', 5)], stances: { a: 'praise' } }, { reviews: [review('b', 5)] });
    expect(pooled.stance).toBeUndefined();
    expect(pooled.stances).toBeUndefined();
  });

  test('says how many trusted reviews there were when only some were read', () => {
    const topic = { reviews: [review('a', 5), review('b', 5), review('c', 5), review('d', 5, 1)], stances: { a: 'praise', b: 'praise' } as const };
    expect(pooledReads(topic, { reviews: [review('a', 5)], stances: { a: 'praise' } }).of).toBe(3);
  });
});

describe('chipRowOrder', () => {
  const chip = (key: string, state: ChipState, scorePct = 0, count = 1, stance?: StanceCounts) => ({ key, state, score: { scorePct }, count, stance });
  const read = (praise: number, complain: number): StanceCounts => ({ praise, complain, mixed: 0, off: 0 });
  const keys = (chips: { key: string }[]) => chips.map((c) => c.key);

  test('keeps its order while anything loads, newcomers joining at the end ranked, loading ones last', () => {
    const chips = [chip('a', 'done', 90), chip('b', 'loading'), chip('c', 'done', 10), chip('d', 'loading'), chip('e', 'done', 100)];
    expect(keys(chipRowOrder(chips, ['b', 'a', 'gone'], false, 50))).toEqual(['b', 'a', 'e', 'c', 'd']);
  });

  test('a first paint while something loads is already ranked', () => {
    const chips = [chip('meh', 'done', 0, 10, read(3, 5)), chip('soon', 'loading'), chip('bbq', 'done', 80, 70, read(63, 5))];
    expect(keys(chipRowOrder(chips, [], false, 50))).toEqual(['bbq', 'meh', 'soon']);
  });

  test('sorts once everything is in, by what reviewers say when every chip is read', () => {
    const chips = [chip('cosy place', 'done', 100, 2, read(2, 0)), chip('meh', 'done', 0, 10, read(3, 5)), chip('failed', 'error'), chip('bbq', 'done', 80, 70, read(63, 5))];
    expect(keys(chipRowOrder(chips, ['cosy place', 'meh', 'failed'], true, 50))).toEqual(['bbq', 'cosy place', 'meh', 'failed']);
  });

  test('by star share against the place while any chip is unread', () => {
    const chips = [chip('a', 'done', 90, 10), chip('b', 'done', 40, 50, read(40, 1)), chip('c', 'done', 60, 5)];
    expect(keys(chipRowOrder(chips, [], true, 50))).toEqual(['a', 'c', 'b']);
  });
});
