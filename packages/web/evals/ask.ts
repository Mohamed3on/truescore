// Agentic eval of Ask (llm.ts ask()): the model reads a place's review sample,
// decides whether to call searchReviews, reads what comes back, and answers.
// Runs the real round loop (runAsk) in-process over ask() for each model in
// candidates.ts, with Search emulated over the place's whole review set the
// way the extension answers it on Maps: reviews matching any term, and their
// TrueScore. Review sets: fixtures/ask-corpora.json (make-ask-fixtures.ts).
//   bun evals/ask.ts            # answers, searches, latency, tokens
//   bun evals/ask.ts --judge    # + blind gpt-5.6-sol scores and ranking per question
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, type ChatTransport } from 'ai';
import { z } from 'zod';
import { compileMatchRegex, expandSearchTerms, runAsk, statsForReviews, textReviewsFor, type AskMessage, type AskSearch, type Review, type SearchReviews } from '@truescore/gmaps-shared';
import { ask, setOnUsage, type Provider, type Subject } from '../llm';
import { registerCandidates } from './candidates';

const JUDGE = process.argv.includes('--judge');
// About what a Maps place's fetched reviews give the extension as the Sample.
const SAMPLE_SIZE = 120;

// `terms` finds the reviews that bear on a question: the judge's evidence and
// the yardstick for search recall. `expect`: 'search' when the sample has
// (almost) nothing on it, 'sample' when the sample already settles it.
type Question = { place: string; q: string; terms: string; expect: 'search' | 'sample' };
const QUESTIONS: Question[] = [
  { place: 'Güerrín', q: 'Do they take credit cards, or is it cash only?', terms: 'cash OR card OR credit OR efectivo OR tarjeta', expect: 'search' },
  { place: 'Güerrín', q: 'Is it safe for someone with celiac disease?', terms: 'gluten OR celiac OR coeliac OR tacc', expect: 'search' },
  { place: 'Güerrín', q: 'Is the moscato worth ordering?', terms: 'moscato OR muscat', expect: 'search' },
  { place: 'Güerrín', q: 'Is the pizza worth the queue?', terms: 'line OR queue OR wait', expect: 'sample' },
  { place: 'Coves del Drach', q: 'Can you do it with a stroller or a wheelchair?', terms: 'wheelchair OR stroller OR pram OR buggy OR mobility', expect: 'search' },
  { place: 'Coves del Drach', q: 'Can I bring my dog?', terms: 'dog OR dogs', expect: 'search' },
  { place: 'Coves del Drach', q: 'Are you allowed to take photos inside?', terms: 'photo OR photos OR camera OR pictures', expect: 'sample' },
  { place: 'Coves del Drach', q: 'Would someone claustrophobic be okay?', terms: 'claustrophobic OR claustrophobia', expect: 'search' },
  { place: "Caru' cu bere", q: 'Do they pad the bill or overcharge tourists?', terms: 'bill OR overcharge OR overcharged OR receipt OR scam', expect: 'search' },
  { place: "Caru' cu bere", q: 'Is smoking allowed anywhere?', terms: 'smoking OR smoke OR smokers', expect: 'search' },
  { place: "Caru' cu bere", q: 'Are the papanasi worth ordering?', terms: 'papanasi', expect: 'sample' },
  { place: "Caru' cu bere", q: 'Is pickpocketing a problem there?', terms: 'pickpocket OR pickpockets OR theft OR stolen', expect: 'search' },
];

const corpora: Record<string, Review[]> = await Bun.file(new URL('./fixtures/ask-corpora.json', import.meta.url)).json();
// A fixed pseudo-random sample, so every model on every run reads the same one.
const seeded = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const shuffled = <T>(xs: T[], seed: number) => {
  const rand = seeded(seed);
  return xs.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
};
const places = Object.fromEntries(Object.entries(corpora).map(([name, reviews]) => {
  const sample = shuffled(reviews, 42).slice(0, SAMPLE_SIZE);
  return [name, { reviews, sample: new Set(sample), sampleTexts: textReviewsFor(sample) }];
}));

const matching = (reviews: Review[], query: string) => {
  const re = compileMatchRegex(expandSearchTerms(query));
  return re ? reviews.filter((r) => r.text.search(re) !== -1) : [];
};
const searchOver = (reviews: Review[]): SearchReviews => async (query) => {
  const matches = matching(reviews, query);
  const { scorePct, trustedReviews } = statsForReviews(matches);
  return { texts: textReviewsFor(matches), scorePct, trustedReviews };
};

// /api/ask without the HTTP hop: the same ask() round, streamed as UI messages.
const transportFor = (subject: Subject, provider: Provider): ChatTransport<AskMessage> => ({
  sendMessages: async ({ messages, abortSignal }) =>
    (await ask(subject, messages, { provider, abortSignal })).toUIMessageStream({ originalMessages: messages, onError: (e) => String((e as Error)?.message ?? e) }),
  reconnectToStream: async () => null,
});

