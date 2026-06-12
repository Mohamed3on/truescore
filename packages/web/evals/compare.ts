// Side-by-side eval of summarize() across providers on real cached review sets.
//   bun evals/compare.ts            # outputs + latency + tokens
//   bun evals/compare.ts --judge    # adds blind LLM-judge scoring (gpt-5.4)
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';
import { summarize, setOnUsage, PROVIDERS, type Provider, type Summary } from '../llm';
import fixtures from './fixtures.json';

const PROVIDER_LIST = Object.keys(PROVIDERS) as Provider[];
const JUDGE = process.argv.includes('--judge');

type Usage = { provider: Provider; call: string; inputTokens: number; outputTokens: number };
let usages: Usage[] = [];
setOnUsage((u) => usages.push(u));

type Run = { provider: Provider; ms: number; summary: Summary; inputTokens: number; outputTokens: number };

const runOne = async (f: (typeof fixtures)[number], provider: Provider): Promise<Run> => {
  const t0 = performance.now();
  const summary = await summarize(f.place, f.reviewTexts, f.filter ?? undefined, provider);
  const ms = Math.round(performance.now() - t0);
  const mine = usages.filter((u) => u.provider === provider);
  return {
    provider,
    ms,
    summary,
    inputTokens: mine.reduce((a, u) => a + u.inputTokens, 0),
    outputTokens: mine.reduce((a, u) => a + u.outputTokens, 0),
  };
};

const judgeSchema = z.object({
  a: z.object({ grounded: z.number().int(), specific: z.number().int(), useful: z.number().int() }),
  b: z.object({ grounded: z.number().int(), specific: z.number().int(), useful: z.number().int() }),
  winner: z.enum(['A', 'B', 'tie']),
  reason: z.string(),
});

const judgeModel = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('gpt-5.4');

const judgeRuns = async (f: (typeof fixtures)[number], r0: Run, r1: Run, flip: boolean) => {
  const [a, b] = flip ? [r1, r0] : [r0, r1];
  const { object } = await generateObject({
    model: judgeModel,
    schema: judgeSchema,
    prompt: `${f.reviewTexts.join('\n\n')}\n\n---\n\nTwo anonymous models summarized the reviews above for ${f.place}${f.filter ? ` (topic: "${f.filter}")` : ''}. Score each output 1-5 on: grounded (claims traceable to the reviews, nothing invented), specific (concrete details over vague adjectives), useful (helps someone decide). Then pick the overall winner.\n\nOutput A:\n${JSON.stringify(a.summary, null, 1)}\n\nOutput B:\n${JSON.stringify(b.summary, null, 1)}`,
  });
  const label = (x: 'A' | 'B' | 'tie') => (x === 'tie' ? 'tie' : (x === 'A') !== flip ? r0.provider : r1.provider);
  const scores = flip ? { [r0.provider]: object.b, [r1.provider]: object.a } : { [r0.provider]: object.a, [r1.provider]: object.b };
  return { scores, winner: label(object.winner), reason: object.reason };
};

const block = (r: Run) => {
  const s = r.summary;
  const hl = s.highlights.map((h) => `  - (${h.sentiment}) ${h.text}`).join('\n');
  return [
    `### ${r.provider} — ${r.ms}ms, ${r.inputTokens} in / ${r.outputTokens} out`,
    `**Verdict:** ${s.verdict}`,
    `**Highlights:**\n${hl || '  (none)'}`,
    `**Items:** ${(s.items ?? []).join(', ') || '—'}`,
    `**Alternatives:** ${(s.alternatives ?? []).join(', ') || '—'}`,
    `**Value for money:** ${s.valueForMoney}/5`,
  ].join('\n\n');
};

for (const [i, f] of fixtures.entries()) {
  console.log(`\n${'='.repeat(72)}\n## ${f.place}${f.filter ? ` [filter: ${f.filter}]` : ''} — ${f.reviewTexts.length} reviews\n`);
  usages = [];
  const runs = await Promise.all(PROVIDER_LIST.map((p) => runOne(f, p)));
  for (const r of runs) console.log(block(r) + '\n');
  if (JUDGE && runs.length === 2) {
    const { scores, winner, reason } = await judgeRuns(f, runs[0]!, runs[1]!, i % 2 === 1); // alternate A/B order
    const line = Object.entries(scores)
      .map(([p, s]) => `${p}: grounded ${s.grounded}, specific ${s.specific}, useful ${s.useful}`)
      .join(' | ');
    console.log(`### judge (gpt-5.4, blind)\n\n${line}\n\n**Winner:** ${winner} — ${reason}\n`);
  }
}
