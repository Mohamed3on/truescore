// A Summary's Receipts (CONTEXT.md: Receipt): which reviews make each of its
// points, and which better alternatives reviewers actually prefer — the one
// policy the server and the extension both keep, over a SupportReader port
// (Jev in-process on the server, the server's endpoints from the extension).
import type { Review } from './index';
import type { Answer, StanceResult } from './stance';
import type { Backing, Divided } from './wire';

// Summary points need the support of this many reviews to be shown — the
// prompt's own "2+ reviewers" rule, enforced instead of trusted.
const MIN_SUPPORT = 2;

// A topic shows as divided when the smaller side holds at least this share of
// the reviews taking one: 100 liking it and 3 not is a complaint, not a split.
const MIN_MINORITY = 0.1;

// Supporting reviews a receipt carries for its click-through: the newest.
const QUOTES_MAX = 20;

// A standout chip's read of the reviews naming it, as far as a client holds it.
export type ChipRead = Partial<StanceResult> & { reviews?: Review[] };

export type SupportReader = {
  // Per point, the indices of `texts` that make it; null when they couldn't all be read.
  support: (points: string[], texts: string[]) => Promise<number[][] | null>;
  // Each text's answer to `question`.
  answers: (question: string, texts: string[]) => Promise<Answer[] | null>;
};

export type Receipt = { support: number; quotes: string[] };

// A better alternative the model named, with the reviews naming it — a promise
// when finding them takes a search, so it runs beside the points' read.
export type Rival = { name: string; texts: string[] | Promise<string[]> };

// `points` is aligned with the points asked about, null where too few reviews
// make one; `alternatives` the rivals kept, absent when they couldn't be read.
export type Receipts = { points: (Receipt | null)[]; alternatives?: (Receipt & { name: string })[] };

// textReviewsFor dates each review for the model ("[2026-09-14] …"); a quote
// shown to a person drops it.
const undated = (text: string) => text.replace(/^\[(?:\d{4}-\d{2}-\d{2}|undated)\] /, '');
const dateOf = (text: string) => /^\[(\d{4}-\d{2}-\d{2})\]/.exec(text)?.[1] ?? '';

const receipt = (texts: string[]): Receipt => ({
  support: texts.length,
  quotes: [...texts].sort((a, b) => dateOf(b).localeCompare(dateOf(a))).slice(0, QUOTES_MAX).map(undated),
});

// The reviews naming `rival` that prefer it, when 2+ do and more do than
// don't; null when none is kept, undefined when the reader couldn't read them.
// Asked "Is it better than what this review is about?", Jev read reviews
// preferring the rival as no, and one ranking this Item above it as yes.
const preferring = async ({ name, texts }: Rival, reader: SupportReader): Promise<string[] | null | undefined> => {
  const naming = await texts;

  if (!naming.length) return null;
  const answers = await reader.answers(`Does this reviewer prefer ${name} to the one they're reviewing?`, naming);

  if (!answers) return undefined;
  const yes = naming.filter((_, i) => answers[i] === 'yes');

  return yes.length >= MIN_SUPPORT && yes.length > answers.filter((a) => a === 'no').length ? yes : null;
};

// The Receipts of `points` over the reviews' texts, and the rivals reviewers
// prefer — every one, in the order given; null when the points couldn't be checked.
export async function receiptsFor(points: string[], texts: string[], rivals: Rival[], reader: SupportReader): Promise<Receipts | null> {
  const [support, preferred] = await Promise.all([
    points.length ? reader.support(points, texts) : [],
    Promise.all(rivals.map((r) => preferring(r, reader))),
  ]);

  if (!support) return null;

  const receipts: Receipts = { points: support.map((ids) => (ids.length >= MIN_SUPPORT ? receipt(ids.map((i) => texts[i]!)) : null)) };

  if (!preferred.includes(undefined)) receipts.alternatives = rivals.flatMap((r, i) => (preferred[i] ? [{ name: r.name, ...receipt(preferred[i]) }] : []));

  return receipts;
}

// Whether a topic the model calls divided shows as one, by how many reviews
// take each side of it: MIN_SUPPORT on each, the smaller MIN_MINORITY of both.
// One that doesn't leaves each side to stand as a bullet of its own.
export const isDivided = (liked: number, disliked: number): boolean => {
  const fewer = Math.min(liked, disliked);

  return fewer >= MIN_SUPPORT && fewer >= MIN_MINORITY * (liked + disliked);
};

// A divided topic as its row shows it where its standout chip is on screen too
// (`chip`: null while it's being scored). The chip read every review naming
// the thing for what it says of it; the summary counted the reviews it read
// against a sentence. So the row takes the chip's numbers, and one number shows
// for one thing: none until the chip's land, and no row (null) when they aren't
// split. A topic that is no standout keeps the summary's own, and so does one
// whose chip read no review of it: a throttled search comes back empty, just
// like one for a thing nobody names.
export const chipSplit = (t: Divided, chip: ChipRead | null | undefined): Divided | null => {
  if (!t.item || chip === undefined) return t;

  if (!chip) return { ...t, pos: undefined, neg: undefined };
  const { stance, stances, reviews } = chip;

  if (!stance || stance.praise + stance.complain + stance.mixed === 0) return t;

  if (!isDivided(stance.praise, stance.complain)) return null;

  const side = (says: 'praise' | 'complain', own?: Backing): Backing => ({
    support: stance[says],
    quotes: stances && reviews ? reviews.filter((r) => stances[r.reviewId] === says).slice(0, QUOTES_MAX) : own?.quotes ?? [],
  });

  return { ...t, pos: side('praise', t.pos), neg: side('complain', t.neg) };
};
