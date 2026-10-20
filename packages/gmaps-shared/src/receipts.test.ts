import { describe, expect, test } from 'bun:test';
import { receiptsFor, type SupportReader } from './receipts';
import type { Answer } from './stance';

// A fake Jev: a review makes a point when it holds the point's last word, and
// answers a rival's question by what it says of "rather".
const reader = (answer: (text: string) => Answer = () => 'none'): SupportReader & { asked: string[][] } => {
  const asked: string[][] = [];
  return {
    asked,
    support: async (points, texts) => points.map((p) => texts.flatMap((t, i) => (t.includes(p.split(' ').at(-1)!) ? [i] : []))),
    answers: async (_q, texts) => { asked.push(texts); return texts.map(answer); },
  };
};

describe('receiptsFor', () => {
  test('each point carries how many reviews make it and the newest of them; one fewer than two make is dropped', async () => {
    const texts = ['[2026-09-01] loved the penguins', '[undated] penguins!', '[2026-09-02] parking was hard', '[2026-09-01] loved the penguins', '[2026-10-01] the penguins again'];
    const r = await receiptsFor(['Loved penguins', 'Hard parking'], texts, [], reader());
    expect(r!.points).toEqual([{ support: 3, quotes: ['the penguins again', 'loved the penguins', 'penguins!'] }, null]);
  });

  test('an alternative stays when two or more reviews prefer it and more do than don\'t', async () => {
    const prefers = reader((t) => (t.includes('rather go') ? 'yes' : t.includes('rather stay') ? 'no' : 'none'));
    const rivals = [
      { name: 'Rival Zoo', texts: ['rather go to Rival Zoo', 'would rather go to Rival Zoo', 'Rival Zoo was fine'] },
      { name: 'Split Zoo', texts: ['rather go to Split Zoo', 'I would rather go to Split Zoo', 'rather stay here than Split Zoo', 'I would rather stay than Split Zoo'] },
      { name: 'Lone Zoo', texts: ['rather go to Lone Zoo'] },
      { name: 'Other Zoo', texts: ['rather go to Other Zoo', 'still rather go to Other Zoo'] },
    ];
    const r = await receiptsFor([], [], rivals, prefers);
    expect(r!.alternatives).toEqual([
      { name: 'Rival Zoo', support: 2, quotes: ['rather go to Rival Zoo', 'would rather go to Rival Zoo'] },
      { name: 'Other Zoo', support: 2, quotes: ['rather go to Other Zoo', 'still rather go to Other Zoo'] },
    ]);
  });

  test('a rival no review names is never asked about; one the reader can\'t read leaves the alternatives unchecked', async () => {
    const quiet = reader();
    expect((await receiptsFor([], [], [{ name: 'Rival Zoo', texts: [] }], quiet))!.alternatives).toEqual([]);
    expect(quiet.asked).toEqual([]);
    const down = { ...reader(), answers: async () => null };
    expect((await receiptsFor([], [], [{ name: 'Rival Zoo', texts: ['rather go to Rival Zoo'] }], down))!.alternatives).toBeUndefined();
  });

  test('null when the points can\'t be checked', async () => {
    expect(await receiptsFor(['Loved penguins'], ['penguins'], [], { ...reader(), support: async () => null })).toBeNull();
  });
});
