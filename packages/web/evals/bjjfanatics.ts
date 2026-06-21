// Eval for the extension's BJJ Fanatics structured summary (complaints / praised
// / conclusion / betterAlternative / suspiciousPatterns) — the flow behind the
// product-page panel, NOT the server summarize() path (which has a different
// schema). It hits each provider exactly the way the extension does
// (packages/extension/src/shared/review-summary.ts: raw fetch, reasoning_effort
// for nano, thinkingConfig MINIMAL for Gemini, json_object for DeepSeek) so the
// numbers reflect production requests.
//
//   bun evals/bjjfanatics.ts                 # 3 models + nano thinking ladder, on the shipped prompt
//   bun evals/bjjfanatics.ts --judge         # + blind gpt-5.4 pairwise quality scoring
//   bun evals/bjjfanatics.ts --ab            # run shipped vs fixed prompt (formatting A/B)
//   bun evals/bjjfanatics.ts --fixed         # run only the fixed prompt
//
// Every run also reports "bold health": whether **bold** lands on concrete
// specifics or on filler connectors ("start with the", "don't skip the"). That
// connector-bolding is the rendered-formatting bug this eval was built to catch.
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';

const JUDGE = process.argv.includes('--judge');
const AB = process.argv.includes('--ab');
const FIXED_ONLY = process.argv.includes('--fixed');

// ── Prompt (mirrors packages/extension/src/sites/bjjfanatics-pdp.ts SUMMARY_PROMPT).
// Body is shared; only the final formatting sentence differs between variants —
// that one sentence is the whole subject of the formatting fix.
const PROMPT_BODY = `Analyze these reviews of a BJJ instructional course. Ignore shipping, delivery, packaging, or seller issues — focus ONLY on the course content and instruction.

ONLY include points mentioned by 3+ reviewers. Rank by frequency (most mentioned first). Each bullet should be one concrete point, e.g. "Volume 3 (back attacks chapter) — most actionable".

BE AS SPECIFIC AS POSSIBLE. Cite concrete volumes, parts, chapters, sections, positions, techniques, sweeps, submissions, or drills by name when reviewers mention them. Generic praise like "great instruction" or generic complaints like "too long" are useless — skip them. Aim for: which volume/part is most valuable, which specific techniques reviewers say worked for them in rolling, which chapters reviewers say to skip or revisit, and which positions get the deepest coverage.

Surface the actual takeaways — what reviewers say they learned, what mental models or principles changed how they roll, what details unlocked a position, what technique they immediately added to their game. The single most important thing reviewers say a viewer should walk away with belongs in the conclusion.

Each review may be prefixed with [Ranking: BLUE | How old are you?: 33-40 | How many years have you been training BJJ?: 1-3]. Use this to note which skill levels found which sections useful.

If 2+ reviewers mention a specific better alternative course or instructor by name, note it and explain how reviewers compare.

The conclusion is the most important field — write it like a buying verdict, not an essay. Lead with the bottom line: buy or skip, and for whom. Then the single most important takeaway reviewers walked away with, what to watch first, and what this course doesn't deliver so the reader knows when to pass. Be punchy and decisive, cite specific techniques and volumes by name, no hedging like "many reviewers say".`;

const PROMPT_TAILS = {
  // Shipped: "bolded leads" is read by nano as "bold each clause's lead-in",
  // which bolds connectors ("start with the", "don't skip the") instead of specifics.
  shipped: ` Format however reads best — a few short paragraphs, bolded leads, or short bullets are all fine.`,
  // Fixed: bold is pinned to concrete specifics, connectors explicitly excluded.
  fixed: ` Format however reads best — a few short paragraphs or short bullets. Use **bold** only on the concrete specifics (techniques, volumes/parts, the buy-or-skip call) — never on connecting phrases like "start with the" or "don't skip the".`,
};
const PROMPTS = {
  shipped: PROMPT_BODY + PROMPT_TAILS.shipped,
  fixed: PROMPT_BODY + PROMPT_TAILS.fixed,
};
const ENGLISH_PIN = '\n\nAlways respond in English, even if the reviews are written in another language.\n\nReviews:\n\n';

