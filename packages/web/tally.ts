import { countsInTally, stripAccents, type ListedOption, type LlmOverrides, type OptionTally, type Stance, type TallyCount, type TallyEvent, type Thread, type ThreadComment } from '@truescore/gmaps-shared';
import { db } from './db';
import { optionStancesFor } from './jev';
import { listOptions, type ThreadOption } from './llm';

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

// The counted comments that name any of `names`, or reply below a comment (or a
// post) that does: a bare "this" speaks of what its parent named. Only these are
// read, so the rest of a thread costs nothing.
export const naming = (thread: Thread, names: string[]): ThreadComment[] => {
  const needles = [...new Set(names.map(words))].filter((n) => n.trim().length > 1);
  const says = (text: string) => needles.some((n) => text.includes(n));
  const byId = new Map(thread.comments.map((c) => [c.id, c]));
  const inPost = says(words(`${thread.title} ${thread.text}`));
  const memo = new Map<string, boolean>();
  const named = (c: ThreadComment): boolean => {
    let v = memo.get(c.id);
    if (v == null) {
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      v = says(words(c.body)) || (parent ? named(parent) : !c.parentId && inPost);
      memo.set(c.id, v);
    }
    return v;
  };
  return thread.comments.filter((c) => countsInTally(c) && named(c));
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

// Each commenter once, by what their comments say together (comments by
// deleted accounts can't be told apart, so each is its own person), and the
// upvotes of the comments for and against. `reads` holds counted comments only.
export const countOf = (thread: Thread, reads: Record<string, Stance>): TallyCount => {
  const people = new Map<string, Stance[]>();
  const count: TallyCount = { for: 0, against: 0, mixed: 0, upFor: 0, upAgainst: 0 };
  for (const c of thread.comments) {
    const s = reads[c.id];
    if (!s || s === 'off') continue;
    const who = c.author === '[deleted]' ? `[deleted]:${c.id}` : c.author;
    people.set(who, [...(people.get(who) ?? []), s]);
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
const titleOf = (o: ThreadOption, t: ThreadOption['titles'][number]) => `${o.name}'s ${t.name}`;
const describeOption = (o: ThreadOption) =>
  `${o.name}${o.titles.length ? ` (including ${o.titles.map((t) => titleOf(o, t)).join(', ')})` : ''}${also(o.aliases)}`;

// Jev's reads of the comments naming something, kept where they speak of it.
// `name` keys the memo, so it holds the maker for a title: two makers' courses
// can share a name.
async function readsOf(thread: Thread, question: string, name: string, names: string[], description: string): Promise<Record<string, Stance> | null> {
  const byId = new Map(thread.comments.map((c) => [c.id, c]));
  const comments = naming(thread, names);
  const stances = await optionStancesFor(question, name, description,
    comments.map((c) => ({ text: c.body, parent: c.parentId ? byId.get(c.parentId)?.body : undefined })));
  return stances && Object.fromEntries(comments.flatMap((c, i) => (stances[i] === 'off' ? [] : [[c.id, stances[i]!]])));
}

export const listedOf = (o: ThreadOption): ListedOption => {
  const key = keyOf(o.name);
  return { key, name: o.name, titles: o.titles.map((t) => ({ key: `${key}/${keyOf(t.name)}`, name: t.name })) };
};

// One Option's Tally, null when Jev couldn't read it all. A stance on one of
// its titles counts for the Option too (CONTEXT.md: Option).
export async function tallyOption(thread: Thread, question: string, o: ThreadOption): Promise<OptionTally | null> {
  const [own, ...titles] = await Promise.all([
    readsOf(thread, question, o.name, [o.name, ...o.aliases, ...o.titles.flatMap((t) => [t.name, ...t.aliases])], describeOption(o)),
    ...o.titles.map((t) => readsOf(thread, question, `${o.name} / ${t.name}`, [t.name, ...t.aliases], `${titleOf(o, t)}${also(t.aliases)}`)),
  ]);
  if (!own || titles.some((r) => !r)) return null;
  const all = [own, ...titles] as Record<string, Stance>[];
  const reads = Object.fromEntries([...new Set(all.flatMap(Object.keys))].map((id) => [id, combine(all.map((r) => r[id]))!]));
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

// The Options are listed once per set of comments: the same page reopened lists
// nothing again (and Jev's reads are kept, jev_memo), a thread that has grown is
// listed afresh.
db.run('CREATE TABLE IF NOT EXISTS tally_options (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL)');
const getOptions = db.prepare<{ v: string }, [string]>('SELECT v FROM tally_options WHERE k = ?');
const putOptions = db.prepare<void, [string, string, number]>('INSERT OR REPLACE INTO tally_options (k, v, ts) VALUES (?, ?, ?)');

async function listOptionsOf(thread: Thread, question: string, { provider, reasoningEffort }: LlmOverrides, onOption: (o: Partial<ThreadOption>) => void): Promise<void> {
  const counted = thread.comments.filter(countsInTally);
  const k = `${thread.id}:${provider ?? ''}:${Bun.hash(counted.map((c) => c.id).sort().join(',')).toString(36)}`;
  const hit = getOptions.get(k);
  if (hit) return void (JSON.parse(hit.v) as ThreadOption[]).forEach(onOption);
  let chars = 0;
  const bodies = counted.map((c) => c.body).filter((b) => (chars += b.length) <= LIST_CHARS);
  putOptions.run(k, JSON.stringify(await listOptions(question, bodies, onOption, provider, reasoningEffort)), Date.now());
}

// The whole Tally as a stream: each Option as soon as the model names it, its
// count as soon as Jev has read it, while the model is still naming the rest.
// Throws when Jev couldn't read every comment, after streaming what it could.
export async function tallyThread(thread: Thread, write: (e: TallyEvent) => void, overrides: LlmOverrides = {}): Promise<void> {
  const question = questionOf(thread);
  const seen = new Set<string>();
  const counting: Promise<OptionTally | null>[] = [];
  await listOptionsOf(thread, question, overrides, (raw) => {
    const o = tidy(raw);
    const key = keyOf(o.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    write({ type: 'listed', option: listedOf(o) });
    counting.push(tallyOption(thread, question, o).then((t) => {
      if (t) write({ type: 'option', option: t });
      return t;
    }));
  });
  if ((await Promise.all(counting)).some((t) => !t)) throw new Error("Couldn't read every comment right now — try again");
  write({ type: 'done' });
}
