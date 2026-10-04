// The topic row both clients draw: Google's topic chips and the summary's
// standouts in one row, a standout naming a topic pooled into it, ranked once
// everything is in. Each client builds its own chips; the pooling, the order and
// the motion between renders are the same, so they live here.
import { isTrusted, mergeByReviewId, sortChipsByImpact, statsForReviews, type ChipLike, type Review } from './index';
import { countStances, opinionPct, opinionsOf, type Stance, type StanceCounts } from './stance';

export type ChipState = 'loading' | 'done' | 'error';

// A topic and a standout naming the same thing, pooled: both review sets, each
// review once, with Jev's reads of both (asked the same question, so nothing is
// read again) — unread unless both were read.
type Reads = { reviews?: Review[]; stances?: Record<string, Stance> };
export const pooledReads = (a: Reads, b: Reads) => {
  const reviews = mergeByReviewId(a.reviews ?? [], b.reviews ?? []);
  const stances = a.stances && b.stances ? { ...b.stances, ...a.stances } : undefined;
  const readable = reviews.filter((r) => isTrusted(r.reviewerReviewCount) && r.text.trim().length > 1).length;
  return {
    reviews,
    stances,
    stance: stances && countStances(Object.values(stances)),
    of: stances && readable > Object.keys(stances).length ? readable : undefined,
    score: statsForReviews(reviews),
    count: reviews.length,
  };
};

// The row's order. While anything is still loading it keeps the order it had
// (`prev`, by key), newcomers joining at the end, loading ones last, so nothing
// moves under a thumb. Once everything is in it sorts once: by what reviewers say
// when every chip is read (the praise share among those taking a side, weighted
// by how many do), else by star share against the place's own score. Any that
// failed go last.
export type RowChip = ChipLike & { key: string; state: ChipState; stance?: StanceCounts };
export const chipRowOrder = <T extends RowChip>(chips: T[], prev: string[], settled: boolean, overallPct: number): T[] => {
  if (!settled) {
    const byKey = new Map(chips.map((c) => [c.key, c]));
    return [
      ...prev.flatMap((k) => byKey.get(k) ?? []),
      ...chips.filter((c) => !prev.includes(c.key)).sort((a, b) => Number(a.state === 'loading') - Number(b.state === 'loading')),
    ];
  }
  const done = chips.filter((c) => c.state === 'done');
  const sorted = done.every((c) => c.stance)
    ? sortChipsByImpact(done.map((c) => { const o = opinionsOf(c.stance!); return { c, score: { scorePct: opinionPct(o) }, count: o.pos + o.neg }; }), 0).map((r) => r.c)
    : sortChipsByImpact(done, overallPct);
  return [...sorted, ...chips.filter((c) => c.state !== 'done')];
};

// Swap a row's chips. One that moved glides from where it was, and one new to a
// row already on screen rises in, staggered, so chips landing late slot in rather
// than pop. One re-rendered mid-entrance carries on from where it was. Nothing
// animates on the row's first paint; with reduced motion nothing moves and
// newcomers only fade. `tail` follows the chips (a note) and never animates.
type ChipPlace = { rect: DOMRect; opacity: number };
const placeOf = (c: HTMLElement): ChipPlace => ({ rect: c.getBoundingClientRect(), opacity: Number(getComputedStyle(c).opacity) });
// The design system's one ease-out (DESIGN.md), as both clients' CSS spells it.
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
export const replaceChips = (list: HTMLElement, chips: { key: string; el: HTMLElement }[], tail: Node[] = []) => {
  const before = new Map([...list.querySelectorAll<HTMLElement>('[data-key]')].map((c) => [c.dataset.key!, placeOf(c)]));
  for (const c of chips) c.el.dataset.key = c.key;
  list.replaceChildren(...chips.map((c) => c.el), ...tail);
  if (!before.size) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Each lands on its own opacity: a disabled chip re-rendered disabled doesn't flash.
  const placed = chips.map((c) => ({ el: c.el, was: before.get(c.key), is: placeOf(c.el) }));
  let arriving = 0;
  for (const { el, was, is } of placed) {
    if (!was) {
      el.animate(still ? [{ opacity: 0 }, { opacity: is.opacity }] : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: is.opacity, transform: 'none' }],
        { duration: 300, delay: 50 * arriving++, easing: EASE, fill: 'backwards' });
      continue;
    }
    const dx = still ? 0 : was.rect.left - is.rect.left;
    const dy = still ? 0 : was.rect.top - is.rect.top;
    if (dx || dy || was.opacity !== is.opacity) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)`, opacity: was.opacity }, { transform: 'none', opacity: is.opacity }], { duration: 250, easing: EASE });
    }
  }
};
