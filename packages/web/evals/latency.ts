// One-off: compare summarization latency (and optional quality) across
// providers / reasoning-effort levels.
//   bun evals/latency.ts [runs] [reviews.json] [--judge]   (default 3 runs)
// Times the heavy *structured* extraction call (the production bottleneck) on
// a realistic review set, so the spread reflects what users actually wait for.
// Variants: nano effort ladder (none|low|medium|high), Gemini Flash at the
// production thinkingLevel, and DeepSeek V4 Flash non-thinking + its thinking
// effort ladder (low|medium|high|xhigh|max). Reasoning/thought tokens explain
// the latency. --judge adds a blind gpt-5.4 quality score (grounded/specific/
// useful, 1-5) of each variant's structured output, scored after timing so it
// never pollutes the latency numbers.
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });
const nano = openai('gpt-5.4-nano');
const flash = google('gemini-3-flash-preview');
const ds = deepseek('deepseek-v4-flash');

// DeepSeek has no native JSON-schema response format, so the SDK injects the
// schema into the system prompt and logs a warning on every call — hush it.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const RUNS = Number(args[0]) || 3;
const JUDGE = process.argv.includes('--judge');

const SCHEMA = z.object({
  highlights: z.array(z.object({ text: z.string(), sentiment: z.enum(['positive', 'negative', 'neutral']) })),
  items: z.array(z.string()),
  alternatives: z.array(z.string()),
  valueForMoney: z.number().int(),
});

// Optional path to a JSON array of review strings (e.g. a real place's
// reviewTexts); falls back to the built-in sample set.
const reviewsFile = args[1];
const SAMPLE_REVIEWS = [
  'Best brunch in the neighborhood. The shakshuka is incredible and the flat white is properly pulled. Gets packed by 10am on weekends.',
  'Overrated and overpriced. €18 for avocado toast that was cold in the middle. Service was friendly but slow — waited 25 minutes for food.',
  'Lovely spot, great natural light, plants everywhere. Coffee is excellent. Food is fine but you are really paying for the vibe and the location.',
  'The pancakes are a must. Fluffy, not too sweet, generous portion. Staff remembered our order from last time. Cash only is annoying though.',
  'Went twice. First time amazing, second time the eggs were overcooked and they forgot a side. Inconsistent. Still, the pastries are top tier.',
  'Honestly skip it and go to Maud across the street — cheaper, faster, same quality coffee. This place trades on its Instagram looks.',
  'Cozy, busy, a bit cramped. The sourdough is house-made and you can taste it. Prices crept up since last year. Worth it for a treat.',
  'Friendly baristas, beautiful latte art, but the wifi is terrible if you want to work. Brunch menu is small but everything on it is solid.',
  'The eggs benedict were perfect, hollandaise rich and lemony. Mimosa was watery for €9 though. Mixed feelings but I would return for the eggs.',
  'Service ranges from charming to nonexistent depending on who you get. Food never disappoints. The banana bread sells out fast — get there early.',
  'Took my parents, they loved the quiet courtyard out back. Coffee strong, croissants flaky. A little pricey but portions are honest.',
  'Way too loud inside, could not hear my friend. Acoustics are awful. Food was good — the granola bowl is huge — but I left with a headache.',
  'Vegan options are an afterthought. One sad tofu scramble. If you eat meat the bacon is excellent, thick cut and crispy.',
  'I come here every Sunday. The staff know my name. Consistency is the whole point and they nail it. The cortado is the best in the city.',
  'Beautiful plating, mediocre taste. Everything is styled for photos. The €14 french toast looked stunning and tasted of nothing.',
  'Underrated dinner menu — everyone comes for brunch but the evening small plates are where it shines. The burrata was outstanding.',
  'Reservations are a nightmare, walk-in waits hit 40 minutes. Once seated though, the espresso and the almond croissant made it worth it.',
  'Cleanliness could be better, table was sticky and the bathroom was out of soap. Shame because the food itself was genuinely great.',
  'Best oat milk latte I have had. They roast their own beans. The breakfast burrito is enormous and only €11, rare value for this area.',
  'Went on a weekday morning, totally empty and relaxed. Completely different experience from the weekend chaos. Highly recommend off-peak.',
  'Staff rushed us out to flip the table. Felt unwelcome after we finished eating. Food fine, hospitality poor. Coffee Collective is nicer.',
  'The chai is house-made with real spices, not syrup. You can tell. Pastries are hit or miss — the cardamom bun is a hit, the muffins are dry.',
  'Allergy-friendly and they took my gluten intolerance seriously, separate prep. As a celiac that is rare and I am grateful. Food was tasty too.',
  'Prices have gotten silly. €6 for a small filter coffee. The quality is there but it is hard to justify as a regular spot anymore.',
  'Hidden gem two streets off the main drag. No queue, better than the famous places nearby. The mushroom toast is unexpectedly brilliant.',
  'Music too loud and too cool-for-school. The food is solid, the eggs florentine especially, but the atmosphere tries way too hard.',
  'Outdoor seating is lovely in summer, heaters in winter. Year-round winner. The seasonal specials board is always worth checking.',
  'Came for the hype, left unimpressed. Long wait, average coffee, tiny portions for the price. La Cabra does everything better and cheaper.',
];
const REVIEWS: string[] = reviewsFile ? await Bun.file(reviewsFile).json() : SAMPLE_REVIEWS;
const PROMPT = `${REVIEWS.join('\n\n')}\n\n---\n\nExtract highlights about this place and rate value for money 1-5 from pricing mentions. Each highlight: one concrete line, ≤20 words, with sentiment. Also list up to 6 short keyword items the place is known for, and any alternatives reviewers name as better. Empty arrays if nothing fits.`;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// --judge: a blind gpt-5.4 scorer for each structured output (same rubric as
// evals/compare.ts). Absolute 1-5 per dimension; a call's clock stops before
// its output is judged, so judge time never counts toward latency.
type Q = { g: number; s: number; u: number };
const judge = openai('gpt-5.4');
const QUALITY_SCHEMA = z.object({ grounded: z.number().int(), specific: z.number().int(), useful: z.number().int() });
const scoreQuality = async (summary: unknown): Promise<Q> => {
  const { object } = await generateObject({
    model: judge,
    schema: QUALITY_SCHEMA,
    prompt: `${REVIEWS.join('\n\n')}\n\n---\n\nA model extracted the structured summary below from the reviews above. Score it 1-5 on grounded (every claim traceable to the reviews, nothing invented), specific (concrete details over vague adjectives), and useful (helps someone decide).\n\n${JSON.stringify(summary, null, 1)}`,
  });
  return { g: object.grounded, s: object.specific, u: object.useful };
};

