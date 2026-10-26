import { choice, noul, TypeSafeClient, type EntryType, type Question, type Questions, type SystemOneRequest, type Usage } from '@typesafe-ai/sdk';
import { receiptsFor, stripAccents, trustedStance, type Answer, type Quote, type Review, type Stance, type StanceReader, type StanceResult, type Summary, type SupportReader } from '@truescore/gmaps-shared';
import { z } from 'zod';
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

// Jev's client as this module uses it: a request's answers, decoded on arrival
// (REPLIES), and the input tokens it cost.
type Client = { systemOne: (request: SystemOneRequest<Questions>) => PromiseLike<{ answers: object; usage: Pick<Usage, 'input_tokens'> }> };

// An answer as Jev sends it back: a choice's label, or a yes/no's chance of
// yes. Anything else reads as no answer.
const REPLY = z.object({ choice: z.string().optional().catch(undefined), noul: z.number().optional().catch(undefined) }).optional().catch(undefined);
const REPLIES = z.record(z.string(), REPLY).catch({});

type Reply = z.infer<typeof REPLY>;

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
async function evaluate(kind: string, state: EntryType, questions: Questions): Promise<Record<string, Reply> | null> {
  if (!client || !jevAvailable()) return null;

  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((go) => waiting.push(go));
  inFlight++;

  try {
    const { answers, usage } = await client.systemOne({ state, questions });
    spent[kind] = (spent[kind] ?? 0) + usage.input_tokens;
    console.log(`[jev] ${kind} q=${Object.keys(questions).length} in=${usage.input_tokens}`);

    return REPLIES.parse(answers);
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
async function judge<T extends string>(kind: string, about: string, state: EntryType, texts: string[], ask: (text: string, i: number) => Question, read: (reply: Reply) => T | undefined): Promise<T[] | null> {
  if (!jevAvailable()) return null;
  const memo = texts.map((t) => memoKey(kind, about, t));
  const out: (string | null)[] = memo.map((k) => getMemo.get(k)?.v ?? null);
  const elsewhere: Promise<void>[] = [];
  const todo: number[] = [];
  const settle = new Map<string, (v: string | null) => void>();
  out.forEach((v, i) => {
    if (v != null) return;
    const k = memo[i]!;
    const p = pending.get(k);

    if (p) {
      elsewhere.push(p.then((w) => { out[i] = w; }));

      return;
    }

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

  // SAFETY: each read is one this kind's `read` returned: just now, or kept or
  // pending under a memo key, which holds the kind.
  return out.every((v) => v != null) ? (out as T[]) : null;
}

// SAFETY: `in` has just found the label among the criteria.
const inCriteria = <T extends string>(criteria: Record<T, string>) => (reply: Reply): T | undefined =>
  reply?.choice !== undefined && reply.choice in criteria ? (reply.choice as T) : undefined;

const yesNo = (reply: Reply): '1' | '0' | undefined => (reply?.noul === undefined ? undefined : reply.noul >= 0.5 ? '1' : '0');

// Each text's stance on `topic` (a chip's label, a search's query).
export const stancesFor = (topic: string, texts: string[]): Promise<Stance[] | null> =>
  judge('stance', topic, { topic }, texts,
    (review) => choice({ question: 'How does this review talk about `topic`?', review }, STANCE_CRITERIA), inCriteria(STANCE_CRITERIA));

// What each comment says of an Option (see web/tally.ts): for or against it as
// an answer to the Thread's question, not whether it speaks well of it, so on
// "the most dangerous submission?" "people rip kimuras" is for the kimura. Jev
// chooses for or against, mapped to praise and complain: offered those, or
// asked whether a comment recommends it, it read every warning as against.
// What for and against mean is spelled out for the two kinds of question the
// labelled threads ask: given the bare rule, it read an owner's story or a
// drawback in a recommendation thread as a vote. Read with the comment it
// replies to, so a bare "this" carries its parent's stance. `option`
// describes it for the model and `others` names the thread's other Options, so
// talk of one of them, however alike its name, reads as not about this one.
// The criteria spell out the cases Jev got wrong (praise read as mixed, a
// tier list's "it's alright, you're not missing out" read as praise, thanks
// read as agreement, a gripe about every instructional read as one about this
// one); described as objects with examples instead, they read no better on the
// labelled threads and cost ~35% more tokens. The memo is keyed by `name` and
// these criteria, so a re-listing that words the description differently
// reads nothing twice, and changed criteria read everything afresh.
const OPTION_CRITERIA = {
  for: 'Puts it forward as an answer to `thread` or says what makes it one (where `thread` asks for recommendations: recommends it or speaks well of it; where it asks for the worst or most dangerous: calls it bad or dangerous). Naming it as an answer counts, and so does one with a small caveat',
  against: 'Argues it is a poor answer to `thread` (where `thread` asks for recommendations: advises against it or speaks badly of it; where it asks for the worst or most dangerous: calls it fine or safe), and of it in particular, not just of a whole kind of thing it belongs to',
  mixed: 'Weighs it as an answer both ways without settling (where `thread` asks for recommendations: weighs a drawback that matters for what the asker needs against its good points, or calls it merely okay, nothing to seek out), or mentions it without a verdict (owns it, is considering it)',
  off: 'Never speaks of it: speaks only of one of `others` (even one with a similar name), only of a whole kind of thing, only asks a question, or speaks of something else',
};

const REPLY_CRITERIA = {
  for: 'Puts it forward as an answer to `thread` or says what makes it one (where `thread` asks for recommendations: recommends it or speaks well of it; where it asks for the worst or most dangerous: calls it bad or dangerous), including by agreeing with `replying_to` where that puts it forward ("this", "+1", "same")',
  against: 'Argues it is a poor answer to `thread` (where `thread` asks for recommendations: advises against it or speaks badly of it; where it asks for the worst or most dangerous: calls it fine or safe), and of it in particular, including by disagreeing with `replying_to` where that puts it forward',
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
    (a) => {
      const k = inCriteria(OPTION_CRITERIA)(a);

      return k && STANCE_OF[k];
    });

// Whether each comment answers the Thread's question about the things its post
// lists as a group (web/tally.ts): such a comment names none of them, yet is
// then read for each.
const GROUP_QUESTION = 'Does this comment give a verdict on the options `thread` lists as a group: all of them, none of them, or all the rest ("all of the above", "none of those", "the others are fine")?';

export const groupAnswersFor = (thread: string, comments: string[]): Promise<boolean[] | null> =>
  judge('group', `${thread}\u0000${Bun.hash(GROUP_QUESTION).toString(36)}`, { thread }, comments,
    (comment) => noul({ question: GROUP_QUESTION, comment }), yesNo)
    .then((says) => says && says.map((v) => v === '1'));

// Whether the Thread's post asks about each thing it names (web/tally.ts): "is
// the Donkey worth it?" does, so a bare "yes" under it speaks of the Donkey;
// "Rewe's are the worst, where else?" names Rewe as what the asker wants away
// from, so an answer to it isn't one about Rewe.
const ASKED_QUESTION = 'Does `thread` ask about `option` itself, for verdicts on it or whether to choose it, rather than naming it only as background: one the asker owns, has tried or wants to get away from?';

export const askedAboutFor = (thread: string, options: string[]): Promise<boolean[] | null> =>
  judge('asked', `${thread}\u0000${Bun.hash(ASKED_QUESTION).toString(36)}`, { thread }, options,
    (option) => noul({ question: ASKED_QUESTION, option }), yesNo)
    .then((says) => says && says.map((v) => v === '1'));

// Whether each Option is one the answers put in their own words rather than
// name (web/tally.ts): "make them at home" is, and its answers ("they're so
// easy to make", a recipe link) are found by asking, not by its name.
const DESCRIBED_QUESTION = 'Is `option` a way of doing it, or another thing people describe in their own words, rather than a thing with a name of its own, like a product, a place, a store, a person or a technique?';

export const describedFor = (thread: string, options: string[]): Promise<boolean[] | null> =>
  judge('described', `${thread}\u0000${Bun.hash(DESCRIBED_QUESTION).toString(36)}`, { thread }, options,
    (option) => noul({ question: DESCRIBED_QUESTION, option }), yesNo)
    .then((says) => says && says.map((v) => v === '1'));

// Whether each comment speaks, in any words, of an Option the answers
// describe rather than name (describedFor).
const FORWARD_QUESTION = 'Does this comment clearly put `option` forward, or argue against it, in any words, as an answer to `thread`?';

export const putsForwardFor = (thread: string, name: string, option: string, comments: string[]): Promise<boolean[] | null> =>
  judge('forward', `${thread}\u0000${name}\u0000${Bun.hash(FORWARD_QUESTION).toString(36)}`, { thread, option }, comments,
    (comment) => noul({ question: FORWARD_QUESTION, comment }), yesNo)
    .then((says) => says && says.map((v) => v === '1'));

// Each text's answer to an Ask's `question`.
export const answersFor = (question: string, texts: string[]): Promise<Answer[] | null> =>
  judge('answer', question, { question }, texts,
    (review) => choice({ question: 'What does this review say in answer to `question`?', review }, ANSWER_CRITERIA), inCriteria(ANSWER_CRITERIA));

// Jev in-process, as the shared Stance read and Receipts reach it.
const jevReader: StanceReader & SupportReader = { reachable: jevAvailable, stances: stancesFor, support: supportFor, answers: answersFor };

// A chip's or a Search's reviews read for their stance on `topic` (trustedStance).
export const stanceOfReviews = (topic: string, reviews: Review[]): Promise<StanceResult | null> => trustedStance(topic, reviews, jevReader);

// Per point, the indices of the texts that make it — every text checked: a
// keyword shortlist kept the same points but missed 28% of their support.
export async function supportFor(points: string[], texts: string[]): Promise<number[][] | null> {
  if (!jevAvailable() || !points.length) return null;

  const support = await Promise.all(points.map(async (point) => {
    const says = await judge('point', point, { point }, texts,
      (review) => noul({ question: 'Does this review say what `point` says, or a clear part of it?', review }), yesNo);

    return says && texts.flatMap((_, i) => (says[i] === '1' ? [i] : []));
  }));

  return support.every((s) => s !== null) ? support : null;
}

// A rival's mentions: reviews holding its name, or failing that its longest word
// ("Mustafa" for "Mustafa's Gemüse Kebap"), as reviewers rarely write it in full.
const mentioning = (texts: string[], name: string): string[] => {
  const full = fold(name).replace(/['’]s\b/g, '');
  const word = full.split(/\s+/).filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)[0];

  return texts.filter((t) => {
    const f = fold(t);

    return f.includes(full) || (!!word && f.includes(word));
  });
};

// A summary with its Receipts (receiptsFor): each bullet carries how many
// reviews make its point and the newest of them, a bullet too few make is
// dropped, and an alternative stays only if reviewers naming it prefer it.
// Unchanged when Jev can't check it — the summary shows as it always did.
export async function withReceipts(summary: Summary, { reviewTexts }: Subject): Promise<Summary> {
  // Google hands some reviews over twice; a point is made once per reviewer.
  const texts = [...new Set(reviewTexts)];
  const rivals = (summary.alternatives ?? []).map((name) => ({ name, texts: mentioning(texts, name) }));
  const checked = await receiptsFor(summary.highlights.map((h) => h.text), texts, rivals, jevReader);

  if (!checked) return summary;
  const { points, alternatives } = checked;

  const receipted: Summary = {
    ...summary,
    highlights: summary.highlights.flatMap((h, k) => (points[k] ? [{ ...h, ...points[k] }] : [])),
  };

  if (alternatives) {
    receipted.alternatives = alternatives.map((a) => a.name);
    receipted.preferredBy = Object.fromEntries(alternatives.map((a) => [a.name, a.support]));
  }

  return receipted;
}

// Whether a summary already carries its receipts (summaries cached before Jev don't).
export const hasReceipts = (summary: Summary): boolean => summary.highlights.every((h) => h.support != null);

// A summary as a client is sent it: each receipt's quotes the reviews they are,
// where `reviews` holds them, so it shows them as its review cards — the web has
// none of a place's reviews to find them in. Stored as the texts, which an
// extension's own scrape may not match.
export const quotingReviews = (summary: Summary, reviews: Review[] | undefined): Summary => {
  if (!reviews?.length) return summary;
  // Keyed by text, so a quote that's already a review finds nothing and stays.
  const byText = new Map<Quote, Review>(reviews.map((r) => [r.text, r]));

  return { ...summary, highlights: summary.highlights.map((h) => (h.quotes ? { ...h, quotes: h.quotes.map((q) => byText.get(q) ?? q) } : h)) };
};
