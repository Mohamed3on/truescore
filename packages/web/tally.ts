import { countsInTally, MIN_TALLY_PEOPLE, stripAccents, type ListedOption, type LlmOverrides, type OptionTally, type Stance, type TallyCount, type TallyEvent, type Thread, type ThreadComment } from '@truescore/gmaps-shared';
import { db } from './db';
import { optionStancesFor } from './jev';
import { explainOptions, listOptions, optionsRequest, reasonsRequest, type ThreadOption } from './llm';

// A Reddit Thread's Tally (CONTEXT.md). The model lists the Options and how the
// thread writes them; Jev reads what each comment naming one says of it; the
// counting is done here. The model never counts.

// Guards on what a client sends: more comments than a page loads, or a comment
// longer than Reddit allows, is cut.
const MAX_COMMENTS = 2_000;
const MAX_BODY = 10_000;
const MAX_QUESTION = 3_000;
// The comments the model reads to list Options, in the page's order, up to this
// many characters.
const LIST_CHARS = 300_000;

export const threadOf = (v: unknown): Thread | null => {
  const t = v as Partial<Thread> | undefined;
  if (!t || typeof t.id !== 'string' || !Array.isArray(t.comments)) return null;
  const str = (s: unknown) => (typeof s === 'string' ? s : '');
  const comments = t.comments.slice(0, MAX_COMMENTS).flatMap((c): ThreadComment[] =>
    c && typeof c.id === 'string' && typeof c.body === 'string'
      ? [{
          id: c.id,
          parentId: typeof c.parentId === 'string' ? c.parentId : null,
          author: str(c.author) || '[deleted]',
          score: Number.isFinite(c.score) ? c.score : 0,
          body: c.body.slice(0, MAX_BODY),
          ...(c.bot ? { bot: true } : {}),
        }]
      : []);
  return { id: t.id, title: str(t.title), text: str(t.text), comments };
};

// The question every comment answers: the post's title and text.
const questionOf = ({ title, text }: Thread) => `${title}\n\n${text.slice(0, MAX_QUESTION)}`.trim();

// Text as its words, to find a name in it whole: "Sony's" holds "sony", and a
// link's slug splits at its hyphens.
const words = (s: string) => ` ${stripAccents(s.toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim()} `;
const keyOf = (name: string) => words(name).trim().replace(/ /g, '-');

// The counted comments that name any of `names`, or reply to a comment (or, at
// the top, a post) that does: a bare "this" speaks of what its parent named.
// Only the parent: a reply further down a side conversation ("does it fold
// flat?") can't be told apart from talk of another Option. Nor a parent that
// names one of `rivals` too (a title's siblings): a reply to a brand's case
// made with three of its models speaks of the brand, and Jev would hand its
// agreement to each model. Only these are read, so the rest of a thread costs
// nothing.
export const naming = (thread: Thread, names: string[], rivals: string[] = []): ThreadComment[] => {
  const sayer = (ns: string[]) => {
    const needles = [...new Set(ns.map(words))].filter((n) => n.trim().length > 1);
    return (text: string) => needles.some((n) => text.includes(n));
  };
  const says = sayer(names), rival = sayer(rivals);
  const byId = new Map(thread.comments.map((c) => [c.id, c]));
  const inPost = says(words(`${thread.title} ${thread.text}`));
  return thread.comments.filter((c) => {
    if (!countsInTally(c)) return false;
    const parent = c.parentId ? words(byId.get(c.parentId)?.body ?? '') : undefined;
    return says(words(c.body)) || (parent !== undefined ? says(parent) && !rival(parent) : !c.parentId && inPost);
  });
};

// What several reads say together: for or against when they agree, mixed when
// they disagree or only mention it, nothing when none speaks of it.
export const combine = (stances: Iterable<Stance | undefined>): Stance | undefined => {
  let praise = false, complain = false, mixed = false;
  for (const s of stances) {
    if (s === 'praise') praise = true;
    else if (s === 'complain') complain = true;
    else if (s === 'mixed') mixed = true;
  }
  return praise && complain ? 'mixed' : praise ? 'praise' : complain ? 'complain' : mixed ? 'mixed' : undefined;
};

// Each commenter once, by what their comments say together, and the upvotes of
// the comments for and against. `reads` holds counted comments only.
// Who wrote a comment: comments by deleted accounts can't be told apart, so
// each is its own person.
const personOf = (c: ThreadComment) => (c.author === '[deleted]' ? `[deleted]:${c.id}` : c.author);

export const countOf = (thread: Thread, reads: Record<string, Stance>): TallyCount => {
  const people = new Map<string, Stance[]>();
  const count: TallyCount = { for: 0, against: 0, mixed: 0, upFor: 0, upAgainst: 0 };
  for (const c of thread.comments) {
    const s = reads[c.id];
    if (!s || s === 'off') continue;
    people.set(personOf(c), [...(people.get(personOf(c)) ?? []), s]);
    if (s === 'praise') count.upFor += c.score;
    else if (s === 'complain') count.upAgainst += c.score;
  }
  for (const said of people.values()) {
    const s = combine(said);
    if (s === 'praise') count.for++;
    else if (s === 'complain') count.against++;
    else if (s) count.mixed++;
  }
  return count;
};