// Same shape the extension sends, including suspiciousPatterns. Authored
// Gemini-friendly (nullable); toStrictSchema converts it for OpenAI strict mode.
const SUMMARY_SCHEMA = {
  type: 'object' as const,
  properties: {
    complaints: { type: 'array' as const, items: { type: 'string' as const } },
    praised: { type: 'array' as const, items: { type: 'string' as const } },
    conclusion: { type: 'string' as const },
    betterAlternative: { type: 'string' as const, nullable: true },
    suspiciousPatterns: {
      type: 'string' as const,
      nullable: true,
      description:
        'Warning about review manipulation if detected: repetitive phrasing, astroturfing, suspiciously similar wording, lack of unique detail, incentivized reviews, etc. Empty string if reviews appear genuine.',
    },
  },
  required: ['complaints', 'praised', 'conclusion'],
};

const toStrictSchema = (s: any): any => {
  if (s?.type === 'object')
    return {
      ...s,
      properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toStrictSchema(v)])),
      required: Object.keys(s.properties),
      additionalProperties: false,
    };
  if (s?.type === 'array') return { ...s, items: toStrictSchema(s.items) };
  if (s?.nullable) {
    const { nullable, ...rest } = s;
    return { ...rest, type: [rest.type, 'null'] };
  }
  return s;
};

// ── Providers (endpoints/models from packages/extension/src/shared/config.ts).
const OPENAI_MODEL = 'gpt-5.4-nano';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const GEMINI_MODEL = 'gemini-3-flash-preview';
const geminiEndpoint = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

type Provider = 'gemini' | 'openai' | 'deepseek';
const KEYS: Record<Provider, string | undefined> = {
  openai: process.env.OPENAI_API_KEY,
  deepseek: process.env.DEEPSEEK_API_KEY,
  gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
};

type Usage = { in: number; out: number; reasoning: number };
type Call = { parsed: any; ms: number; usage: Usage };

