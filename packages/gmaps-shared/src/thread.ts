// A Reddit Thread as a Tally reads it (CONTEXT.md): the post's question and the
// comments the page loaded, flattened from the `.json` listing the page itself
// is built from. "Load more" stubs are skipped, since a Tally reads only what
// the page loaded.

export type ThreadComment = {
  id: string;
  // The comment it replies to; null for one answering the post itself.
  parentId: string | null;
  author: string;
  score: number;
  body: string;
  // AutoModerator, or a stickied or moderator-distinguished note: never counted.
  bot?: boolean;
};

// `author`: who posted it, the "OP" its comments speak to.
export type Thread = { id: string; title: string; text: string; author?: string; comments: ThreadComment[] };

// The fields read off Reddit's listing: the post's (t3), and each comment's (t1).
// `replies` is an empty string when nothing replies.
type Post = { kind: 't3'; data: { id: string; title?: string; selftext?: string; author?: string } };

type Comment = { kind: 't1'; data: { id: string; parent_id?: string; author: string; score?: number; body: string; stickied?: boolean; distinguished?: string | null; replies?: Listing<Thing> | '' } };

// A "load more" stub: comments the page didn't load.
type More = { kind: 'more'; data: { id: string; count: number; children: string[] } };

type Thing = Comment | More;

type Listing<T> = { kind: 'Listing'; data: { children: T[] } };

// What Reddit leaves of a deleted or removed comment: nothing to read.
const GONE = new Set(['[deleted]', '[removed]']);

export const threadFromListing = ([post, comments]: [Listing<Post>, Listing<Thing>]): Thread => {
  const p = post.data.children[0]!.data;
  const out: ThreadComment[] = [];

  const walk = (things: Thing[]) => {
    for (const { kind, data: d } of things) {
      if (kind !== 't1') continue;

      if (!GONE.has(d.body)) {
        const comment: ThreadComment = {
          id: d.id,
          parentId: typeof d.parent_id === 'string' && d.parent_id.startsWith('t1_') ? d.parent_id.slice(3) : null,
          author: d.author,
          score: d.score ?? 0,
          body: d.body,
        };

        if (d.author === 'AutoModerator' || d.stickied || d.distinguished === 'moderator') comment.bot = true;
        out.push(comment);
      }

      if (d.replies && typeof d.replies === 'object') walk(d.replies.data.children);
    }
  };

  walk(comments.data.children);

  const thread: Omit<Thread, 'comments'> = { id: p.id, title: p.title ?? '', text: p.selftext ?? '' };

  if (p.author && p.author !== '[deleted]') thread.author = p.author;

  return { ...thread, comments: out };
};

// Whether a comment counts toward a Tally: not a bot's, and not voted to 0 or below.
export const countsInTally = (c: ThreadComment): boolean => !c.bot && c.score >= 1;
