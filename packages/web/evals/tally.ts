// Eval for a Reddit Thread's Tally: the production pipeline (web/tally.ts, its
// listing prompt in llm.ts and Jev's reads in jev.ts) over hand-labelled
// threads, graded by code against the labels. No judge. Each fixture
// (fixtures/reddit/*.json) holds the page's raw `.json` listing, what each
// comment says of each Option (`labels`), and every way the thread writes each
// Option (`aliases`); the expected Tally is counted from the labels by the same
// countOf the server uses.
//
//   bun evals/tally.ts                     # every fixture, on the production model
//   bun evals/tally.ts --fixture=1p54awz   # just fixtures whose name contains it
//   bun evals/tally.ts --provider=gemini   # the listing on another provider
//   bun evals/tally.ts --why               # + each comment the reads and the labels disagree on
//
// Needs OPENAI_API_KEY (or the provider's key) and TYPESAFE_API_KEY. Runs on a
// fresh sqlite file, so nothing listed or read before is reused.
import { readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stripAccents, threadFromListing, type OptionTally, type Stance, type TallyCount, type TallyEvent, type Thread } from '@truescore/gmaps-shared';

process.env.TRUESCORE_CACHE_DB_PATH = join(tmpdir(), `truescore-tally-eval-${process.pid}.sqlite`);
const { combine, countOf, tallyThread } = await import('../tally');
const { spent } = await import('../jev');
const { setOnUsage } = await import('../llm');

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const provider = (arg('provider') ?? 'openai') as 'openai' | 'gemini' | 'deepseek';
const DIR = join(import.meta.dir, 'fixtures/reddit');

type Label = { option: string; title: string | null; stance: Exclude<Stance, 'off'> };
type Fixture = { url: string; listing: any; labels: Record<string, Label[]>; aliases: Record<string, string[]> };

const words = (s: string) => stripAccents(s.toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
const speakers = (c: TallyCount) => c.for + c.against + c.mixed;
const net = (c: TallyCount) => c.for - c.against;

// The labels counted as the server counts Jev's reads: what each counted comment
// says of each Option, its titles' stances included.
const expectedOf = (thread: Thread, labels: Record<string, Label[]>) => {
  const counted = new Set(thread.comments.filter((c) => !c.bot && c.score >= 1).map((c) => c.id));
  const byOption = new Map<string, Record<string, Stance[]>>();
  for (const [id, ls] of Object.entries(labels)) {
    if (!counted.has(id)) continue;
    for (const l of ls) ((byOption.get(l.option) ?? byOption.set(l.option, {}).get(l.option)!)[id] ??= []).push(l.stance);
  }
  return [...byOption].map(([name, said]) => {
    const reads = Object.fromEntries(Object.entries(said).map(([id, s]) => [id, combine(s)!]));
    return { name, reads, count: countOf(thread, reads) };
  });
};

// A listed Option is the labelled one when their names, or a name and one of
// the thread's ways of writing it, are the same words, or one holds the other
// whole ("Rafael Lovato Jr." and "Rafael Lovato").
const sameThing = (produced: string, names: string[]) => {
  const p = ` ${words(produced)} `;
  return names.map(words).filter((n) => n.length > 2).some((n) => p.trim() === n || p.includes(` ${n} `) || ` ${n} `.includes(p));
};

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const fmt = (c?: TallyCount) => (c ? `${c.for}-${c.against}${c.mixed ? ` (${c.mixed}m)` : ''}` : '—');

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && (!arg('fixture') || f.includes(arg('fixture')!)));
const totals = { expected: 0, found: 0, extra: 0, countErr: 0, top1: 0, top5: 0, threads: 0 };
let llmIn = 0, llmOut = 0;
setOnUsage((u) => { llmIn += u.inputTokens; llmOut += u.outputTokens; });