const also = (aliases: string[]) => (aliases.length ? `; also written ${aliases.join(', ')}` : '');
// Each title carries its maker's name, so another maker's course of the same
// name reads as not about it.
type Title = ThreadOption['titles'][number];
const titleOf = (o: ThreadOption, t: Title) => `${o.name}'s ${t.name}`;
const describeOption = (o: ThreadOption) =>
  `${o.name}${o.titles.length ? ` (including ${o.titles.map((t) => titleOf(o, t)).join(', ')})` : ''}${also(o.aliases)}`;
const namesOf = (o: ThreadOption) => [o.name, ...o.aliases, ...o.titles.flatMap((t) => [t.name, ...t.aliases])];
// The names that pick an Option's comments among the thread's `all` (telling).
const ownNames = (o: ThreadOption, all: ThreadOption[]) => telling(namesOf(o), all.filter((x) => x !== o).flatMap(namesOf));

// The names that pick a thing's comments: its own, less any that a name of
// something else holds ("twin" beside a Zoe Twin, "mount" beside Danaher's 4x4
// Mount), since a mention of the other would match it too. An Option's own
// titles don't count against it.
export const telling = (mine: string[], others: string[]): string[] => {
  const theirs = others.map(words);
  return mine.filter((n) => { const w = words(n); return !theirs.some((t) => t.includes(w)); });
};

// Jev's reads of the comments naming something, kept where they speak of it.
// `name` keys the memo, so it holds the maker for a title: two makers' courses
// can share a name.
async function readsOf(thread: Thread, question: string, name: string, names: string[], description: string, others: string, rivals?: string[]): Promise<Record<string, Stance> | null> {
  const byId = new Map(thread.comments.map((c) => [c.id, c]));
  const comments = naming(thread, names, rivals);
  const stances = await optionStancesFor(question, name, description, others,
    comments.map((c) => ({ text: c.body, parent: c.parentId ? byId.get(c.parentId)?.body : undefined })));
  return stances && Object.fromEntries(comments.flatMap((c, i) => (stances[i] === 'off' ? [] : [[c.id, stances[i]!]])));
}

export const listedOf = (o: ThreadOption): ListedOption => {
  const key = keyOf(o.name);
  return { key, name: o.name, titles: o.titles.map((t) => ({ key: `${key}/${keyOf(t.name)}`, name: t.name })) };
};

// One Option's Tally among the thread's `all`, null when Jev couldn't read it
// all. A stance on one of its titles counts for the Option too (CONTEXT.md:
// Option). A title's `others` add its maker's other titles and the maker at
// large, so a reply naming a sibling ("8a here" under a Pixel 8 Pro) or
// speaking of the whole brand reads as not about it.
export async function tallyOption(thread: Thread, question: string, o: ThreadOption, all: ThreadOption[] = [o]): Promise<OptionTally | null> {
  const rest = all.filter((x) => x !== o);
  const others = rest.map((x) => x.name);
  const [own, ...titles] = await Promise.all([
    readsOf(thread, question, o.name, ownNames(o, all), describeOption(o), others.join(', ')),
    ...o.titles.map((t) => {
      const mine = [t.name, ...t.aliases];
      const siblings = o.titles.filter((x) => x !== t);
      const theirs = siblings.flatMap((x) => [x.name, ...x.aliases]);
      return readsOf(thread, question, titleOf(o, t), telling(mine, [...rest.flatMap(namesOf), ...theirs]),
        `${titleOf(o, t)}${also(t.aliases)}`, [...siblings.map((x) => titleOf(o, x)), `${o.name} in general`, ...others].join(', '),
        telling(theirs, mine));
    }),
  ]);
  if (!own || titles.some((r) => !r)) return null;
  const reads = Object.fromEntries([...new Set([own, ...titles].flatMap((r) => Object.keys(r!)))]
    .map((id) => [id, combine([own, ...titles].map((r) => r![id]))!]));
  const listed = listedOf(o);
  return {
    key: listed.key, name: o.name, count: countOf(thread, reads), reads,
    titles: listed.titles.map((t, i) => ({ ...t, count: countOf(thread, titles[i]!), reads: titles[i]! })),
  };
}

// Each title once, by name, and only the fields the schema promises: a streamed
// Option is checked by nothing until the list ends.
const distinct = <T extends { name: string }>(items: T[]) => {
  const seen = new Set<string>();
  return items.filter((i) => { const k = keyOf(i.name); return !!k && !seen.has(k) && !!seen.add(k); });
};
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : []);
const tidy = (o: Partial<ThreadOption>): ThreadOption => ({
  name: o.name ?? '',
  aliases: strings(o.aliases),
  titles: distinct((o.titles ?? []).flatMap((t) => (typeof t?.name === 'string' ? [{ name: t.name, aliases: strings(t.aliases) }] : []))),
});

