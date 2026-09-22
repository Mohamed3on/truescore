// Eval for the extension's BJJ Fanatics course summary (complaints / praised /
// conclusion / betterAlternative) — the flow behind the product-page panel,
// NOT the server summarize() path. It runs the extension's own code, not a
// copy: the shipped prompt and COURSE CONTENTS block
// (extension/src/sites/bjjfanatics-prompt.ts), withContext + llmSummarize
// (shared/review-summary.ts) and the model call on the popup's provider
// (shared/llm.ts). Only chrome.storage is stubbed, to hand each contestant its
// provider and key; fixtures supply the reviews and the raw course contents
// the page would scrape.
//
//   bun evals/bjjfanatics.ts                 # the three providers the extension offers
//   bun evals/bjjfanatics.ts --judge         # + blind gpt-6-sol pairwise quality scoring
//   bun evals/bjjfanatics.ts --only=a,b      # just those contestant labels
//   bun evals/bjjfanatics.ts --fixture=pin   # just fixtures whose name contains it
//
// Every run also reports "bold health": whether **bold** lands on concrete
// specifics or on filler connectors ("start with the", "don't skip the"). That
// connector-bolding is the rendered-formatting bug this eval was built to catch.
/// <reference types="chrome" />
import { AsyncLocalStorage } from 'node:async_hooks';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, type LanguageModelUsage } from 'ai';
import { z } from 'zod';
import { setOnUsage } from '../../extension/src/shared/llm';
import { llmSummarize, withContext } from '../../extension/src/shared/review-summary';
import { courseContext, SUMMARY_PROMPT } from '../../extension/src/sites/bjjfanatics-prompt';

const JUDGE = process.argv.includes('--judge');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');

type Provider = 'gemini' | 'openai' | 'deepseek';
const KEYS: Record<Provider, string | undefined> = {
  openai: process.env.OPENAI_API_KEY,
  deepseek: process.env.DEEPSEEK_API_KEY,
  gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
};

// The extension reads its provider, key and reasoning effort from
// chrome.storage.sync. Each call runs with its own contestant's settings (no
// effort set, so OpenAI gets the popup's default) and reports its token usage
// back into the same slot.
type Slot = { storage: Record<string, string | undefined>; usage?: LanguageModelUsage };
const slot = new AsyncLocalStorage<Slot>();
(globalThis as any).chrome = { storage: { sync: { get: async (name: string) => ({ [name]: slot.getStore()?.storage[name] }) } } };
setOnUsage((usage) => { slot.getStore()!.usage = usage; });

// The providers the extension offers, each on its shipped settings.
type Contestant = { label: string; provider: Provider };
const CONTESTANTS: Contestant[] = [
  { label: 'gemini:minimal', provider: 'gemini' },
  { label: 'luna:low', provider: 'openai' },
  { label: 'deepseek:off', provider: 'deepseek' },
];

type Usage = { in: number; out: number; reasoning: number };
// The panel's own summary call (buildSummarizeWidget): the prompt plus the
// course-contents block, over the reviews.
const call = (c: Contestant, reviewTexts: string[], contents: string) => {
  const s: Slot = { storage: { llmProvider: c.provider, openaiApiKey: KEYS.openai, geminiApiKey: KEYS.gemini, deepseekApiKey: KEYS.deepseek } };
  return slot.run(s, async () => {
    const t0 = performance.now();
    const parsed = await llmSummarize(reviewTexts, withContext(SUMMARY_PROMPT, contents ? courseContext(contents) : undefined));
    const u = s.usage;
    const usage: Usage = { in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0, reasoning: u?.outputTokenDetails?.reasoningTokens ?? 0 };
    return { parsed, ms: Math.round(performance.now() - t0), usage };
  });
};

