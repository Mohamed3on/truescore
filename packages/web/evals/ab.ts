// A/B of a summary change: production summarize() at a baseline git ref against
// the working tree, several runs a place. A second baseline set (base2) is the
// noise band: how far two runs of the same code drift apart, which a real
// change has to clear before it counts. From packages/web:
//   bun evals/ab.ts                        # HEAD vs the working tree, 3 runs a place
//   bun evals/ab.ts --base=<ref> --runs=6 --only=Bar,Sukito --name=v2
//   bun evals/ab.ts --fixture=<file.json>  # adds places: {place, filter, reviewTexts}, or a list
//   bun evals/ab.ts --judge                # compare.ts's blind judge: <name> vs base, base2 vs base
//   bun evals/ab.ts --themes=<file.json>   # {"<place prefix>": {"<theme>": "<regex>"}} → runs covering each
// Writes evals/out/ab/<base sha>/: base.json and base2.json (kept, so a rerun only
// summarizes the working tree), <name>.json, and side-by-side.md to read or judge.
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import * as current from '../llm';
import type { Summary } from '../llm';
import baseFixtures from './fixtures.json';
import { judge, mapPool, type Fixture } from './judge';
import sukito from './sukito';

const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const RUNS = Number(flag('runs') ?? 3);
const NAME = flag('name') ?? 'new';
if (NAME === 'base' || NAME === 'base2') throw new Error(`--name=${NAME} is a baseline set`);
const ONLY = flag('only')?.split(',');
const PROVIDER = current.parseProvider(flag('provider')) ?? 'openai';
const extra: Fixture[] = flag('fixture') ? [await Bun.file(flag('fixture')!).json()].flat() : [];
const fixtures: Fixture[] = [...baseFixtures, sukito, ...extra].filter((f) => !ONLY || ONLY.some((o) => f.place.startsWith(o)));
if (!fixtures.length) throw new Error(`no place starts with ${ONLY}`);

const sha = (await $`git rev-parse ${flag('base') ?? 'HEAD'}`.text()).trim().slice(0, 12);
const OUT = join(import.meta.dir, 'out/ab', sha);
mkdirSync(OUT, { recursive: true });

// The baseline's own llm.ts, from a worktree at the ref. It lives outside the
// package (whose tsconfig would type-check it) and goes when the run ends.
let worktree: string | undefined;
const baseline = async (): Promise<typeof current> => {
  worktree = join(tmpdir(), `truescore-ab-${sha}`);
  if (!existsSync(worktree)) {
    await $`git worktree add --detach ${worktree} ${sha}`.quiet();
    await $`bun install --frozen-lockfile`.cwd(worktree).quiet();
  }
  return import(join(worktree, 'packages/web/llm.ts'));
};

// A set's runs. A baseline set keeps what it already has and makes only the
// missing runs; the working tree's set is made afresh every time.
type Row = { place: string; run: number; summary: Summary };
const runSet = async (set: string, llm: () => Promise<typeof current>, keep: boolean): Promise<Row[]> => {
  const file = Bun.file(join(OUT, `${set}.json`));
  const rows: Row[] = keep && (await file.exists()) ? await file.json() : [];
  const jobs = fixtures.flatMap((f) => Array.from({ length: RUNS }, (_, run) => ({ f, run })))
    .filter(({ f, run }) => !rows.some((r) => r.place === f.place && r.run === run));
  if (jobs.length) {
    const { summarize } = await llm();
    console.log(`${set}: ${jobs.length} summaries`);
    rows.push(...await mapPool(jobs, 6, async ({ f, run }) => ({
      place: f.place, run, summary: await summarize({ placeName: f.place, reviewTexts: f.reviewTexts }, f.filter ?? undefined, PROVIDER),
    })));
    await Bun.write(file, JSON.stringify(rows, null, 1));
  }
  return rows.filter((r) => r.run < RUNS && fixtures.some((f) => f.place === r.place));
};

