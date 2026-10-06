import { choice, noul, TypeSafeClient, type Question } from '@typesafe-ai/sdk';
import { countStances, isTrusted, MAX_JUDGED, stripAccents, type Answer, type Review, type Stance, type StanceResult, type Summary } from '@truescore/gmaps-shared';
import { db } from './db';
import type { Subject } from './summary-subject';

// Jev — TypeSafe's decision model — returns typed judgements rather than prose:
// here, what each review says about a topic, how it answers a question, and
// which summary points it makes. Every call is optional. No key, an outage or a
// timeout gives null, and the caller shows the pure-math display it always had.
//
// Input tokens are the whole cost (output is free), so every judgement is made
// once and kept (jev_memo), and questions ride ~20 to a request to spread its
// fixed overhead. Cheaper reads that cost accuracy were measured and left out:
// short labels (-2.5 points), only the sentences naming the topic (-1.5), and
// checking summary points against a keyword shortlist (28% of support missed).

const apiKey = process.env.TYPESAFE_API_KEY;
type Client = Pick<TypeSafeClient, 'systemOne'>;
let client: Client | null = apiKey ? new TypeSafeClient({ apiKey, timeout: 8_000, retry: { maxRetries: 1 } }) : null;

// Questions per request, each holding its own review, with only the topic in the
// shared state: on 209 hand-labelled reviews that read 91% right whether 6 or 25
// rode together, where reviews listed in the state and named by index fell to
// 85% at 25 (their neighbours distract). Capped by length too.
const BATCH = 20;
const BATCH_CHARS = 60_000;
// In flight at once, across the server: the account allows 40 requests a second.
const MAX_IN_FLIGHT = 8;
// A review longer than any Google allows is clipped, as a guard on the request size.
const MAX_TEXT = 6_000;
// A failed request backs every caller off for a while, so an outage costs one
// timeout instead of one per chip, search and summary.
const DOWN_MS = 5 * 60_000;

let inFlight = 0;
const waiting: (() => void)[] = [];
let downUntil = 0;
// Input tokens spent, by kind of judgement, since the process started.
export const spent: Record<string, number> = {};

export const jevAvailable = (): boolean => !!client && Date.now() >= downUntil;
// Tests swap in a fake client; the server never calls this.
export const setJevClient = (fake: Client | null) => { client = fake; downUntil = 0; };

