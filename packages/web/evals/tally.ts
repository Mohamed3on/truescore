// Eval for a Reddit Thread's Tally: the production pipeline (web/tally.ts, its
// listing prompt in llm.ts and Jev's reads in jev.ts) over hand-labelled
// threads, graded by code against the labels. No judge. Each fixture
// (fixtures/reddit/*.json) holds the page's raw `.json` listing, what each
// comment says of each Option (`labels`), and every way the thread writes each
// Option (`aliases`); the expected Tally is counted from the labels by the same
// countOf the server uses, for each Option and each of its titles.
//
//   bun evals/tally.ts                     # every fixture, on the production model
//   bun evals/tally.ts --fixture=1p54awz   # just fixtures whose name contains it
//   bun evals/tally.ts --provider=gemini   # the listing on another provider
//   bun evals/tally.ts --why               # + each comment the reads and the labels disagree on
//   bun evals/tally.ts --db=/tmp/ab.sqlite # reuse a run's listings and reads: a
//                                          # second run re-reads only what changed
//
// Needs OPENAI_API_KEY (or the provider's key) and TYPESAFE_API_KEY. Runs on a
// fresh sqlite file unless --db names one, so nothing listed or read before is
// reused.
import { readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stripAccents, threadFromListing, type OptionTally, type Stance, type TallyCount, type TallyEvent, type Thread, type TitleTally } from '@truescore/gmaps-shared';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
process.env.TRUESCORE_CACHE_DB_PATH = arg('db') ?? join(tmpdir(), `truescore-tally-eval-${process.pid}.sqlite`);
const { combine, countOf, tallyThread } = await import('../tally');
const { spent } = await import('../jev');
const { setOnUsage } = await import('../llm');

const provider = (arg('provider') ?? 'openai') as 'openai' | 'gemini' | 'deepseek';
const DIR = join(import.meta.dir, 'fixtures/reddit');

type Label = { option: string; title: string | null; stance: Exclude<Stance, 'off'> };
type Fixture = { url: string; listing: any; labels: Record<string, Label[]>; aliases: Record<string, string[]> };

const words = (s: string) => stripAccents(s.toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
const speakers = (c: TallyCount) => c.for + c.against + c.mixed;
const net = (c: TallyCount) => c.for - c.against;

// The labels counted as the server counts Jev's reads: what each counted comment
// says of each thing `subject` names, an Option (its titles' stances included)
// or a title, among those named by two people or more, ranked.
const expectedOf = (thread: Thread, labels: Record<string, Label[]>, subject: (l: Label) => string | null) => {
  const counted = new Set(thread.comments.filter((c) => !c.bot && c.score >= 1).map((c) => c.id));
  const bySubject = new Map<string, Record<string, Stance[]>>();
  for (const [id, ls] of Object.entries(labels)) {
    if (!counted.has(id)) continue;
    for (const l of ls) { const k = subject(l); if (k) ((bySubject.get(k) ?? bySubject.set(k, {}).get(k)!)[id] ??= []).push(l.stance); }
  }
  return [...bySubject].map(([name, said]) => {
    const reads = Object.fromEntries(Object.entries(said).map(([id, s]) => [id, combine(s)!]));
    return { name, reads, count: countOf(thread, reads) };
  }).filter((o) => speakers(o.count) >= 2).sort((a, b) => net(b.count) - net(a.count) || a.count.against - b.count.against);
};

// A listed Option is the labelled one when their names, or a name and one of
// the thread's ways of writing it, are the same words, or one holds the other
// whole ("Rafael Lovato Jr." and "Rafael Lovato").
const sameThing = (produced: string, names: string[]) => {
  const p = ` ${words(produced)} `;
  return names.map(words).filter((n) => n.length > 2).some((n) => p.trim() === n || p.includes(` ${n} `) || ` ${n} `.includes(p));
};

// Produced titles read as one: what each comment says of any of them, together.
const asOne = (thread: Thread, ts: TitleTally[]): TitleTally | undefined => {
  if (ts.length < 2) return ts[0];
  const reads = Object.fromEntries([...new Set(ts.flatMap((t) => Object.keys(t.reads)))].map((id) => [id, combine(ts.map((t) => t.reads[id]))!]));
  return { key: ts.map((t) => t.key).join('+'), name: ts.map((t) => t.name).join(' + '), reads, count: countOf(thread, reads) };
};

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const fmt = (c?: TallyCount) => (c ? `${c.for}-${c.against}${c.mixed ? ` (${c.mixed}m)` : ''}` : '—');

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && (!arg('fixture') || f.includes(arg('fixture')!)));
const totals = { expected: 0, found: 0, extra: 0, countErr: 0, readErr: 0, top1: 0, top5: 0, threads: 0, titles: 0, titlesFound: 0, titleErr: 0 };
let llmIn = 0, llmOut = 0;
setOnUsage((u) => { llmIn += u.inputTokens; llmOut += u.outputTokens; });

