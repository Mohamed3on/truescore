// The blind pairwise judge the summary evals share (compare.ts, ab.ts), and the
// bounded pool they run it in.
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { Summary } from '../llm';

export type Fixture = { place: string; filter: string | null; reviewTexts: string[] };

// Bounded-parallel map: run fn over items at most `limit` at a time, preserving
// input order. Lets the slow thinking judge run concurrently without firing
// every pair at once (which overruns the API → timeouts, as latency.ts showed).
export async function mapPool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const judgeSchema = z.object({
  a: z.object({ grounded: z.number().int(), coverage: z.number().int(), concise: z.number().int() }),
  b: z.object({ grounded: z.number().int(), coverage: z.number().int(), concise: z.number().int() }),
  winner: z.enum(['A', 'B', 'tie']),
  reason: z.string(),
});

// GPT-6 Sol at medium reasoning effort — a proper thinking
// model as the blind judge. Effort is set on the generateObject call below.
//
// Accuracy-first rubric: grounding counts the weight of evidence and length
// earns nothing. The grounded/specific/useful rubric it replaced (2026-09-22)
// rewarded detail: it picked GPT-5.6 Luna's fuller summaries over GPT-6
// Luna's 22-2, yet under this one GPT-6 won 18-6 on the same outputs, since
// 5.6's extra detail was where it overstated consensus.
const judgeModel = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('gpt-6-sol');

// Scores two summaries of one fixture's reviews, shown as anonymous outputs A and B.
export const judge = async (f: Fixture, a: Summary, b: Summary) => {
  const { object } = await generateObject({
    model: judgeModel,
    providerOptions: { openai: { reasoningEffort: 'medium' } },
    schema: judgeSchema,
    prompt: `${f.reviewTexts.join('\n\n')}\n\n---\n\nTwo anonymous models summarized the reviews above for ${f.place}${f.filter ? ` (topic: "${f.filter}")` : ''}. Score each output 1-5 on: grounded (every claim traceable to the reviews and given the weight the reviews give it — inventing detail, overstating how many reviewers said something, or presenting a one-off as a pattern are grounding errors), coverage (conveys what matters most for deciding: the points many reviewers raise and any major caveat — leaving out minor or one-off points is not a flaw), concise (no padding or repetition; length is not a virtue). Then pick the overall winner: the output a careful reader should rely on to decide, where a grounding error weighs more than a missed minor detail.\n\nOutput A:\n${JSON.stringify(a, null, 1)}\n\nOutput B:\n${JSON.stringify(b, null, 1)}`,
  });
  return object;
};