type Tokens = { in: number; out: number };
const tokens = new Map<string, Tokens>();
setOnUsage((u) => {
  const t = tokens.get(u.provider) ?? { in: 0, out: 0 };
  tokens.set(u.provider, { in: t.in + u.inputTokens, out: t.out + u.outputTokens });
});

type Run = { label: string; ms: number; searches: AskSearch[]; text: string; tokens: Tokens; error?: string };
const CONTESTANTS = registerCandidates();
const runs = new Map<Question, Run[]>(QUESTIONS.map((q) => [q, []]));

// Contestants run side by side; each asks its questions one at a time, so the
// token usage reported under its label belongs to the question in flight.
await Promise.all(CONTESTANTS.map(async ({ label, provider }) => {
  for (const question of QUESTIONS) {
    const { reviews, sampleTexts } = places[question.place]!;
    tokens.delete(provider);
    const t0 = performance.now();
    const settled = await runAsk(transportFor({ placeName: question.place, reviewTexts: sampleTexts }, provider), question.q, searchOver(reviews), () => {})
      .then((v) => ({ searches: v.searches, text: v.text.trim() }), (e) => ({ searches: [], text: '', error: String(e?.message ?? e) }));
    const run: Run = { label, ms: performance.now() - t0, tokens: tokens.get(provider) ?? { in: 0, out: 0 }, ...settled };
    runs.get(question)!.push(run);
    console.log(`${label.padEnd(20)} ${(run.ms / 1000).toFixed(1).padStart(5)}s  ${run.searches.length} searches  ${question.q}${run.error ? `  ERROR ${run.error.slice(0, 100)}` : ''}`);
  }
}));

// Of the reviews beyond the sample that bear on the question, the share the
// run's searches reached. Undefined when the sample holds all of them.
const recallOf = (question: Question, run: Run) => {
  const { reviews, sample } = places[question.place]!;
  const wanted = matching(reviews, question.terms).filter((r) => !sample.has(r));
  if (!wanted.length) return undefined;
  const reached = new Set(run.searches.flatMap((s) => matching(reviews, s.query)));
  return wanted.filter((r) => reached.has(r)).length / wanted.length;
};

for (const [question, rs] of runs) {
  console.log(`\n${'='.repeat(72)}\n## ${question.place} — ${question.q} (expect: ${question.expect})\n`);
  for (const r of rs) {
    const searches = r.searches.map((s) => `\`${s.query}\` → ${s.found ?? 'failed'}${s.scorePct != null ? ` (${s.scorePct}% on ${s.trustedReviews})` : ''}`).join(' · ') || 'no searches';
    console.log(`### ${r.label} — ${(r.ms / 1000).toFixed(1)}s, ${r.tokens.in} in / ${r.tokens.out} out\n\n**Searches:** ${searches}\n\n${r.error ? `**ERROR:** ${r.error}` : r.text}\n`);
  }
}