for (const file of files) {
  const fx: Fixture = await Bun.file(join(DIR, file)).json();
  const thread = threadFromListing(fx.listing);
  const expected = expectedOf(thread, fx.labels).filter((o) => speakers(o.count) >= 2).sort((a, b) => net(b.count) - net(a.count) || a.count.against - b.count.against);
  const t0 = performance.now();
  let listedAt = 0;
  const produced: OptionTally[] = [];
  let error = '';
  await tallyThread(thread, (e: TallyEvent) => {
    if (e.type === 'listed' && !listedAt) listedAt = performance.now() - t0;
    if (e.type === 'option') produced.push(e.option);
  }, { provider }).catch((e) => { error = e instanceof Error ? e.message : String(e); });
  const took = performance.now() - t0;

  const used = new Set<OptionTally>();
  const rows = expected.map((o) => {
    const names = [o.name, ...(fx.aliases[o.name] ?? [])];
    const match = produced.filter((p) => !used.has(p) && sameThing(p.name, names))
      .sort((a, b) => speakers(b.count) - speakers(a.count))[0];
    if (match) used.add(match);
    return { o, match };
  });
  const extra = produced.filter((p) => !used.has(p) && speakers(p.count) >= 2);
  const ranked = [...produced].filter((p) => speakers(p.count) >= 2).sort((a, b) => net(b.count) - net(a.count) || a.count.against - b.count.against);
  const top = (n: number) => new Set(ranked.slice(0, n));
  const found = rows.filter((r) => r.match);
  const countErr = found.reduce((s, { o, match }) => s + Math.abs(o.count.for - match!.count.for) + Math.abs(o.count.against - match!.count.against), 0);
  const top5 = rows.slice(0, 5).filter((r) => r.match && top(5).has(r.match)).length;
  const top1 = rows[0]?.match && ranked[0] === rows[0].match ? 1 : 0;

  console.log(`\n${file}: ${thread.title}`);
  console.log(`  ${thread.comments.length} comments · first option at ${(listedAt / 1000).toFixed(1)}s · done in ${(took / 1000).toFixed(1)}s · ${produced.length} options listed${error ? ` · ERROR ${error}` : ''}`);
  console.log(`  ${pad('expected option (people for-against)', 44)}${pad('expected', 10)}${pad('produced', 12)}as`);
  for (const { o, match } of rows) console.log(`  ${pad(o.name, 44)}${pad(fmt(o.count), 10)}${pad(fmt(match?.count), 12)}${match?.name ?? 'MISSING'}`);
  for (const p of extra) console.log(`  ${pad('(not labelled)', 44)}${pad('', 10)}${pad(fmt(p.count), 12)}${p.name}`);
  if (process.argv.includes('--why')) {
    const byId = new Map(thread.comments.map((c) => [c.id, c]));
    for (const { o, match } of found) {
      const ids = new Set([...Object.keys(o.reads), ...Object.keys(match!.reads)]);
      for (const id of ids) {
        const want = o.reads[id], got = match!.reads[id];
        if (want === got) continue;
        const c = byId.get(id)!;
        const parent = c.parentId ? byId.get(c.parentId)?.body : undefined;
        console.log(`    ${o.name}: labelled ${want ?? 'off'}, read ${got ?? 'off'} · "${c.body.replace(/\s+/g, ' ').slice(0, 160)}"${parent ? ` ← "${parent.replace(/\s+/g, ' ').slice(0, 80)}"` : ''}`);
      }
    }
  }
  console.log(`  found ${found.length}/${rows.length} · count error ${countErr} people · #1 ${top1 ? 'right' : 'WRONG'} · top-5 overlap ${top5}/${Math.min(5, rows.length)}`);
  Object.assign(totals, {
    expected: totals.expected + rows.length, found: totals.found + found.length, extra: totals.extra + extra.length,
    countErr: totals.countErr + countErr, top1: totals.top1 + top1, top5: totals.top5 + top5, threads: totals.threads + 1,
  });
}

const jevTokens = Object.values(spent).reduce((a, n) => a + n, 0);
console.log(`\n${totals.threads} threads · options found ${totals.found}/${totals.expected} · unlabelled extras ${totals.extra} · count error ${totals.countErr} people · #1 right ${totals.top1}/${totals.threads} · top-5 overlap ${totals.top5}`);
console.log(`cost: LLM ${llmIn} in / ${llmOut} out tokens (${provider}) · Jev ${jevTokens} in tokens ($${((jevTokens * 0.042) / 1e6).toFixed(4)})`);