const callOpenAILike = async (provider: 'openai' | 'deepseek', fullPrompt: string, effort?: string): Promise<Call> => {
  const isDeepseek = provider === 'deepseek';
  const content = isDeepseek
    ? `${fullPrompt}\n\nReturn ONLY a JSON object matching this schema (no markdown, no extra keys):\n${JSON.stringify(SUMMARY_SCHEMA)}`
    : fullPrompt;
  const t0 = performance.now();
  const res = await fetch(isDeepseek ? DEEPSEEK_ENDPOINT : OPENAI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEYS[provider]}` },
    body: JSON.stringify({
      model: isDeepseek ? DEEPSEEK_MODEL : OPENAI_MODEL,
      messages: [{ role: 'user', content }],
      ...(isDeepseek
        ? { thinking: { type: 'disabled' }, max_tokens: 8192, response_format: { type: 'json_object' } }
        : {
            reasoning_effort: effort,
            max_completion_tokens: 32768,
            response_format: { type: 'json_schema', json_schema: { name: 'summary', strict: true, schema: toStrictSchema(SUMMARY_SCHEMA) } },
          }),
    }),
  });
  const ms = Math.round(performance.now() - t0);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error(data?.error?.message || `Empty ${provider} response`);
  const u = data.usage ?? {};
  return { parsed: JSON.parse(raw), ms, usage: { in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0, reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0 } };
};

const callGemini = async (fullPrompt: string): Promise<Call> => {
  const t0 = performance.now();
  const res = await fetch(geminiEndpoint(KEYS.gemini!), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL' }, maxOutputTokens: 32768, responseMimeType: 'application/json', responseSchema: SUMMARY_SCHEMA },
    }),
  });
  const ms = Math.round(performance.now() - t0);
  const data = await res.json();
  const raw = (data?.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought).pop()?.text;
  if (!raw) throw new Error(data?.error?.message || 'Empty Gemini response');
  const u = data.usageMetadata ?? {};
  return { parsed: JSON.parse(raw), ms, usage: { in: u.promptTokenCount ?? 0, out: u.candidatesTokenCount ?? 0, reasoning: u.thoughtsTokenCount ?? 0 } };
};

type Contestant = { label: string; provider: Provider; effort?: string };
const CONTESTANTS: Contestant[] = [
  { label: 'gemini:minimal', provider: 'gemini' },
  { label: 'nano:low', provider: 'openai', effort: 'low' },
  { label: 'nano:medium', provider: 'openai', effort: 'medium' },
  { label: 'nano:high', provider: 'openai', effort: 'high' },
  { label: 'deepseek:off', provider: 'deepseek' },
];

const call = (c: Contestant, fullPrompt: string) =>
  c.provider === 'gemini' ? callGemini(fullPrompt) : callOpenAILike(c.provider, fullPrompt, c.effort);

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

const reviews = (await Bun.file(new URL('./fixtures/bjjfanatics-openguard.txt', import.meta.url)).text())
  .trim()
  .split('\n---\n');
const reviewBlock = reviews.join('\n---\n');

const variants: (keyof typeof PROMPTS)[] = AB ? ['shipped', 'fixed'] : FIXED_ONLY ? ['fixed'] : ['shipped'];

const available = CONTESTANTS.filter((c) => {
  if (!KEYS[c.provider]) {
    console.log(`(skip ${c.label}: no ${c.provider.toUpperCase()} key in env)`);
    return false;
  }
  return true;
});

type Row = { variant: string; label: string; provider: Provider; ms: number; usage: Usage; parsed: any; health: ReturnType<typeof boldHealth>; error?: string };
const rows: Row[] = [];

for (const variant of variants) {
  const fullPrompt = PROMPTS[variant] + ENGLISH_PIN + reviewBlock;
  console.log(`\n${'='.repeat(74)}\n## prompt = ${variant} — ${reviews.length} reviews\n`);
  const results = await Promise.allSettled(available.map((c) => call(c, fullPrompt)));
  results.forEach((r, i) => {
    const c = available[i]!;
    if (r.status === 'rejected') {
      console.log(`### ${c.label} — ERROR: ${r.reason?.message ?? r.reason}\n`);
      rows.push({ variant, label: c.label, provider: c.provider, ms: 0, usage: { in: 0, out: 0, reasoning: 0 }, parsed: null, health: boldHealth(''), error: String(r.reason?.message ?? r.reason) });
      return;
    }
    const { parsed, ms, usage } = r.value;
    const health = boldHealth(parsed.conclusion ?? '');
    rows.push({ variant, label: c.label, provider: c.provider, ms, usage, parsed, health });
    const flag = health.oddMarkers ? ' ⚠ ODD ** MARKERS' : health.filler.length ? ` ⚠ ${health.filler.length} filler-bold` : ' ✓ clean';
    console.log(
      [
        `### ${c.label} — ${ms}ms · ${usage.in} in / ${usage.out} out${usage.reasoning ? ` (${usage.reasoning} reasoning)` : ''}`,
        `praised ${parsed.praised?.length ?? 0} · complaints ${parsed.complaints?.length ?? 0} · alt ${parsed.betterAlternative ? JSON.stringify(parsed.betterAlternative) : '—'} · suspicious ${parsed.suspiciousPatterns ? JSON.stringify(parsed.suspiciousPatterns) : '—'}`,
        `bold: ${health.spans.length} spans${flag}${health.filler.length ? ` → ${JSON.stringify(health.filler)}` : ''}`,
        `conclusion:\n${parsed.conclusion}`,
      ].join('\n') + '\n',
    );
  });
}

