// A summary drawn as it streams in, the same in every client: each bullet
// written in place in its own row, dim until the summary is checked against
// the reviews. The check then folds away the bullets too few reviews make, and
// a list it re-sorts fades out and back in, sorted: bullets sliding past each
// other cross their text, and folding moved ones shut and open again pumps the
// panel. Each client builds and fills its own rows; the order, the dimming and
// the motion are the same, so they live here, beside the topic row's.

// The daylight skin's ease (DESIGN.md).
const EASE = 'cubic-bezier(0.25, 1, 0.5, 1)';
const DIM = '0.5';
export const animates = (node: HTMLElement) => typeof node.animate !== 'undefined' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

// Markdown written into `node`, rewritten only when it changed: a streamed
// partial redraws just what grew.
export const writeMarkdown = (node: HTMLElement, text: string, render: (node: HTMLElement, text: string) => void) => {
  if (node.dataset.md === text) return;
  node.dataset.md = text;
  render(node, text);
};

// Folds `node` shut and removes it, so what follows closes up instead of jumping.
export const foldAway = async (node: HTMLElement) => {
  if (animates(node)) {
    node.style.overflow = 'hidden';
    await node.animate([{ height: `${node.offsetHeight}px` }, { height: '0px', opacity: 0, marginTop: '0px', marginBottom: '0px' }], { duration: 200, easing: EASE })
      .finished.catch(() => {});
  }

  node.remove();
};

const fadeOut = (node: HTMLElement) =>
  animates(node) ? node.animate([{ opacity: 0 }], { duration: 120, easing: EASE, fill: 'forwards' }).finished.catch(() => {}) : undefined;

export const fadeIn = (node: HTMLElement) => {
  if (!animates(node)) return;

  for (const a of node.getAnimations()) a.cancel();
  node.animate([{ opacity: 0 }, {}], { duration: 220, easing: EASE });
};

// A drafted row rises into place as it's added, instead of popping in: to the
// dimmed draft's opacity, unless the row is never dimmed.
export const enter = (node: HTMLElement, opacity = DIM) => {
  if (animates(node)) node.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity, transform: 'none' }], { duration: 180, easing: EASE });
};

const brighten = (node: HTMLElement) => {
  if (animates(node)) node.animate([{ opacity: DIM }, {}], { duration: 200, easing: EASE });
};

type Row = { el: HTMLElement; key: string; drawn: string };

// One list's bullets, drawn into `list` after whatever it already holds (a
// title, say): `draft` with each version of them as the model writes, `settle`
// with the checked ones in their final order, or straight away for a summary
// that was never drafted (a cached one), which then draws at once. `make`
// builds a row and `fill` draws an item into it, again only when it changed.
export const mountBullets = <T>(list: HTMLElement, key: (item: T) => string, make: () => HTMLElement, fill: (row: HTMLElement, item: T) => void) => {
  let rows: Row[] = [];
  const fresh = (): Row => ({ el: make(), key: '', drawn: '' });

  const draw = (row: Row, item: T) => {
    const drawn = JSON.stringify(item);

    if (row.drawn === drawn) return;
    row.drawn = drawn;
    row.key = key(item);
    fill(row.el, item);
  };

  return {
    draft(items: T[]) {
      for (const [i, item] of items.entries()) {
        if (!rows[i]) {
          rows[i] = fresh();
          rows[i]!.el.style.opacity = DIM;
          list.appendChild(rows[i]!.el);
          enter(rows[i]!.el);
        }

        draw(rows[i]!, item);
      }

      for (const gone of rows.splice(items.length)) gone.el.remove();
    },
    async settle(items: T[]) {
      const byKey = new Map(rows.map((r) => [r.key, r]));
      const next = items.map((item) => byKey.get(key(item)) ?? fresh());
      const kept = rows.filter((r) => next.includes(r));
      const sorted = kept.some((r, i) => r !== next[i]);
      const leaving = [...rows.filter((r) => !next.includes(r)).map((r) => foldAway(r.el)), ...(sorted ? kept.map((r) => fadeOut(r.el)) : [])];

      if (leaving.length) await Promise.all(leaving);
      rows = next;
      list.append(...next.map((r) => r.el));

      for (const [i, row] of next.entries()) {
        draw(row, items[i]!);
        const dim = !!row.el.style.opacity;
        row.el.style.removeProperty('opacity');

        if (sorted) fadeIn(row.el);
        else if (dim) brighten(row.el);
      }
    },
  };
};

// A divided topic's row, the same in every client: its name, then, once its
// sides are counted (`pos` and `neg`, the reviews on each), the share of them
// that like it, a bar of the two and a count of each (`count` builds the
// button that opens its reviews); under them what each side says. Drafted,
// it's the name and the sides alone.
export type Split = { topic: string; liked: string; disliked: string; pos?: number; neg?: number };

type Side = 'pos' | 'neg';

const SIDES = [['pos', '▲', 'like it', 'liked'], ['neg', '▼', "don't like it", 'disliked']] as const;

export const drawSplit = (row: HTMLElement, t: Split, inline: (node: HTMLElement, text: string) => void, count: (side: Side, n: number, label: string, say: string) => HTMLElement) => {
  const add = (parent: HTMLElement, tag: string, cls: string, text = '') => {
    const node = parent.appendChild(document.createElement(tag));
    node.className = cls;
    node.textContent = text;

    return node;
  };

  row.replaceChildren();
  const head = add(row, 'div', 'ars-split-head');
  add(head, 'span', 'ars-split-topic', t.topic);

  if (t.pos != null && t.neg != null) {
    add(head, 'span', 'ars-split-share', `${Math.round((t.pos / (t.pos + t.neg)) * 100)}% like it`);
    const counts = add(head, 'span', 'ars-split-counts');
    const bar = add(row, 'div', 'ars-split-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${t.pos} like it, ${t.neg} don't`);

    for (const [side, mark, say] of SIDES) {
      const n = t[side]!;
      const btn = counts.appendChild(count(side, n, `${mark}${n}`, say));
      btn.classList.add('ars-split-count', side);
      btn.setAttribute('aria-label', `${n} reviews ${say} — show them`);
      add(bar, 'i', side).style.flexGrow = String(n);
    }
  }

  for (const [side, mark, , says] of SIDES) {
    if (!t[says]) continue;
    const line = add(row, 'div', 'ars-split-side');
    add(line, 'span', `ars-split-mark ${side}`, mark).setAttribute('aria-hidden', 'true');
    inline(add(line, 'span', ''), t[says]);
  }
};
