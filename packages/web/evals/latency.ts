// One-off: compare summarization latency across providers/effort levels.
//   bun evals/latency.ts [runs]   (default 3 runs per variant)
// Times the heavy *structured* extraction call (the production bottleneck) on
// a realistic review set, so the spread reflects what users actually wait for.
// nano effort ladder (none|low|medium|high|xhigh) vs Gemini Flash at the
// production thinkingLevel. Reasoning/thought tokens explain the latency.
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
const nano = openai('gpt-5.4-nano');
const flash = google('gemini-3-flash-preview');

const RUNS = Number(process.argv[2]) || 3;

const SCHEMA = z.object({
  highlights: z.array(z.object({ text: z.string(), sentiment: z.enum(['positive', 'negative', 'neutral']) })),
  items: z.array(z.string()),
  alternatives: z.array(z.string()),
  valueForMoney: z.number().int(),
});

const REVIEWS = [
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
const PROMPT = `${REVIEWS.join('\n\n')}\n\n---\n\nExtract highlights about this place and rate value for money 1-5 from pricing mentions. Each highlight: one concrete line, ≤20 words, with sentiment. Also list up to 6 short keyword items the place is known for, and any alternatives reviewers name as better. Empty arrays if nothing fits.`;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

type Variant = { label: string; run: () => Promise<any> };
const NANO_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
const variants: Variant[] = [
  ...NANO_EFFORTS.map((e) => ({
    label: `nano:${e}`,
    run: () => generateObject({ model: nano, providerOptions: { openai: { reasoningEffort: e } }, maxOutputTokens: 16384, schema: SCHEMA, prompt: PROMPT }),
  })),
  {
    label: 'flash:min',
    run: () => generateObject({ model: flash, providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } }, maxOutputTokens: 16384, schema: SCHEMA, prompt: PROMPT }),
  },
];

type Row = { label: string; med: number; mean: number; lats: number[]; reason: number; out: number };
const rows: Row[] = [];
let printedUsage = false;

console.log(`\nstructured-summary latency · ${RUNS} runs/variant · ${REVIEWS.length} reviews\n`);

for (const v of variants) {
  const lats: number[] = [];
  const reason: number[] = [];
  const out: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    try {
      const r = await v.run();
      lats.push(performance.now() - t0);
      if (!printedUsage) { console.log('  (usage shape:', JSON.stringify(r.usage), ')\n'); printedUsage = true; }
      reason.push((r.usage as any).reasoningTokens ?? 0);
      out.push(r.usage.outputTokens ?? 0);
    } catch (e: any) {
      console.log(`  ${v.label} run ${i + 1}: ERROR ${e.message?.slice(0, 90)}`);
    }
  }
  if (lats.length) rows.push({ label: v.label, med: median(lats), mean: avg(lats), lats, reason: avg(reason), out: avg(out) });
}

const fastest = Math.min(...rows.map((r) => r.med));
console.log('variant      median    mean   ×fast   reasoning  output   runs (s)');
console.log('-'.repeat(74));
for (const r of rows) {
  console.log(
    `${r.label.padEnd(11)} ${(r.med / 1000).toFixed(1).padStart(5)}s  ${(r.mean / 1000).toFixed(1).padStart(5)}s  ` +
      `${(r.med / fastest).toFixed(1).padStart(4)}×  ${Math.round(r.reason).toString().padStart(7)}    ${Math.round(r.out).toString().padStart(5)}   ` +
      `[${r.lats.map((x) => (x / 1000).toFixed(1)).join(', ')}]`,
  );
}
console.log();
