// Shared "Best by variation" card: a titled, optionally-tabbed list of ranked
// rows, each with a magnitude bar and a signed net score, the top positive row
// flagged as best. Used by site scripts (Amazon, Uniqlo, …) that each supply
// their own ranked dimensions — the data acquisition stays per-site, only this
// presentation is shared.

import { starScore } from '@truescore/gmaps-shared';

export interface VarRow {
  label: string;
  score: number; // net sentiment: sign → colour, |value| → bar width
  meta?: string; // optional sub-line, e.g. "18 reviews · true to size"
}

export interface VarDim {
  label: string; // tab label ('' for a single untabbed list)
  rows: VarRow[]; // pre-sorted best → worst
}

export interface VariationCardOpts {
  title?: string; // default 'Best by variation'
  animate?: boolean; // staggered row + card entrance
}

// Fold a product's reviews into ranked dimensions: one VarDim per variation axis
// (Colour, Size…) that has two or more values to compare, each value scored by
// net sentiment. The per-site part is only how a review's [dim, value] pairs and
// star rating are read — AliExpress aligns variations by index, Etsy keys them by
// transaction id. The companion to renderVariationCard, which renders the result.
export const tallyVariationDims = <T>(
  items: T[],
  opts: {
    variationsOf: (item: T, index: number) => [string, string][];
    ratingOf: (item: T) => number;
  }
): VarDim[] => {
  const { variationsOf, ratingOf } = opts;
  const dims = new Map<string, Map<string, { score: number; count: number }>>();

  items.forEach((item, i) => {
    for (const [dim, value] of variationsOf(item, i)) {
      if (!value) continue;
      let values = dims.get(dim);
      if (!values) dims.set(dim, (values = new Map()));
      const tally = values.get(value) ?? { score: 0, count: 0 };
      tally.score += starScore(ratingOf(item));
      tally.count++;
      values.set(value, tally);
    }
  });

  return [...dims.entries()]
    .filter(([, values]) => values.size >= 2)
    .map(([dim, values]) => ({
      label: dim,
      rows: [...values.entries()]
        .map(([label, { score, count }]) => ({
          label,
          score,
          meta: `${count} review${count === 1 ? '' : 's'}`,
        }))
        .sort((a, b) => b.score - a.score),
    }));
};

const STYLE_ID = 'ts-var-styles';
const ensureStyles = () => {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
@keyframes ts-var-enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes ts-var-row-in{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:translateX(0)}}
.ts-var{margin:12px 0;width:100%;max-width:360px;background:#FAFAF9;border:1px solid #E7E5E4;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.ts-var.is-animated{animation:ts-var-enter .4s cubic-bezier(.25,1,.5,1)}
.ts-var-head{padding:10px 12px 0}
.ts-var-title{display:block;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#A8A29E}
.ts-var-tabs{display:flex;gap:2px;margin-top:8px;border-bottom:1px solid #E7E5E4;overflow-x:auto;scrollbar-width:none}
.ts-var-tabs::-webkit-scrollbar{display:none}
.ts-var-tab{appearance:none;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;padding:6px 10px;font-family:inherit;font-size:12px;font-weight:600;color:#A8A29E;white-space:nowrap;cursor:pointer;transition:color .15s,border-color .15s}
.ts-var-tab:hover{color:#57534E}
.ts-var-tab.is-active{color:#0F766E;border-bottom-color:#0F766E}
.ts-var-panel{display:flex;flex-direction:column;padding:6px 12px 10px}
.ts-var-row{display:grid;grid-template-columns:1fr 60px auto;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #F5F5F4}
.ts-var-row:last-child{border-bottom:none}
.ts-var.is-animated .ts-var-row{animation:ts-var-row-in .35s cubic-bezier(.16,1,.3,1) both}
.ts-var-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.ts-var-val{font-size:12.5px;color:#44403C;overflow-wrap:anywhere}
.ts-var-best .ts-var-val{font-weight:700;color:#1C1917}
.ts-var-best .ts-var-val::before{content:"\\25C6";color:#0F766E;font-size:9px;margin-right:5px;vertical-align:1px}
.ts-var-fit{font-size:10px;color:#A8A29E;letter-spacing:.01em}
.ts-var-track{height:5px;background:#EFEDEC;border-radius:3px;overflow:hidden}
.ts-var-fill{display:block;height:100%;border-radius:3px}
.ts-var-fill.is-pos{background:#16A34A}
.ts-var-fill.is-neg{background:#DC2626}
.ts-var-score{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;color:#78716C}
.ts-var-score.is-pos{color:#15803D}
.ts-var-score.is-neg{color:#DC2626}
@media (prefers-reduced-motion:reduce){.ts-var.is-animated,.ts-var.is-animated .ts-var-row{animation:none}}`;
  document.head.appendChild(s);
};

export const renderVariationCard = (dims: VarDim[], opts: VariationCardOpts = {}): HTMLElement => {
  ensureStyles();
  const { title = 'Best by variation', animate = false } = opts;

  const box = document.createElement('div');
  box.className = 'ts-var' + (animate ? ' is-animated' : '');

  const head = document.createElement('div');
  head.className = 'ts-var-head';
  const titleEl = document.createElement('span');
  titleEl.className = 'ts-var-title';
  titleEl.textContent = title;
  head.appendChild(titleEl);
  box.appendChild(head);

  const panel = document.createElement('div');
  panel.className = 'ts-var-panel';

  const renderPanel = (rows: VarRow[]) => {
    panel.replaceChildren();
    const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.score)), 0) || 1;
    rows.forEach((r, i) => {
      const sign = r.score > 0 ? 'is-pos' : r.score < 0 ? 'is-neg' : '';
      const row = document.createElement('div');
      row.className = 'ts-var-row' + (i === 0 && r.score > 0 ? ' ts-var-best' : '');
      if (animate) row.style.animationDelay = `${Math.min(i, 12) * 30}ms`;

      const name = document.createElement('span');
      name.className = 'ts-var-name';
      const val = document.createElement('span');
      val.className = 'ts-var-val';
      val.textContent = r.label;
      name.appendChild(val);
      if (r.meta) {
        const meta = document.createElement('span');
        meta.className = 'ts-var-fit';
        meta.textContent = r.meta;
        name.appendChild(meta);
      }

      const track = document.createElement('span');
      track.className = 'ts-var-track';
      const fill = document.createElement('i');
      fill.className = 'ts-var-fill ' + sign;
      fill.style.width = `${(Math.abs(r.score) / maxAbs) * 100}%`;
      track.appendChild(fill);

      const score = document.createElement('span');
      score.className = 'ts-var-score ' + sign;
      score.textContent = (r.score > 0 ? '+' : '') + r.score;

      row.append(name, track, score);
      panel.appendChild(row);
    });
  };

  if (dims.length > 1) {
    const tabs = document.createElement('div');
    tabs.className = 'ts-var-tabs';
    tabs.setAttribute('role', 'tablist');
    dims.forEach((dim, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ts-var-tab' + (i === 0 ? ' is-active' : '');
      btn.setAttribute('role', 'tab');
      btn.textContent = dim.label;
      btn.addEventListener('click', () => {
        tabs.querySelectorAll('.ts-var-tab').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        renderPanel(dim.rows);
      });
      tabs.appendChild(btn);
    });
    head.appendChild(tabs);
  }

  box.appendChild(panel);
  renderPanel(dims[0].rows);
  return box;
};