// The Options are listed once per set of comments and prompt: the same page
// reopened lists nothing again (and Jev's reads are kept, jev_memo), a thread
// that has grown, or a reworded prompt, lists afresh.
db.run('CREATE TABLE IF NOT EXISTS tally_options (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL)');
const getOptions = db.prepare<{ v: string }, [string]>('SELECT v FROM tally_options WHERE k = ?');
const putOptions = db.prepare<void, [string, string, number]>('INSERT OR REPLACE INTO tally_options (k, v, ts) VALUES (?, ?, ?)');
const LISTING = Bun.hash(optionsRequest('', []).prompt).toString(36);

async function listOptionsOf(thread: Thread, question: string, { provider, reasoningEffort }: LlmOverrides, onOption: (o: Partial<ThreadOption>) => void): Promise<void> {
  const counted = thread.comments.filter(countsInTally);
  const k = `${thread.id}:${provider ?? ''}:${LISTING}:${Bun.hash(counted.map((c) => c.id).sort().join(',')).toString(36)}`;
  const hit = getOptions.get(k);
  if (hit) return void (JSON.parse(hit.v) as ThreadOption[]).forEach(onOption);
  let chars = 0;
  const bodies = counted.map((c) => c.body).filter((b) => (chars += b.length) <= LIST_CHARS);
  putOptions.run(k, JSON.stringify(await listOptions(question, bodies, onOption, provider, reasoningEffort)), Date.now());
}

// Why each Option is rated as it is, a line each, written while Jev counts:
// from the comments that name it (the ones Jev reads), for the Options two or
// more people name. The model writes them in order, so the most-named come
// first: the top of the Tally is what's read first, and its counts aren't in
// yet to rank by. Streamed as written and kept for the same comments; a failure
// costs nothing else, since the counts are the Tally.
db.run('CREATE TABLE IF NOT EXISTS tally_reasons (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL)');
const getReasons = db.prepare<{ v: string }, [string]>('SELECT v FROM tally_reasons WHERE k = ?');
const putReasons = db.prepare<void, [string, string, number]>('INSERT OR REPLACE INTO tally_reasons (k, v, ts) VALUES (?, ?, ?)');
const QUOTE_CHARS = 800;

async function reasonsOf(thread: Thread, question: string, options: ThreadOption[], { provider, reasoningEffort }: LlmOverrides, write: (e: TallyEvent) => void): Promise<void> {
  const index = new Map<ThreadComment, number>();
  const groups = options
    .map((o) => {
      const named = naming(thread, ownNames(o, options));
      return { o, named, people: new Set(named.map(personOf)).size, upvotes: named.reduce((n, c) => n + c.score, 0) };
    })
    .filter((g) => g.people >= MIN_TALLY_PEOPLE)
    .sort((a, b) => b.people - a.people || b.upvotes - a.upvotes)
    .map(({ o, named }) => ({ key: keyOf(o.name), option: o.name, comments: named.map((c) => index.get(c) ?? index.set(c, index.size).get(c)!) }));
  if (!groups.length) return;
  const comments = [...index.keys()].map((c) => c.body.replace(/\s+/g, ' ').slice(0, QUOTE_CHARS));
  const k = `${thread.id}:${provider ?? ''}:${Bun.hash(reasonsRequest(question, comments, groups).prompt).toString(36)}`;
  const hit = getReasons.get(k);
  if (hit) return void Object.entries(JSON.parse(hit.v) as Record<string, string>).forEach(([key, text]) => write({ type: 'why', key, text }));
  try {
    const reasons = await explainOptions(question, comments, groups, (key, text) => { if (text.trim()) write({ type: 'why', key, text: text.trim() }); }, provider, reasoningEffort);
    putReasons.run(k, JSON.stringify(reasons), Date.now());
  } catch (e) {
    console.warn('[tally] reasons failed:', e instanceof Error ? e.message : e);
  }
}

// The whole Tally as a stream: each Option as soon as the model names it, then
// each count once Jev has read it, and alongside, why each is rated as it is.
// Counting waits for the whole list, since a name only picks comments once it's
// known no other Option shares it. Throws when Jev couldn't read every comment,
// after streaming what it could.
export async function tallyThread(thread: Thread, write: (e: TallyEvent) => void, overrides: LlmOverrides = {}): Promise<void> {
  const question = questionOf(thread);
  const options: ThreadOption[] = [];
  await listOptionsOf(thread, question, overrides, (raw) => {
    const o = tidy(raw);
    const key = keyOf(o.name);
    if (!key || options.some((x) => keyOf(x.name) === key)) return;
    options.push(o);
    write({ type: 'listed', option: listedOf(o) });
  });
  const [tallies] = await Promise.all([
    Promise.all(options.map(async (o) => {
      const t = await tallyOption(thread, question, o, options);
      if (t) write({ type: 'option', option: t });
      return t;
    })),
    reasonsOf(thread, question, options, overrides, write),
  ]);
  if (tallies.some((t) => !t)) throw new Error("Couldn't read every comment right now — try again");
  write({ type: 'done' });
}
