// What reviewers actually say about a topic, read review by review, in place of
// the 5★/1★ share of every review that merely contains the word: a 5★ review
// calling the parking a nightmare complains about parking, and one that names it
// in passing judges nothing. Jev (TypeSafe's decision model) reads them on the
// server (web/jev.ts); these are the shapes and the counting both clients share.

// A review's stance on a topic. 'mixed' is both, or a mention without a verdict;
// 'off' isn't about the topic at all — the word matched by chance, or the chip is
// a mistranslation ("snake" for a bakery's queue: German Schlange).
export const STANCES = ['praise', 'complain', 'mixed', 'off'] as const;
export type Stance = (typeof STANCES)[number];
export type StanceCounts = Record<Stance, number>;

// A review's answer to an Ask's question.
export const ANSWERS = ['yes', 'no', 'unclear', 'none'] as const;
export type Answer = (typeof ANSWERS)[number];
export type AnswerCounts = Record<Answer, number>;

const tally = <K extends string>(keys: readonly K[], values: Iterable<K | null | undefined>): Record<K, number> => {
  const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const v of values) if (v != null && v in counts) counts[v]++;
  return counts;
};
export const countStances = (stances: Iterable<Stance | null | undefined>): StanceCounts => tally(STANCES, stances);
export const countAnswers = (answers: Iterable<Answer | null | undefined>): AnswerCounts => tally(ANSWERS, answers);

// Fewer opinions than this and a split reads surer than it is, so the mentions
// are shown instead ("2 mentions").
export const MIN_OPINIONS = 2;

// Reviews read per chip, Search or Ask row — a guard, not a sample: chips run to
// ~160 and most searches far fewer. Past it the first are read (a chip's newest,
// a Search's most relevant) and the counts say how many they cover.
export const MAX_JUDGED = 1_000;

// One subject's opinions as every surface shows them: the good count, then the
// bad, always in that order so a column of them scans; or, when too few take a
// side, just how many reviews speak to it. `title` spells out everything, the
// mixed and off-topic reviews included, for the tooltip and the aria-label.
export type Opinions = {
  pos: number;
  neg: number;
  posWord: string;
  negWord: string;
  mentions: number;
  sparse: boolean;
  title: string;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const mentionsText = (n: number) => plural(n, 'mention');

// `of`: how many reviews there were when only some were read (MAX_JUDGED on the
// server), so the counts say what they cover.
const covered = (c: Record<string, number>, of?: number) => {
  const read = Object.values(c).reduce((a, n) => a + n, 0);
  return of && of > read ? [`${read} of ${of} checked`] : [];
};

export const opinionsOf = (c: StanceCounts, of?: number): Opinions => {
  const mentions = c.praise + c.complain + c.mixed;
  const rest = [c.mixed && `${c.mixed} mixed or neutral`, c.off && `${c.off} not about it`].filter(Boolean);
  return {
    pos: c.praise, neg: c.complain, posWord: 'praise', negWord: 'complain', mentions,
    sparse: c.praise + c.complain < MIN_OPINIONS,
    title: [`${c.praise} praise`, `${c.complain} complain`, ...rest, ...covered(c, of)].join(' · '),
  };
};

export const answersOf = (c: AnswerCounts, of?: number): Opinions => {
  const mentions = c.yes + c.no + c.unclear;
  const rest = [c.unclear && `${c.unclear} unclear`, c.none && `${c.none} don't say`].filter(Boolean);
  return {
    pos: c.yes, neg: c.no, posWord: 'yes', negWord: 'no', mentions,
    sparse: c.yes + c.no < MIN_OPINIONS,
    title: [`${c.yes} yes`, `${c.no} no`, ...rest, ...covered(c, of)].join(' · '),
  };
};

// A chip's or a Search's opinions on the wire: the counts, each review's stance
// by reviewId so a client can list exactly the reviews behind a count, and `of`
// the reviews there were when only the first were read.
export type StanceResult = { stance: StanceCounts; stances: Record<string, Stance>; of?: number };

// The polarity an opinion split reads as: more praise than complaints is good.
// The star-share chips grade against the place's overall score instead
// (chipPolarity); a topic's own praise-vs-complaint has no baseline to beat.
export const opinionPolarity = (o: Opinions): 'pos' | 'neg' => (o.pos >= o.neg ? 'pos' : 'neg');

// The net of an opinion split on the −100..100 scale the chips sort by
// (sortChipsByImpact), so a stance chip ranks among star-share ones.
export const opinionPct = (o: Opinions): number => {
  const sided = o.pos + o.neg;
  return sided ? Math.round(((o.pos - o.neg) / sided) * 100) : 0;
};
