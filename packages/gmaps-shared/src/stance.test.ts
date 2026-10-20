import { describe, expect, test } from 'bun:test';
import { answersOf, countAnswers, countStances, MAX_JUDGED, opinionPct, opinionTone, opinionsOf, signedNet, trustedStance, type Stance } from './stance';
import { reviewMark, type Review } from './index';

describe('countStances', () => {
  test('tallies every stance, skipping unread ones', () => {
    expect(countStances(['praise', 'complain', 'praise', null, 'off', undefined, 'mixed'])).toEqual({ praise: 2, complain: 1, mixed: 1, off: 1 });
  });
});

describe('opinionsOf', () => {
  test('share positive and net of those taking a side, with the rest spelled out for the tooltip', () => {
    const o = opinionsOf({ praise: 4, complain: 18, mixed: 3, off: 5 });
    expect(o).toMatchObject({ pos: 4, neg: 18, net: -14, share: 18, posWord: 'praise', negWord: 'complain', mentions: 25, sparse: false });
    expect(o.title).toBe('4 praise · 18 complain · 3 mixed or neutral · 5 not about it');
  });

  test('fewer than two opinions is sparse: a split would look surer than it is', () => {
    expect(opinionsOf({ praise: 1, complain: 0, mixed: 1, off: 0 })).toMatchObject({ sparse: true, mentions: 2 });
  });

  test('says how many it covers when only some reviews were read', () => {
    expect(opinionsOf({ praise: 600, complain: 300, mixed: 100, off: 0 }, 2400).title).toBe('600 praise · 300 complain · 100 mixed or neutral · 1000 of 2400 checked');
    expect(opinionsOf({ praise: 2, complain: 1, mixed: 0, off: 0 }, 3).title).toBe('2 praise · 1 complain');
  });

  test('tone follows the share positive; the sort key is the net share', () => {
    const o = opinionsOf({ praise: 4, complain: 12, mixed: 0, off: 0 });
    expect(opinionTone(o)).toBe('neg');
    expect(opinionTone(opinionsOf({ praise: 4, complain: 1, mixed: 0, off: 0 }))).toBe('pos');
    expect(opinionTone(opinionsOf({ praise: 53, complain: 16, mixed: 0, off: 0 }))).toBe('mid');
    expect(opinionTone(opinionsOf({ praise: 5, complain: 5, mixed: 0, off: 0 }))).toBe('mid');
    expect(opinionPct(o)).toBe(-50);
    expect(opinionPct(opinionsOf({ praise: 0, complain: 0, mixed: 3, off: 0 }))).toBe(0);
    expect([signedNet(37), signedNet(-5), signedNet(0)]).toEqual(['+37', '−5', '0']);
  });
});

describe('answersOf', () => {
  test('yes then no; reviews that never say count as no mention', () => {
    const o = answersOf(countAnswers(['yes', 'yes', 'no', 'none', 'unclear']));
    expect(o).toMatchObject({ pos: 2, neg: 1, net: 1, share: 67, posWord: 'yes', negWord: 'no', mentions: 4, sparse: false });
    expect(o.title).toBe("2 yes · 1 no · 1 unclear · 1 don't say");
  });
});

describe('reviewMark', () => {
  test("a read review shows its stance; an untrusted author's, never read, says why", () => {
    expect(reviewMark('praise', 7)).toMatchObject({ cls: 'praise', text: '▲', label: 'Praises it' });
    expect(reviewMark('complain', 7, 'bibimbap')?.label).toBe('Complains about bibimbap');
    expect(reviewMark('mixed')?.text).toBe('●');
    expect(reviewMark(undefined, 1)).toMatchObject({ cls: 'untrusted', text: 'untrusted · 1 review' });
    expect(reviewMark(undefined, 2)?.text).toBe('untrusted · 2 reviews');
    expect(reviewMark(undefined, 7)).toBeNull();
  });
});

describe('trustedStance', () => {
  const review = (reviewId: string, text: string, reviewerReviewCount = 10): Review => ({ reviewId, stars: 5, reviewerReviewCount, timestamp: null, text });
  const reader = (reachable = true) => {
    const read: string[][] = [];
    const stances = async (_topic: string, texts: string[]) => { read.push(texts); return texts.map((t): Stance => (t.includes('bad') ? 'complain' : 'praise')); };
    return { read, reader: { reachable: () => reachable, stances } };
  };

  test('reads only the trusted reviews with text — the ones TrueScore counts — keyed by reviewId', async () => {
    const { read, reader: r } = reader();
    const result = await trustedStance('parking', [review('a', 'great parking'), review('b', 'bad parking'), review('c', 'bad parking too', 1), review('d', '')], r);
    expect(read).toEqual([['great parking', 'bad parking']]);
    expect(result).toEqual({ stance: { praise: 1, complain: 1, mixed: 0, off: 0 }, stances: { a: 'praise', b: 'complain' } });
  });

  test('nothing readable reads as zero when Jev is reachable, and as unread when not', async () => {
    const { read, reader: r } = reader();
    expect(await trustedStance('parking', [review('a', 'great parking', 1)], r)).toEqual({ stance: { praise: 0, complain: 0, mixed: 0, off: 0 }, stances: {} });
    expect(read).toEqual([]);
    expect(await trustedStance('parking', [], reader(false).reader)).toBeNull();
  });

  test(`past ${MAX_JUDGED} it reads the first and says how many there were`, async () => {
    const { read, reader: r } = reader();
    const reviews = Array.from({ length: MAX_JUDGED + 5 }, (_, i) => review(`r${i}`, `great ${i}`));
    expect((await trustedStance('parking', reviews, r))!.of).toBe(MAX_JUDGED + 5);
    expect(read[0]).toHaveLength(MAX_JUDGED);
  });
});