// One request's answers by question id, or null when it failed.
async function evaluate(kind: string, state: Record<string, unknown>, questions: Record<string, Question>): Promise<Record<string, any> | null> {
  if (!client || !jevAvailable()) return null;
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((go) => waiting.push(go));
  inFlight++;
  try {
    const { answers, usage } = await client.systemOne({ state: state as never, questions });
    spent[kind] = (spent[kind] ?? 0) + usage.input_tokens;
    console.log(`[jev] ${kind} q=${Object.keys(questions).length} in=${usage.input_tokens}`);
    return answers as Record<string, any>;
  } catch (e) {
    downUntil = Date.now() + DOWN_MS;
    console.warn(`[jev] ${kind} request failed, pausing ${DOWN_MS / 60_000} min:`, e instanceof Error ? e.message : e);
    return null;
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);
const fold = (s: string) => stripAccents(s.toLowerCase());

// Indices into `texts` in request-sized runs.
const batches = (indices: number[], texts: string[]): number[][] => {
  const out: number[][] = [];
  let run: number[] = [], chars = 0;
  for (const i of indices) {
    const n = texts[i]!.length;
    if (run.length && (run.length >= BATCH || chars + n > BATCH_CHARS)) { out.push(run); run = []; chars = 0; }
    run.push(i); chars += n;
  }
  if (run.length) out.push(run);
  return out;
};

// A judgement doesn't change, so it's kept: a chip re-scored on new reviews, a
// repeated search, every client asking about the same reviews and a summary
// re-checked read only what's new.
db.run('CREATE TABLE IF NOT EXISTS jev_memo (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL)');
const getMemo = db.prepare<{ v: string }, [string]>('SELECT v FROM jev_memo WHERE k = ?');
const putMemo = db.prepare<void, [string, string, number]>('INSERT OR REPLACE INTO jev_memo (k, v, ts) VALUES (?, ?, ?)');
const memoKey = (kind: string, about: string, text: string) =>
  `${kind}:${Bun.hash(`${about.trim().toLowerCase()}\u0000${text}`).toString(36)}`;

// Described, not bare: bare labels read 2.5 points worse on the labelled set.
const STANCE_CRITERIA = {
  praise: 'Speaks well of the topic, including recommending it or calling it a highlight',
  complain: 'Speaks badly of the topic, including saying it was missing, disappointing, overpriced or a problem',
  mixed: 'Speaks of the topic both well and badly, or only states a fact about it without judging it',
  off: "Never discusses the topic, not even in other words (a synonym, a translation, a variant spelling, staff named instead of 'staff')",
};
const ANSWER_CRITERIA = {
  yes: 'Its answer to the question is yes',
  no: 'Its answer to the question is no',
  unclear: 'Speaks to the question without a clear yes or no',
  none: "Doesn't speak to the question",
};

// Judgements being asked right now, by memo key, so a second caller after the
// same one (an Ask's rows, read by the client while the server caches them)
// waits for it instead of paying for it twice.
const pending = new Map<string, Promise<string | null>>();

// One judgement per text — memoised, the rest asked in batches with each text
// inside its own question. All or nothing: a count missing a failed batch would
// understate, so any failure returns null and the caller keeps its old display.
// `ask` builds the question for one text (and its index), `read` its answer.
async function judge<T extends string>(kind: string, about: string, state: Record<string, unknown>, texts: string[], ask: (text: string, i: number) => Question, read: (answer: any) => T | undefined): Promise<T[] | null> {
  if (!jevAvailable()) return null;
  const memo = texts.map((t) => memoKey(kind, about, t));
  const out: (T | null)[] = memo.map((k) => (getMemo.get(k)?.v as T | undefined) ?? null);
  const elsewhere: Promise<void>[] = [];
  const todo: number[] = [];
  const settle = new Map<string, (v: string | null) => void>();
  out.forEach((v, i) => {
    if (v != null) return;
    const k = memo[i]!;
    const p = pending.get(k);
    if (p) { elsewhere.push(p.then((w) => { out[i] = w as T | null; })); return; }
    pending.set(k, new Promise((resolve) => settle.set(k, resolve)));
    todo.push(i);
  });
  const clipped = texts.map(clip);
  await Promise.all(batches(todo, clipped).map(async (batch) => {
    const answers = await evaluate(kind, state, Object.fromEntries(batch.map((i, j) => [`r${j}`, ask(clipped[i]!, i)])));
    const now = Date.now();
    for (const [j, i] of batch.entries()) {
      const v = answers ? read(answers[`r${j}`]) : undefined;
      if (v != null) { out[i] = v; putMemo.run(memo[i]!, v, now); }
    }
  }));
  for (const i of todo) { settle.get(memo[i]!)?.(out[i] ?? null); pending.delete(memo[i]!); }
  await Promise.all(elsewhere);
  return out.every((v) => v != null) ? (out as T[]) : null;
}

const inCriteria = <T extends string>(criteria: Record<T, unknown>) => (a: any): T | undefined =>
  typeof a?.choice === 'string' && a.choice in criteria ? (a.choice as T) : undefined;
const yesNo = (a: any): '1' | '0' | undefined => (typeof a?.noul === 'number' ? (a.noul >= 0.5 ? '1' : '0') : undefined);

// Each text's stance on `topic` (a chip's label, a search's query).
export const stancesFor = (topic: string, texts: string[]): Promise<Stance[] | null> =>
  judge('stance', topic, { topic }, texts,
    (review) => choice({ question: 'How does this review talk about `topic`?', review }, STANCE_CRITERIA), inCriteria(STANCE_CRITERIA));

// What each comment says of an Option (see web/tally.ts): for or against it as
// an answer to the Thread's question, not whether it speaks well of it, so on
// "the most dangerous submission?" "people rip kimuras" is for the kimura. Jev
// chooses for or against, mapped to praise and complain: offered those, or
// asked whether a comment recommends it, it read every warning as against.
// Read with the comment it replies to, so a bare "this" carries its parent's
// stance. `option` describes it for the model and `others` names the thread's
// other Options, so talk of one of them, however alike its name, reads as not
// about this one. The criteria spell out the cases Jev got wrong (praise read
// as mixed, thanks read as agreement, a gripe about every instructional read
// as one about this one); described as objects with examples instead, they
// read no better on the labelled threads and cost ~35% more tokens. The memo
// is keyed by `name` and these criteria, so a re-listing that words the
// description differently reads nothing twice, and changed criteria read
// everything afresh.
const OPTION_CRITERIA = {
  for: 'Gives it as an answer to `thread` or backs it as one. Naming it counts, and so does an answer with a small caveat',
  against: 'Argues it is not a good answer to `thread`, it in particular, not just a whole kind of thing it belongs to',
  mixed: 'Weighs a drawback that matters for what the asker needs against its good points without settling, or mentions it without a verdict (owns it, is considering it)',
  off: 'Never speaks of it: speaks only of one of `others` (even one with a similar name), only of a whole kind of thing, only asks a question, or speaks of something else',
};
const REPLY_CRITERIA = {
  for: 'Gives it as an answer to `thread` or backs it as one, including by agreeing with `replying_to` where that gives it ("this", "+1", "same")',
  against: 'Argues it is not a good answer to `thread`, it in particular, including by disagreeing with `replying_to` where that gives it',
  mixed: OPTION_CRITERIA.mixed,
  off: 'Never speaks of it, neither in its own words nor by agreeing or disagreeing with `replying_to` about it. Thanking `replying_to` or asking it something is not agreeing with it, and speaking only of one of `others` is not speaking of it',
};
const STANCE_OF = { for: 'praise', against: 'complain', mixed: 'mixed', off: 'off' } as const;
const OPTION_READ = Bun.hash(JSON.stringify([OPTION_CRITERIA, REPLY_CRITERIA])).toString(36);
export const optionStancesFor = (thread: string, name: string, option: string, others: string, comments: { text: string; parent?: string }[]): Promise<Stance[] | null> =>
  judge('option', `${thread}\u0000${name}\u0000${OPTION_READ}`, { thread, option, others }, comments.map((c) => `${c.parent ?? ''}\u0000${c.text}`),
    (_, i) => {
      const { text, parent } = comments[i]!;
      return parent
        ? choice({ question: 'How does this comment, a reply to `replying_to`, speak of `option` as an answer to `thread`?', comment: clip(text), replying_to: clip(parent) }, REPLY_CRITERIA)
        : choice({ question: 'How does this comment speak of `option` as an answer to `thread`?', comment: clip(text) }, OPTION_CRITERIA);
    },
    (a) => { const k = inCriteria(OPTION_CRITERIA)(a); return k && STANCE_OF[k]; });

// Each text's answer to an Ask's `question`.
export const answersFor = (question: string, texts: string[]): Promise<Answer[] | null> =>
  judge('answer', question, { question }, texts,
    (review) => choice({ question: 'What does this review say in answer to `question`?', review }, ANSWER_CRITERIA), inCriteria(ANSWER_CRITERIA));

// A chip's or a Search's reviews read for their stance on `topic`: the trusted
// ones with text, the same reviews its TrueScore counts, up to MAX_JUDGED. Null
// when Jev couldn't read them all.
export async function stanceOfReviews(topic: string, reviews: Review[]): Promise<StanceResult | null> {
  const readable = reviews.filter((r) => isTrusted(r.reviewerReviewCount) && r.text.trim().length > 1);
  const read = readable.slice(0, MAX_JUDGED);
  if (!read.length) return jevAvailable() ? { stance: countStances([]), stances: {} } : null;
  const labels = await stancesFor(topic, read.map((r) => r.text));
  if (!labels) return null;
  const stances = Object.fromEntries(read.map((r, i) => [r.reviewId, labels[i]!]));
  return { stance: countStances(labels), stances, ...(readable.length > read.length ? { of: readable.length } : {}) };
}

// Summary points need the support of this many reviews to be shown — the
// prompt's own "2+ reviewers" rule, enforced instead of trusted.
export const MIN_SUPPORT = 2;
// Supporting reviews a bullet carries for its click-through.
const QUOTES_MAX = 20;

// Per point, the indices of the texts that make it — every text checked: a
// keyword shortlist kept the same points but missed 28% of their support.
export async function supportFor(points: string[], texts: string[]): Promise<number[][] | null> {
  if (!jevAvailable() || !points.length) return null;
  const support = await Promise.all(points.map(async (point) => {
    const says = await judge('point', point, { point }, texts,
      (review) => noul({ question: 'Does this review say what `point` says, or a clear part of it?', review }), yesNo);
    return says && texts.flatMap((_, i) => (says[i] === '1' ? [i] : []));
  }));
  return support.every(Boolean) ? (support as number[][]) : null;
}

// How many of `texts` (a rival's mentions) say they'd rather go to `rival` than `place`.
export async function preferredCount(place: string, rival: string, texts: string[]): Promise<number | null> {
  if (!texts.length) return 0;
  const says = await judge('rival', `${place}\u0000${rival}`, { place: place || 'this place', rival }, texts,
    (review) => noul({ question: "Does this review say `rival` is better than `place`, somewhere they'd rather go?", review }), yesNo);
  return says && says.filter((v) => v === '1').length;
}

// textReviewsFor dates each review for the model ("[2026-09-14] …"); a quote
// shown to a person drops it.
const undated = (text: string) => text.replace(/^\[(?:\d{4}-\d{2}-\d{2}|undated)\] /, '');
// A rival's mentions: reviews holding its name, or failing that its longest word
// ("Mustafa" for "Mustafa's Gemüse Kebap"), as reviewers rarely write it in full.
export const mentioning = (texts: string[], name: string): string[] => {
  const full = fold(name).replace(/['’]s\b/g, '');
  const word = full.split(/\s+/).filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)[0];
  return texts.filter((t) => { const f = fold(t); return f.includes(full) || (!!word && f.includes(word)); });
};

// A summary with its receipts: each bullet carries how many reviews make its
// point and the first of them, a bullet fewer than MIN_SUPPORT make is dropped,
// and an alternative stays only if as many reviews say they'd rather go there.
// Unchanged when Jev can't check it — the summary shows as it always did.
export async function withReceipts(summary: Summary, { placeName, reviewTexts }: Subject): Promise<Summary> {
  // Google hands some reviews over twice; a point is made once per reviewer.
  const texts = [...new Set(reviewTexts)];
  const alternatives = summary.alternatives ?? [];
  const [support, preferred] = await Promise.all([
    supportFor(summary.highlights.map((h) => h.text), texts),
    Promise.all(alternatives.map((alt) => preferredCount(placeName, alt, mentioning(texts, alt)))),
  ]);
  if (!support) return summary;
  const highlights = summary.highlights
    .map((h, k) => ({ ...h, support: support[k]!.length, quotes: support[k]!.slice(0, QUOTES_MAX).map((i) => undated(texts[i]!)) }))
    .filter((h) => h.support >= MIN_SUPPORT);
  const checked = preferred.every((n) => n != null);
  const kept = checked ? alternatives.filter((_, i) => preferred[i]! >= MIN_SUPPORT) : alternatives;
  return {
    ...summary,
    highlights,
    alternatives: kept,
    ...(checked ? { preferredBy: Object.fromEntries(kept.map((alt) => [alt, preferred[alternatives.indexOf(alt)]!])) } : {}),
  };
}

// Whether a summary already carries its receipts (summaries cached before Jev don't).
export const hasReceipts = (summary: Summary): boolean => summary.highlights.every((h) => h.support != null);
