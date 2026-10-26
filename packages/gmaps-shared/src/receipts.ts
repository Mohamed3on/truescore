// A Summary's Receipts (CONTEXT.md: Receipt): which reviews make each of its
// points, and which better alternatives reviewers actually prefer — the one
// policy the server and the extension both keep, over a SupportReader port
// (Jev in-process on the server, the server's endpoints from the extension).
import type { Answer } from './stance';

// Summary points need the support of this many reviews to be shown — the
// prompt's own "2+ reviewers" rule, enforced instead of trusted.
const MIN_SUPPORT = 2;

// Supporting reviews a receipt carries for its click-through: the newest.
const QUOTES_MAX = 20;

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

  return {
    points: support.map((ids) => (ids.length >= MIN_SUPPORT ? receipt(ids.map((i) => texts[i]!)) : null)),
    ...(preferred.includes(undefined) ? {} : { alternatives: rivals.flatMap((r, i) => (preferred[i] ? [{ name: r.name, ...receipt(preferred[i]) }] : [])) }),
  };
}