for (const file of files) {
  const fx: Fixture = await Bun.file(join(DIR, file)).json();
  const thread = threadFromListing(fx.listing);
  const expected = expectedOf(thread, fx.labels, (l) => l.option);
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
  // Each labelled title, sought among its Option's match's titles: the one of
  // its name, or else all those naming it, read as one (a listing that split a
  // "Donkey" into Donkey 5 and Donkey 6).
  const titleRows = new Map(rows.map(({ o, match }) => [o, expectedOf(thread, fx.labels, (l) => (l.option === o.name ? l.title : null)).map((t) => {
    const named = match?.titles.filter((p) => sameThing(p.name, [t.name, ...(fx.aliases[`${o.name} / ${t.name}`] ?? [])])) ?? [];
    const own = named.filter((p) => words(p.name) === words(t.name));
    return { o: t, match: asOne(thread, own.length ? own : named) };
  })]));
  const titles = [...titleRows.values()].flat();
  const extra = produced.filter((p) => !used.has(p) && speakers(p.count) >= 2);
  const ranked = [...produced].filter((p) => speakers(p.count) >= 2).sort((a, b) => net(b.count) - net(a.count) || a.count.against - b.count.against);
  const top = (n: number) => new Set(ranked.slice(0, n));
  const found = rows.filter((r) => r.match);
  const titlesFound = titles.filter((r) => r.match);
  const errOf = (rs: { o: { count: TallyCount }; match?: { count: TallyCount } }[]) =>
    rs.reduce((s, { o, match }) => s + Math.abs(o.count.for - match!.count.for) + Math.abs(o.count.against - match!.count.against), 0);
  const countErr = errOf(found), titleErr = errOf(titlesFound);
  const top5 = rows.slice(0, 5).filter((r) => r.match && top(5).has(r.match)).length;
  const top1 = rows[0]?.match && ranked[0] === rows[0].match ? 1 : 0;

  console.log(`\n${file}: ${thread.title}`);
  console.log(`  ${thread.comments.length} comments · first option at ${(listedAt / 1000).toFixed(1)}s · done in ${(took / 1000).toFixed(1)}s · ${produced.length} options listed${error ? ` · ERROR ${error}` : ''}`);
  console.log(`  ${pad('expected option (people for-against)', 44)}${pad('expected', 10)}${pad('produced', 12)}as`);
  for (const { o, match } of rows) {
    console.log(`  ${pad(o.name, 44)}${pad(fmt(o.count), 10)}${pad(fmt(match?.count), 12)}${match?.name ?? 'MISSING'}`);
    for (const t of titleRows.get(o)!) console.log(`    ${pad(t.o.name, 42)}${pad(fmt(t.o.count), 10)}${pad(fmt(t.match?.count), 12)}${t.match?.name ?? 'MISSING'}`);
  }
  for (const p of extra) console.log(`  ${pad('(not labelled)', 44)}${pad('', 10)}${pad(fmt(p.count), 12)}${p.name}`);
  // Every read the labels disagree with, among the Options and titles found:
  // in a count, a wrong read for and another against cancel out.
  const byId = new Map(thread.comments.map((c) => [c.id, c]));
  let readErr = 0;
  for (const { o, match } of [...found, ...titlesFound]) {
    for (const id of new Set([...Object.keys(o.reads), ...Object.keys(match!.reads)])) {
      const want = o.reads[id], got = match!.reads[id];
      if (want === got) continue;
      readErr++;
      if (!process.argv.includes('--why')) continue;
      const c = byId.get(id)!;
      const parent = c.parentId ? byId.get(c.parentId)?.body : undefined;
      console.log(`    ${o.name}: labelled ${want ?? 'off'}, read ${got ?? 'off'} · "${c.body.replace(/\s+/g, ' ').slice(0, 160)}"${parent ? ` ← "${parent.replace(/\s+/g, ' ').slice(0, 80)}"` : ''}`);
    }
  }
  console.log(`  found ${found.length}/${rows.length} · count error ${countErr} people · ${readErr} reads wrong · #1 ${top1 ? 'right' : 'WRONG'} · top-5 overlap ${top5}/${Math.min(5, rows.length)} · titles found ${titlesFound.length}/${titles.length}, count error ${titleErr} people`);
  Object.assign(totals, {
    expected: totals.expected + rows.length, found: totals.found + found.length, extra: totals.extra + extra.length,
    countErr: totals.countErr + countErr, readErr: totals.readErr + readErr, top1: totals.top1 + top1, top5: totals.top5 + top5, threads: totals.threads + 1,
    titles: totals.titles + titles.length, titlesFound: totals.titlesFound + titlesFound.length, titleErr: totals.titleErr + titleErr,
  });
}

const jevTokens = Object.values(spent).reduce((a, n) => a + n, 0);
console.log(`\n${totals.threads} threads · options found ${totals.found}/${totals.expected} · unlabelled extras ${totals.extra} · count error ${totals.countErr} people · ${totals.readErr} reads wrong · #1 right ${totals.top1}/${totals.threads} · top-5 overlap ${totals.top5}`);
console.log(`titles found ${totals.titlesFound}/${totals.titles} · count error ${totals.titleErr} people`);
console.log(`cost: LLM ${llmIn} in / ${llmOut} out tokens (${provider}) · Jev ${jevTokens} in tokens ($${((jevTokens * 0.042) / 1e6).toFixed(4)})`);