type Variant = { label: string; run: () => Promise<any> };
const NANO_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
const DS_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const variants: Variant[] = [
  ...NANO_EFFORTS.map((e) => ({
    label: `nano:${e}`,
    run: () => generateObject({ model: nano, providerOptions: { openai: { reasoningEffort: e } }, maxOutputTokens: 16384, schema: SCHEMA, prompt: PROMPT }),
  })),
  {
    label: 'flash:min',
    run: () => generateObject({ model: flash, providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } }, maxOutputTokens: 16384, schema: SCHEMA, prompt: PROMPT }),
  },
  // DeepSeek V4 Flash: non-thinking (fastest) then the thinking effort ladder.
  {
    label: 'ds:off',
    run: () => generateObject({ model: ds, providerOptions: { deepseek: { thinking: { type: 'disabled' } } }, maxOutputTokens: 16384, schema: SCHEMA, prompt: PROMPT }),
  },
  ...DS_EFFORTS.map((e) => ({
    label: `ds:${e}`,
    run: () => generateObject({ model: ds, providerOptions: { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: e } }, maxOutputTokens: 16384, schema: SCHEMA, prompt: PROMPT }),
  })),
];

type Row = { label: string; med: number; mean: number; lats: number[]; reason: number; out: number; q?: Q };
type Sample = { label: string; ms: number; reason: number; out: number; q?: Q };

console.log(`\nstructured-summary latency · ${RUNS} runs/variant · ${REVIEWS.length} reviews · parallel\n`);

// Account isn't rate-limited, so fire every call at once and time each
// independently — total wall-clock is the slowest single call, not the sum.
const settled = await Promise.all(
  variants.flatMap((v) =>
    Array.from({ length: RUNS }, async (): Promise<Sample | null> => {
      const t0 = performance.now();
      try {
        const r = await v.run();
        // Stop the clock before judging so the judge's own call never counts.
        const s: Sample = { label: v.label, ms: performance.now() - t0, reason: (r.usage as any).reasoningTokens ?? 0, out: r.usage.outputTokens ?? 0 };
        if (JUDGE) s.q = await scoreQuality(r.object).catch((e: any) => (console.log(`  judge ${v.label}: ERROR ${e.message?.slice(0, 70)}`), undefined));
        return s;
      } catch (e: any) {
        console.log(`  ${v.label}: ERROR ${e.message?.slice(0, 90)}`);
        return null;
      }
    }),
  ),
);
const samples = settled.filter((s): s is Sample => s !== null);

const rows: Row[] = variants.flatMap((v) => {
  const mine = samples.filter((s) => s.label === v.label);
  if (!mine.length) return [];
  const lats = mine.map((s) => s.ms);
  const qs = mine.map((s) => s.q).filter((q): q is Q => !!q);
  const q = qs.length ? { g: avg(qs.map((x) => x.g)), s: avg(qs.map((x) => x.s)), u: avg(qs.map((x) => x.u)) } : undefined;
  return [{ label: v.label, med: median(lats), mean: avg(lats), lats, reason: avg(mine.map((s) => s.reason)), out: avg(mine.map((s) => s.out)), q }];
});

const fastest = Math.min(...rows.map((r) => r.med));
console.log(`variant      median    mean   ×fast   reasoning  output${JUDGE ? '   qual (g/s/u)' : ''}   runs (s)`);
console.log('-'.repeat(JUDGE ? 96 : 74));
for (const r of rows) {
  const qcol = JUDGE
    ? (r.q ? `  ${((r.q.g + r.q.s + r.q.u) / 3).toFixed(1)} (${r.q.g.toFixed(1)}/${r.q.s.toFixed(1)}/${r.q.u.toFixed(1)})` : '  —').padEnd(18)
    : '';
  console.log(
    `${r.label.padEnd(11)} ${(r.med / 1000).toFixed(1).padStart(5)}s  ${(r.mean / 1000).toFixed(1).padStart(5)}s  ` +
      `${(r.med / fastest).toFixed(1).padStart(4)}×  ${Math.round(r.reason).toString().padStart(7)}    ${Math.round(r.out).toString().padStart(5)}${qcol}   ` +
      `[${r.lats.map((x) => (x / 1000).toFixed(1)).join(', ')}]`,
  );
}
console.log();