// ── Blind judge: one gpt-5.6-sol call sees every answer to a question at once, with
// the sample and every review the answers could have reached. Two passes in
// opposite orders cancel position bias.
type Scores = { correct: number; complete: number; grounded: number };
const judged = new Map<Question, { scores: Record<string, Scores>; ranking: string[] }[]>();
if (JUDGE) {
  const judgeModel = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('gpt-5.6-sol');
  const judgeSchema = z.object({
    answers: z.array(z.object({ id: z.string(), correct: z.number().int(), complete: z.number().int(), grounded: z.number().int() })),
    ranking: z.array(z.string()),
  });
  const IDS = 'ABCDEFGHIJ';
  const judge = async (question: Question, rs: Run[], order: Run[]) => {
    const { reviews, sample, sampleTexts } = places[question.place]!;
    const bearing = matching(reviews, question.terms);
    const reached = rs.flatMap((r) => r.searches.flatMap((s) => matching(reviews, s.query))).filter((r) => !bearing.includes(r));
    const searchable = [...textReviewsFor(bearing.filter((r) => !sample.has(r))), ...textReviewsFor([...new Set(reached)].filter((r) => !sample.has(r)))].slice(0, 150);
    const { scorePct, trustedReviews } = statsForReviews(bearing);
    const answers = order.map((r, k) => {
      const searches = r.searches.map((s) => `- searchReviews("${s.query}") → ${s.found ?? 'failed'} found${s.scorePct != null ? `, TrueScore ${s.scorePct}% on ${s.trustedReviews} trusted` : ''}`).join('\n') || '- (none)';
      return `## Answer ${IDS[k]}\nSearches:\n${searches}\n\n${r.error ? `(failed: ${r.error})` : r.text}`;
    });
    const { object } = await generateObject({
      model: judgeModel,
      providerOptions: { openai: { reasoningEffort: 'high' } },
      schema: judgeSchema,
      prompt: `Reviews of ${question.place}. SAMPLE is the ${sampleTexts.length} reviews every assistant was given. SEARCHABLE is reviews beyond the sample a search could reach: those mentioning ${question.terms} (${bearing.length} in all, TrueScore ${scorePct}% on ${trustedReviews} trusted reviewers), then whatever the assistants' own searches turned up — ${searchable.length} shown, out of ${reviews.length} reviews in all.\n\nSAMPLE:\n\n${sampleTexts.join('\n\n')}\n\nSEARCHABLE:\n\n${searchable.join('\n\n') || '(none)'}\n\n---\n\nQuestion: "${question.q}"\n\nEach anonymous assistant below answered from the sample, after optionally searching every review. A search returns how many reviews match, their TrueScore (net share of trusted reviewers rating 5★ over 1★, from -100 to 100) and the matching texts beyond the sample. Each answer lists the searches it ran.\n\nScore every answer 1-5 on: correct (its conclusion matches what the reviews as a whole say), complete (it gives the specifics and weight of evidence a reader needs, including what only a search would surface), grounded (nothing invented or contradicted by the reviews; numbers it cites match its searches). A failed answer scores 1 on all three. Then rank every answer from best to worst by id.\n\n${answers.join('\n\n')}`,
    });
    const runOf = (id: string) => order[IDS.indexOf(id.replace(/^answer\s*/i, '').trim().toUpperCase())];
    return {
      scores: Object.fromEntries(object.answers.flatMap(({ id, ...s }) => (runOf(id) ? [[runOf(id)!.label, s]] : []))),
      ranking: object.ranking.flatMap((id) => runOf(id)?.label ?? []),
    };
  };
  const entries = [...runs];
  for (let i = 0; i < entries.length; i += 3) {
    await Promise.all(entries.slice(i, i + 3).map(async ([question, rs], k) => {
      const order = shuffled(rs, i + k);
      const passes = await Promise.all([order, [...order].reverse()].map((o) => judge(question, rs, o).catch((e) => (console.log(`judge failed: ${question.q}: ${e.message?.slice(0, 100)}`), undefined))));
      judged.set(question, passes.flatMap((p) => p ?? []));
    }));
  }
}

// ── Standings
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
console.log(`\n${'='.repeat(72)}\n## standings — ${QUESTIONS.length} questions over ${Object.keys(places).length} places, ${SAMPLE_SIZE}-review sample${JUDGE ? ', gpt-5.6-sol judge (2 orders)' : ''}\n`);
const rows = CONTESTANTS.map(({ label }) => {
  const mine = [...runs].map(([q, rs]) => [q, rs.find((r) => r.label === label)!] as const);
  const searchedWhen = (expect: Question['expect']) => {
    const xs = mine.filter(([q]) => q.expect === expect);
    return `${xs.filter(([, r]) => r.searches.length).length}/${xs.length}`;
  };
  const verdicts = [...judged.values()].flat();
  const scores = verdicts.flatMap((v) => v.scores[label] ?? []);
  const ranks = verdicts.map((v) => v.ranking.indexOf(label) + 1).filter((n) => n > 0);
  const quality = avg(scores.map((s) => s.correct + s.complete + s.grounded));
  return {
    label, quality, rank: avg(ranks),
    line: `- **${label}**${JUDGE ? ` — avg rank ${avg(ranks).toFixed(2)} · #1 ×${ranks.filter((n) => n === 1).length} · correct ${avg(scores.map((s) => s.correct)).toFixed(2)} · complete ${avg(scores.map((s) => s.complete)).toFixed(2)} · grounded ${avg(scores.map((s) => s.grounded)).toFixed(2)} · ${quality.toFixed(2)}/15 ·` : ' —'}` +
      ` searched ${searchedWhen('search')} when needed, ${searchedWhen('sample')} when the sample sufficed · ${avg(mine.map(([, r]) => r.searches.length)).toFixed(1)} searches/ask` +
      ` · recall ${Math.round(avg(mine.flatMap(([q, r]) => recallOf(q, r) ?? [])) * 100)}% · median ${(median(mine.map(([, r]) => r.ms)) / 1000).toFixed(1)}s` +
      ` · ${Math.round(avg(mine.map(([, r]) => r.tokens.in)))} in / ${Math.round(avg(mine.map(([, r]) => r.tokens.out)))} out per ask · errors ${mine.filter(([, r]) => r.error).length}`,
  };
});
for (const r of JUDGE ? rows.sort((a, b) => a.rank - b.rank) : rows) console.log(r.line);

await Bun.write(new URL(`./out/ask-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url), JSON.stringify([...runs].map(([q, rs]) => ({ ...q, runs: rs, judged: judged.get(q) })), null, 1));
