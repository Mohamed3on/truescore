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
const animates = (node: HTMLElement) => typeof node.animate === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

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
const fadeIn = (node: HTMLElement) => {
  if (!animates(node)) return;
  for (const a of node.getAnimations()) a.cancel();
  node.animate([{ opacity: 0 }, {}], { duration: 220, easing: EASE });
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