const sets: Record<string, Row[]> = {};
try {
  sets.base = await runSet('base', baseline, true);
  sets.base2 = await runSet('base2', baseline, true);
  sets[NAME] = await runSet(NAME, async () => current, false);
} finally {
  if (worktree) await $`git worktree remove --force ${worktree}`.quiet().nothrow();
}

const runsOf = (set: string, place: string) => sets[set]!.filter((r) => r.place === place).sort((a, b) => a.run - b.run);
const side = fixtures.map((f) => [
  `## ${f.place}${f.filter ? ` [filter: ${f.filter}]` : ''}`,
  ...Object.keys(sets).map((set) => [`### ${set}`, ...runsOf(set, f.place).map(({ run, summary: s }) => [
    `**run ${run}** · items: ${(s.items ?? []).join(', ') || '—'}`,
    `> ${s.verdict.replace(/\n+/g, ' ')}`,
    ...s.highlights.map((h) => `- (${h.sentiment}) ${h.text}`),
  ].join('\n'))].join('\n\n')),
].join('\n\n'));
await Bun.write(join(OUT, 'side-by-side.md'), side.join('\n\n') + '\n');

for (const [set, rows] of Object.entries(sets)) {
  console.log(`${set.padEnd(8)} ${(rows.reduce((n, r) => n + r.summary.highlights.length, 0) / rows.length).toFixed(2)} bullets a summary`);
}

// Per place and set: how many runs' bullets cover each theme. Write the themes
// from the two baseline sets, before looking at the change.
if (flag('themes')) {
  const themes: Record<string, Record<string, string>> = await Bun.file(flag('themes')!).json();
  for (const [prefix, byTheme] of Object.entries(themes)) {
    for (const [set, all] of Object.entries(sets)) {
      const rows = all.filter((r) => r.place.startsWith(prefix));
      const cover = Object.entries(byTheme).map(([t, re]) => [t, rows.filter((r) => r.summary.highlights.some((h) => new RegExp(re, 'i').test(h.text))).length] as const);
      const pct = rows.length ? cover.reduce((n, [, c]) => n + c, 0) / (rows.length * cover.length) : 0;
      console.log(`${prefix.slice(0, 12).padEnd(12)} ${set.padEnd(8)} n=${rows.length} cover=${Math.round(pct * 100)}% ${cover.map(([t, c]) => `${t}:${c}`).join(' ')}`);
    }
  }
}

// Each of a set's runs judged against the base run of the same place and number,
// the A/B order flipped every other pair to cancel position bias.
const versus = async (set: string) => {
  const pairs = sets[set]!.flatMap((r) => {
    const b = sets.base!.find((x) => x.place === r.place && x.run === r.run);
    return b ? [{ r, b, f: fixtures.find((x) => x.place === r.place)! }] : [];
  });
  const judged = await mapPool(pairs, 4, async ({ r, b, f }, k) => {
    const flip = k % 2 === 1;
    const o = await judge(f, flip ? b.summary : r.summary, flip ? r.summary : b.summary);
    return { mine: flip ? o.b : o.a, theirs: flip ? o.a : o.b, won: o.winner === 'tie' ? 0 : (o.winner === 'A') !== flip ? 1 : -1 };
  });
  const avg = (side: 'mine' | 'theirs', k: 'grounded' | 'coverage' | 'concise') => (judged.reduce((n, j) => n + j[side][k], 0) / judged.length).toFixed(2);
  const count = (won: number) => judged.filter((j) => j.won === won).length;
  return `${count(1)} won, ${count(0)} tied, ${count(-1)} lost · ` + (['grounded', 'coverage', 'concise'] as const).map((k) => `${k} ${avg('mine', k)} vs ${avg('theirs', k)}`).join(' · ');
};
if (process.argv.includes('--judge')) {
  console.log(`\njudge (gpt-6-sol, blind), each run against base:`);
  console.log(`  ${NAME}: ${await versus(NAME)}`);
  console.log(`  base2 (noise band): ${await versus('base2')}`);
}
console.log(`\n${OUT}/side-by-side.md`);
