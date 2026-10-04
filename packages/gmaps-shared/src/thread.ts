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
export type Thread = { id: string; title: string; text: string; comments: ThreadComment[] };

type Thing = { kind: string; data: Record<string, any> };
type Listing = { data: { children: Thing[] } };

// What Reddit leaves of a deleted or removed comment: nothing to read.
const GONE = new Set(['[deleted]', '[removed]']);

export const threadFromListing = ([post, comments]: [Listing, Listing]): Thread => {
  const p = post.data.children[0]!.data;
  const out: ThreadComment[] = [];
  const walk = (things: Thing[]) => {
    for (const { kind, data: d } of things) {
      if (kind !== 't1') continue;
      if (!GONE.has(d.body)) {
        out.push({
          id: d.id,
          parentId: typeof d.parent_id === 'string' && d.parent_id.startsWith('t1_') ? d.parent_id.slice(3) : null,
          author: d.author,
          score: d.score ?? 0,
          body: d.body,
          ...(d.author === 'AutoModerator' || d.stickied || d.distinguished === 'moderator' ? { bot: true } : {}),
        });
      }
      if (d.replies && typeof d.replies === 'object') walk(d.replies.data.children);
    }
  };
  walk(comments.data.children);
  return { id: p.id, title: p.title ?? '', text: p.selftext ?? '', comments: out };
};

// Whether a comment counts toward a Tally: not a bot's, and not voted to 0 or below.
export const countsInTally = (c: ThreadComment): boolean => !c.bot && c.score >= 1;
