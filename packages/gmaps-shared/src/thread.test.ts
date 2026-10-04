import { describe, expect, test } from 'bun:test';
import { countsInTally, threadFromListing } from './thread';

const t1 = (data: Record<string, unknown>, replies: unknown[] = []) => ({
  kind: 't1',
  data: { author: 'someone', score: 1, ...data, replies: replies.length ? { kind: 'Listing', data: { children: replies } } : '' },
});
const listing = (comments: unknown[]) => [
  { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: 'p1', title: 'Best headphones?', selftext: 'Under $300' } }] } },
  { kind: 'Listing', data: { children: comments } },
] as any;

describe('threadFromListing', () => {
  test('flattens the tree with each reply pointing at its parent', () => {
    const thread = threadFromListing(listing([
      t1({ id: 'a', parent_id: 't3_p1', body: 'Sony', score: 9 }, [
        t1({ id: 'b', parent_id: 't1_a', body: 'this' }, [t1({ id: 'c', parent_id: 't1_b', body: 'same' })]),
      ]),
      t1({ id: 'd', parent_id: 't3_p1', body: 'Bose' }),
    ]));
    expect(thread).toMatchObject({ id: 'p1', title: 'Best headphones?', text: 'Under $300' });
    expect(thread.comments.map((c) => [c.id, c.parentId])).toEqual([['a', null], ['b', 'a'], ['c', 'b'], ['d', null]]);
    expect(thread.comments[0]!.score).toBe(9);
  });

  test("skips load-more stubs and deleted bodies, keeping a deleted comment's replies", () => {
    const thread = threadFromListing(listing([
      t1({ id: 'a', parent_id: 't3_p1', body: '[deleted]', author: '[deleted]' }, [t1({ id: 'b', parent_id: 't1_a', body: 'Sony' })]),
      t1({ id: 'r', parent_id: 't3_p1', body: '[removed]' }),
      { kind: 'more', data: { id: 'm', count: 40, children: ['x', 'y'] } },
    ]));
    expect(thread.comments.map((c) => c.id)).toEqual(['b']);
  });

  test("marks AutoModerator's, stickied and moderator-distinguished comments as bots", () => {
    const thread = threadFromListing(listing([
      t1({ id: 'a', parent_id: 't3_p1', body: 'rules', author: 'AutoModerator' }),
      t1({ id: 'b', parent_id: 't3_p1', body: 'pinned', stickied: true }),
      t1({ id: 'c', parent_id: 't3_p1', body: 'mod note', distinguished: 'moderator' }),
      t1({ id: 'd', parent_id: 't3_p1', body: 'Sony' }),
    ]));
    expect(thread.comments.map((c) => !!c.bot)).toEqual([true, true, true, false]);
  });
});

describe('countsInTally', () => {
  test("a bot's comment and one voted to 0 or below don't count", () => {
    const c = { id: 'a', parentId: null, author: 'u', body: 'x' };
    expect(countsInTally({ ...c, score: 1 })).toBe(true);
    expect(countsInTally({ ...c, score: 0 })).toBe(false);
    expect(countsInTally({ ...c, score: 5, bot: true })).toBe(false);
  });
});