// ── Blind quality judge (gpt-5.4 thinking), pairwise within each prompt variant,
// A/B order flipped per pair to cancel position bias. Mirrors evals/compare.ts.
if (JUDGE && KEYS.openai) {
  const judgeModel = createOpenAI({ apiKey: KEYS.openai })('gpt-5.4');
  const judgeSchema = z.object({
    a: z.object({ grounded: z.number().int(), specific: z.number().int(), useful: z.number().int() }),
    b: z.object({ grounded: z.number().int(), specific: z.number().int(), useful: z.number().int() }),
    winner: z.enum(['A', 'B', 'tie']),
    reason: z.string(),
  });
  const tally: Record<string, { w: number; t: number; l: number; g: number; s: number; u: number; n: number }> = {};
  const acc = (p: string) => (tally[p] ??= { w: 0, t: 0, l: 0, g: 0, s: 0, u: 0, n: 0 });
  const out = (x: any) => JSON.stringify({ conclusion: x.conclusion, praised: x.praised, complaints: x.complaints, betterAlternative: x.betterAlternative }, null, 1);

  for (const variant of variants) {
    const ok = rows.filter((r) => r.variant === variant && r.parsed);
    const pairs: [Row, Row][] = [];
    for (let a = 0; a < ok.length; a++) for (let b = a + 1; b < ok.length; b++) pairs.push([ok[a]!, ok[b]!]);
    console.log(`\n${'='.repeat(74)}\n## judge (gpt-5.4 thinking, blind) — prompt = ${variant}\n`);
    for (const [k, [r0, r1]] of pairs.entries()) {
      const flip = k % 2 === 1;
      const [a, b] = flip ? [r1, r0] : [r0, r1];
      const { object } = await generateObject({
        model: judgeModel,
        providerOptions: { openai: { reasoningEffort: 'high' } },
        schema: judgeSchema,
        prompt: `${reviewBlock}\n\n---\n\nTwo anonymous models summarized the BJJ instructional reviews above. Score each 1-5 on: grounded (claims traceable to the reviews, nothing invented), specific (named techniques/volumes over vague adjectives), useful (helps someone decide buy/skip). Then pick the overall winner.\n\nOutput A:\n${out(a.parsed)}\n\nOutput B:\n${out(b.parsed)}`,
      });
      const scores = flip ? { [r0.label]: object.b, [r1.label]: object.a } : { [r0.label]: object.a, [r1.label]: object.b };
      const winner = object.winner === 'tie' ? 'tie' : (object.winner === 'A') !== flip ? r0.label : r1.label;
      console.log(`${r0.label} vs ${r1.label}: ${Object.entries(scores).map(([p, s]) => `${p} g${s.grounded}/s${s.specific}/u${s.useful}`).join(' | ')} → ${winner}${winner === 'tie' ? '' : `: ${object.reason}`}`);
      for (const [p, s] of Object.entries(scores)) {
        const x = acc(p);
        x.g += s.grounded; x.s += s.specific; x.u += s.useful; x.n++;
      }
      if (winner === 'tie') { acc(r0.label).t++; acc(r1.label).t++; }
      else { acc(winner).w++; acc(winner === r0.label ? r1.label : r0.label).l++; }
    }
  }
  console.log(`\n${'='.repeat(74)}\n## standings — gpt-5.4 thinking, blind\n`);
  const ranked = Object.entries(tally).map(([label, x]) => ({ label, x, avg: x.n ? (x.g + x.s + x.u) / x.n : 0 })).sort((m, n) => n.x.w - m.x.w || n.avg - m.avg);
  for (const { label, x, avg } of ranked) {
    const a = (v: number) => (x.n ? (v / x.n).toFixed(2) : '—');
    console.log(`- ${label} — ${x.w}W ${x.t}T ${x.l}L · grounded ${a(x.g)} · specific ${a(x.s)} · useful ${a(x.u)} · avg ${avg.toFixed(2)}/15`);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = new URL(`./out/bjjfanatics-${stamp}.json`, import.meta.url);
await Bun.write(outPath, JSON.stringify({ stamp, reviewCount: reviews.length, rows }, null, 2));
console.log(`\nwrote ${outPath.pathname}`);
