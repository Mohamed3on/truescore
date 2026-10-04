import { beforeEach, describe, expect, test } from 'bun:test';
import type { Thread, ThreadComment } from '@truescore/gmaps-shared';
import { setJevClient } from './jev';
import { combine, countOf, naming, tallyOption, threadOf } from './tally';

let n = 0;
const comment = (id: string, body: string, more: Partial<ThreadComment> = {}): ThreadComment =>
  ({ id, parentId: null, author: `u-${id}`, score: 1, body, ...more });
const threadWith = (comments: ThreadComment[], title = `Best headphones? #${++n}`): Thread => ({ id: `t${n}`, title, text: '', comments });

describe('naming', () => {
  test('finds a name whole, in any case, possessive or link slug', () => {
    const thread = threadWith([
      comment('a', "Sony's are great"),
      comment('b', 'see [this](https://shop.example/products/xm5-by-sony-japan)'),
      comment('c', 'SONY all day'),
      comment('d', 'Sonyx is a different brand'),
    ]);
    expect(naming(thread, ['Sony']).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  test('a reply below a comment naming it speaks of it too, as does an answer to a post that names it', () => {
    const thread = threadWith([
      comment('a', 'Bose QC'),
      comment('b', 'this', { parentId: 'a' }),
      comment('c', 'agreed', { parentId: 'b' }),
      comment('d', 'Sennheiser'),
      comment('e', 'this', { parentId: 'd' }),
      comment('f', 'this', { parentId: 'gone' }),
    ]);
    expect(naming(thread, ['Bose']).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    const asked = threadWith([comment('a', 'go for the first')], 'Bose or Sony?');
    expect(naming(asked, ['Bose']).map((c) => c.id)).toEqual(['a']);
  });

  test("only counted comments are read, though an uncounted one still lends its name to replies", () => {
    const thread = threadWith([
      comment('a', 'Bose', { score: 0 }),
      comment('b', 'this', { parentId: 'a', score: 4 }),
      comment('c', 'Bose', { bot: true }),
    ]);
    expect(naming(thread, ['Bose']).map((c) => c.id)).toEqual(['b']);
  });
});

describe('combine', () => {
  test('agreeing reads keep their side, disagreeing ones or mere mentions are mixed', () => {
    expect(combine(['praise', 'mixed', undefined])).toBe('praise');
    expect(combine(['complain', 'complain'])).toBe('complain');
    expect(combine(['praise', 'complain'])).toBe('mixed');
    expect(combine(['mixed'])).toBe('mixed');
    expect(combine([undefined, 'off'])).toBeUndefined();
  });
});

describe('countOf', () => {
  test('each commenter once, however many comments; deleted accounts each their own; upvotes per comment', () => {
    const thread = threadWith([
      comment('a', '', { author: 'x', score: 10 }),
      comment('b', '', { author: 'x', score: 3 }),
      comment('c', '', { author: 'y', score: 2 }),
      comment('d', '', { author: 'y', score: 1 }),
      comment('e', '', { author: '[deleted]', score: 4 }),
      comment('f', '', { author: '[deleted]', score: 5 }),
      comment('g', '', { author: 'z', score: 7 }),
    ]);
    expect(countOf(thread, { a: 'praise', b: 'praise', c: 'praise', d: 'complain', e: 'complain', f: 'complain', g: 'mixed' }))
      .toEqual({ for: 1, against: 2, mixed: 2, upFor: 15, upAgainst: 10 });
  });
});

describe('threadOf', () => {
  test('keeps a well-formed thread and drops malformed comments', () => {
    const thread = threadOf({ id: 'p', title: 'Q', text: 5, comments: [{ id: 'a', body: 'Sony', score: 3, author: 'u', parentId: null }, { id: 'b' }, null] });
    expect(thread).toEqual({ id: 'p', title: 'Q', text: '', comments: [{ id: 'a', parentId: null, author: 'u', score: 3, body: 'Sony' }] });
    expect(threadOf({ id: 'p' })).toBeNull();
  });
});

// A fake Jev reading each comment by a rule; a reply reads through its parent.
type Req = { state: any; questions: Record<string, any> };
let requests: Req[] = [];
const verdict = (text: string) => (/awful|bad/.test(text) ? 'complain' : /great|best/.test(text) ? 'praise' : /^(this|same)\b/.test(text) ? 'agree' : 'off');
beforeEach(() => {
  requests = [];
  setJevClient({
    systemOne: (req: Req) => {
      requests.push(req);
      const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
        const own = verdict(q.instructions.comment);
        return [id, { choice: own === 'agree' ? verdict(q.instructions.replying_to ?? '') : own }];
      }));
      return Promise.resolve({ answers, usage: { input_tokens: 100, output_tokens: 0 }, model: 'jev-test' }) as any;
    },
  } as any);
});

describe('tallyOption', () => {
  test("a title's stance counts for its maker, replies read with their parent, each commenter once", async () => {
    const thread = threadWith([
      comment('a', 'The XM5 are great', { author: 'x', score: 5 }),
      comment('b', 'this', { author: 'y', parentId: 'a', score: 3 }),
      comment('c', 'Sony is bad for travel', { author: 'x', score: 1 }),
      comment('d', 'Bose is the best', { author: 'z', score: 2 }),
    ]);
    const sony = { name: 'Sony', aliases: [], titles: [{ name: 'WH-1000XM5', aliases: ['XM5'] }] };
    const t = await tallyOption(thread, 'Best headphones?', sony);
    expect(t).toMatchObject({ key: 'sony', name: 'Sony', reads: { a: 'praise', b: 'praise', c: 'complain' } });
    // x praised the XM5 and complained of Sony: mixed on Sony, for the XM5.
    expect(t!.count).toEqual({ for: 1, against: 0, mixed: 1, upFor: 8, upAgainst: 1 });
    expect(t!.titles).toEqual([{ key: 'sony/wh-1000xm5', name: 'WH-1000XM5', count: { for: 2, against: 0, mixed: 0, upFor: 8, upAgainst: 0 }, reads: { a: 'praise', b: 'praise' } }]);
    const asked = requests.flatMap((r) => Object.values(r.questions).map((q) => q.instructions));
    expect(asked.find((q) => q.comment === 'this')?.replying_to).toBe('The XM5 are great');
    expect(asked.find((q) => q.comment === 'The XM5 are great')).not.toHaveProperty('replying_to');
    expect(asked.some((q) => q.comment === 'Bose is the best')).toBe(false);
    expect(requests[0]!.state.option).toContain('WH-1000XM5');
  });

  test("two makers' titles of one name are read apart", async () => {
    const thread = threadWith([comment('a', 'Pressure Passing by Lovato is great, Pressure Passing by Schreiner is bad')]);
    await tallyOption(thread, 'q', { name: 'Lovato', aliases: [], titles: [{ name: 'Pressure Passing', aliases: [] }] });
    requests = [];
    await tallyOption(thread, 'q', { name: 'Schreiner', aliases: [], titles: [{ name: 'Pressure Passing', aliases: [] }] });
    // Schreiner's own read and his title's: none borrowed from Lovato's.
    expect(requests.flatMap((r) => Object.keys(r.questions))).toHaveLength(2);
  });
});