// ── Bold health: does **bold** mark specifics, or filler connectors?
// A bold span is "filler" if it ends on an article/preposition or opens with a
// clause connector and carries no concrete token (digit / Volume / Part / a
// named technique). This is exactly the failure the screenshot showed.
const FILLER_OPENER = /^(start|then|next|first|finally|also|begin|lead|use|focus|prioriti[sz]e|don'?t skip|what to|skip|pair|watch|followed|because)\b/i;
const TAIL_WORD = /\b(the|a|an|to|of|with|for|your|its|on|from|into)$/i;
const SPECIFIC = /\d|\b(volume|part|chapter|guard|sweep|entry|drag|crunch|ashi|x-?guard|butterfly|shin|sumi|kouchi|supine|nogi|gi)\b/i;
const boldHealth = (md: string) => {
  const spans = [...md.matchAll(/\*\*([^*\n]+)\*\*/g)].map((m) => m[1]!.trim());
  const oddMarkers = ((md.match(/\*\*/g)?.length ?? 0) % 2) === 1;
  const filler = spans.filter((s) => {
    if (/:$/.test(s.trim())) return false; // a bolded "Section label:" is fine, not the bug
    const t = s.replace(/[:,.]+$/, '');
    return (FILLER_OPENER.test(t) || TAIL_WORD.test(t)) && !SPECIFIC.test(t);
  });
  return { spans, filler, oddMarkers };
};

// Each fixture is a product: its reviews ('\n---\n'-joined, as the extension
// sends them) and optionally `context`, the raw course contents the page
// scrape yields, which courseContext() wraps as the panel does so the model can
// ground "volume 3 / the darce dilemma" references in real chapters.
const FIXTURES = [
  { name: 'open-guard', reviews: 'bjjfanatics-openguard.txt' },
  // Same reviews, but with the Part 1–8 breakdown extracted from the product
  // description as context — the fallback when a product has no chapter list.
  { name: 'open-guard+desc', reviews: 'bjjfanatics-openguard.txt', context: 'bjjfanatics-openguard.context.txt' },
  { name: 'half-guard+contents', reviews: 'bjjfanatics-halfguard.txt', context: 'bjjfanatics-halfguard.context.txt' },
  // Danaher Pin Escapes: the largest set (842 reviews, ~180K chars) — the heavy
  // fixture used for the gpt-5.6-luna reasoning-ladder benchmark.
  { name: 'pin-escapes+contents', reviews: 'bjjfanatics-pinescapes.txt', context: 'bjjfanatics-pinescapes.context.txt' },
];
const fixtureArg = process.argv.find((a) => a.startsWith('--fixture='))?.split('=')[1];
const load = async (f: (typeof FIXTURES)[number]) => ({
  name: f.name,
  reviews: (await Bun.file(new URL(`./fixtures/${f.reviews}`, import.meta.url)).text()).trim(),
  context: 'context' in f && f.context ? (await Bun.file(new URL(`./fixtures/${f.context}`, import.meta.url)).text()).trim() : '',
});
const fixtures = await Promise.all(FIXTURES.filter((f) => !fixtureArg || f.name.includes(fixtureArg)).map(load));

const available = CONTESTANTS.filter((c) => {
  if (ONLY && !ONLY.includes(c.label)) return false;
  if (!KEYS[c.provider]) {
    console.log(`(skip ${c.label}: no ${c.provider.toUpperCase()} key in env)`);
    return false;
  }
  return true;
});

// Volume numbers a conclusion claims. For a fixture WITH official contents, any
// number outside the real range is invented outright; whether it mapped the
// right *content* to a volume is a judgment left to reading the output.
const volumesCited = (md: string) => [...new Set([...md.matchAll(/\b(?:vol(?:ume)?|part)\.?\s*0?(\d{1,2})\b/gi)].map((m) => +m[1]!))];

type Row = { fixture: string; label: string; provider: Provider; ms: number; usage: Usage; parsed: any; health: ReturnType<typeof boldHealth>; volumes: number[]; error?: string };
const rows: Row[] = [];

for (const fx of fixtures) {
  const reviewTexts = fx.reviews.split('\n---\n');
  const maxVol = fx.context ? Math.max(0, ...[...fx.context.matchAll(/\b(?:Volume|Part)\s*0?(\d{1,2})\b/g)].map((m) => +m[1]!)) : 0;
  console.log(`\n${'='.repeat(74)}\n## ${fx.name} — ${reviewTexts.length} reviews${fx.context ? ` (+ contents, ${maxVol} vols)` : ''}\n`);
  const results = await Promise.allSettled(available.map((c) => call(c, reviewTexts, fx.context)));
  results.forEach((r, i) => {
    const c = available[i]!;
    if (r.status === 'rejected') {
      console.log(`### ${c.label} — ERROR: ${r.reason?.message ?? r.reason}\n`);
      rows.push({ fixture: fx.name, label: c.label, provider: c.provider, ms: 0, usage: { in: 0, out: 0, reasoning: 0 }, parsed: null, health: boldHealth(''), volumes: [], error: String(r.reason?.message ?? r.reason) });
      return;
    }
    const { parsed, ms, usage } = r.value;
    const health = boldHealth(parsed.conclusion ?? '');
    const vols = volumesCited(parsed.conclusion ?? '');
    const badVols = fx.context ? vols.filter((v) => v < 1 || v > maxVol) : [];
    rows.push({ fixture: fx.name, label: c.label, provider: c.provider, ms, usage, parsed, health, volumes: vols });
    const flag = health.oddMarkers ? ' ⚠ ODD **' : health.filler.length ? ` ⚠ ${health.filler.length} filler-bold` : ' ✓ clean';
    console.log(
      [
        `### ${c.label} — ${ms}ms · ${usage.in} in / ${usage.out} out${usage.reasoning ? ` (${usage.reasoning} reasoning)` : ''}`,
        `praised ${parsed.praised?.length ?? 0} · complaints ${parsed.complaints?.length ?? 0} · alt ${parsed.betterAlternative ? JSON.stringify(parsed.betterAlternative) : '—'}`,
        `bold: ${health.spans.length} spans${flag}${health.filler.length ? ` → ${JSON.stringify(health.filler)}` : ''}`,
        fx.context ? `volumes cited: ${vols.length ? vols.join(', ') : '—'}${badVols.length ? ` ⚠ OUT OF RANGE (max ${maxVol}): ${badVols.join(', ')}` : ''}` : `volumes cited: ${vols.length ? `${vols.join(', ')} ⚠ (no contents provided — invented)` : '—'}`,
        `conclusion:\n${parsed.conclusion}`,
      ].join('\n') + '\n',
    );
  });
}

// ── Blind quality judge (gpt-6-sol thinking), pairwise within each fixture,
// A/B order flipped per pair to cancel position bias. Mirrors evals/compare.ts.
if (JUDGE && KEYS.openai) {
  const judgeModel = createOpenAI({ apiKey: KEYS.openai })('gpt-6-sol');
  const judgeSchema = z.object({
    a: z.object({ grounded: z.number().int(), coverage: z.number().int(), concise: z.number().int() }),
    b: z.object({ grounded: z.number().int(), coverage: z.number().int(), concise: z.number().int() }),
    winner: z.enum(['A', 'B', 'tie']),
    reason: z.string(),
  });
  const tally: Record<string, { w: number; t: number; l: number; grounded: number; coverage: number; concise: number; n: number }> = {};
  const acc = (p: string) => (tally[p] ??= { w: 0, t: 0, l: 0, grounded: 0, coverage: 0, concise: 0, n: 0 });
  const out = (x: any) => JSON.stringify({ conclusion: x.conclusion, praised: x.praised, complaints: x.complaints, betterAlternative: x.betterAlternative }, null, 1);

  const groups = [...new Set(rows.filter((r) => r.parsed).map((r) => r.fixture))];
  for (const g of groups) {
    const ok = rows.filter((r) => r.parsed && r.fixture === g);
    const fx = fixtures.find((f) => f.name === ok[0]!.fixture)!;
    // The judge MUST see the same course contents the summary saw. Otherwise it
    // scores valid volume/chapter citations (e.g. "rolling commentary, Vol 9-10")
    // as hallucinations — they aren't in the reviews, only in the contents.
    const reviewBlock = (fx.context ? `OFFICIAL COURSE CONTENTS (citations matching these volumes/chapters are grounded, not invented):\n${fx.context}\n\n---\n\n` : '') + `REVIEWS:\n${fx.reviews}`;
    const pairs: [Row, Row][] = [];
    for (let a = 0; a < ok.length; a++) for (let b = a + 1; b < ok.length; b++) pairs.push([ok[a]!, ok[b]!]);
    console.log(`\n${'='.repeat(74)}\n## judge (gpt-6-sol thinking, blind) — ${g}\n`);
    // Judge every pair concurrently; fold the verdicts into the tally after, so
    // the shared counters stay deterministic regardless of completion order.
    const judged = await Promise.all(
      pairs.map(async ([r0, r1], k) => {
        const flip = k % 2 === 1;
        const [a, b] = flip ? [r1, r0] : [r0, r1];
        const { object } = await generateObject({
          model: judgeModel,
          providerOptions: { openai: { reasoningEffort: 'medium' } },
          schema: judgeSchema,
          prompt: `${reviewBlock}\n\n---\n\nTwo anonymous models summarized the source above (reviews, plus official course contents when present). Score each 1-5 on: grounded (every claim traceable to the reviews OR the official contents — a volume/chapter citation that matches the contents is grounded, NOT invented — and given the weight the reviews give it: crediting a volume or technique reviewers didn't single out, overstating how many reviewers said something, or presenting a one-off as a pattern are grounding errors), coverage (conveys what matters most for a buy/skip decision: the points many reviewers raise, including major complaints — leaving out minor or one-off points is not a flaw), concise (no padding or repetition; length is not a virtue). Then pick the overall winner: the output a careful buyer should rely on to decide, where a grounding error weighs more than a missed minor detail.\n\nOutput A:\n${out(a.parsed)}\n\nOutput B:\n${out(b.parsed)}`,
        });
        const scores = flip ? { [r0.label]: object.b, [r1.label]: object.a } : { [r0.label]: object.a, [r1.label]: object.b };
        const winner = object.winner === 'tie' ? 'tie' : (object.winner === 'A') !== flip ? r0.label : r1.label;
        return { r0, r1, scores, winner, reason: object.reason };
      }),
    );
    for (const { r0, r1, scores, winner, reason } of judged) {
      console.log(`${r0.label} vs ${r1.label}: ${Object.entries(scores).map(([p, s]) => `${p} grounded ${s.grounded}/coverage ${s.coverage}/concise ${s.concise}`).join(' | ')} → ${winner}${winner === 'tie' ? '' : `: ${reason}`}`);
      for (const [p, s] of Object.entries(scores)) {
        const x = acc(p);
        x.grounded += s.grounded; x.coverage += s.coverage; x.concise += s.concise; x.n++;
      }
      if (winner === 'tie') { acc(r0.label).t++; acc(r1.label).t++; }
      else { acc(winner).w++; acc(winner === r0.label ? r1.label : r0.label).l++; }
    }
  }
  console.log(`\n${'='.repeat(74)}\n## standings — gpt-6-sol thinking, blind\n`);
  const ranked = Object.entries(tally).map(([label, x]) => ({ label, x, avg: x.n ? (x.grounded + x.coverage + x.concise) / x.n : 0 })).sort((m, n) => n.x.w - m.x.w || n.avg - m.avg);
  for (const { label, x, avg } of ranked) {
    const a = (v: number) => (x.n ? (v / x.n).toFixed(2) : '—');
    console.log(`- ${label} — ${x.w}W ${x.t}T ${x.l}L · grounded ${a(x.grounded)} · coverage ${a(x.coverage)} · concise ${a(x.concise)} · avg ${avg.toFixed(2)}/15`);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = new URL(`./out/bjjfanatics-${stamp}.json`, import.meta.url);
await Bun.write(outPath, JSON.stringify({ stamp, fixtures: fixtures.map((f) => f.name), rows }, null, 2));
console.log(`\nwrote ${outPath.pathname}`);
