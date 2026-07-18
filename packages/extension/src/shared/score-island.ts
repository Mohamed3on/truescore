import { addCommas, el, npsColor } from './utils';

// The retail PDP "score island": a dark-glass panel embedded into the host page.
// Sites compose it — shell + gauge + their own sections (variation card, topics,
// summarize widget) — and inject it via setupSpaInjector. The `.ars-*` styling
// ships in styles/amazon-product.css, registered per-site in the manifest.

export interface IslandScore {
  score: number;
  nps: number;
  total: number;
}

// The wrapper and its branded "Review Intelligence" header. The caller appends
// the gauge and its own sections, then inserts it at its anchor.
export const createIslandShell = (): HTMLElement => {
  const wrapper = document.createElement('div');
  wrapper.className = 'ars-wrapper';
  const header = document.createElement('div');
  header.className = 'ars-header';
  header.innerHTML = '<span class="ars-header-accent">&#x25C8;</span> Review Intelligence'; // safe: static
  wrapper.appendChild(header);
  return wrapper;
};

// The headline gauge — a "% positive on this item" bar tinted by sentiment — and
// the truescore / item-reviews stats row beneath it. Returned as [gauge, stats]
// for the caller to append into the island.
export const buildGauge = ({ score, nps, total }: IslandScore): [HTMLElement, HTMLElement] => {
  const gauge = document.createElement('div');
  gauge.className = 'ars-gauge';
  gauge.style.cursor = 'default';
  gauge.innerHTML = `
    <div class="ars-gauge-label"><span class="ars-gauge-pct"></span> positive on this item</div>
    <div class="ars-gauge-track"><div class="ars-gauge-fill"></div></div>
  `; // safe: no user content in template
  const tone = npsColor(nps);
  const pct = gauge.querySelector('.ars-gauge-pct') as HTMLElement;
  pct.textContent = `${Math.round(nps)}%`;
  pct.style.color = tone;
  const fill = gauge.querySelector('.ars-gauge-fill') as HTMLElement;
  fill.style.cssText = `width:100%;background:${tone};transform:scaleX(${Math.max(0, nps) / 100})`;

  const stats = document.createElement('div');
  stats.className = 'ars-stats';
  stats.innerHTML = `
    <div class="ars-stat"><span class="ars-stat-val"></span><span class="ars-stat-lbl">truescore</span></div>
    <div class="ars-stat-div"></div>
    <div class="ars-stat"><span class="ars-stat-val"></span><span class="ars-stat-lbl">item reviews</span></div>
  `; // safe: no user content in template
  const [scoreEl, totalEl] = stats.querySelectorAll('.ars-stat-val');
  scoreEl.textContent = addCommas(score);
  totalEl.textContent = addCommas(total);

  return [gauge, stats];
};

// Amazon's "% recent positive": NPS over an item's newest reviews —
// (5★ − 1★) / count. Null when there is nothing to judge.
export const recentPositiveRatio = (ratings: number[]): number | null => {
  if (!ratings.length) return null;
  let net = 0;
  for (const rating of ratings) {
    if (rating >= 5) net++;
    else if (rating <= 1) net--;
  }
  return net / ratings.length;
};

// Amazon's "trending" figure: the item's overall score damped by how positive
// its newest reviews run.
export const trendingScore = (score: number, ratio: number): number => Math.round(score * ratio);

// The "% recent positive" bar. With a ratio it renders complete; without one it
// renders a scanning placeholder for fillRecentGauge to finish — or remove —
// once the newest reviews arrive.
export const buildRecentGauge = (ratio?: number): HTMLElement => {
  const gauge = document.createElement('div');
  gauge.className = 'ars-gauge';
  gauge.style.cursor = 'default';
  gauge.innerHTML = `
    <div class="ars-gauge-label"><span class="ars-gauge-pct">—</span> recent positive <span class="ars-scan-spinner"></span></div>
    <div class="ars-gauge-track"><div class="ars-gauge-fill" style="transform:scaleX(0)"></div></div>
  `; // safe: no user content in template
  if (ratio !== undefined) fillRecentGauge(gauge, ratio);
  return gauge;
};

// Completes a recent gauge: paints the ratio, or removes the whole gauge when
// the newest reviews never arrived. A gauge that was already on screen fades
// its spinner out; one still detached just drops it.
export const fillRecentGauge = (gauge: HTMLElement, ratio: number | null): void => {
  const spinner = gauge.querySelector('.ars-scan-spinner');
  if (spinner) {
    if (gauge.isConnected) {
      spinner.classList.add('ars-scan-done');
      spinner.addEventListener('animationend', () => spinner.remove(), { once: true });
    } else {
      spinner.remove();
    }
  }
  if (ratio == null) return gauge.remove();
  const pct = Math.round(ratio * 100);
  const tone = npsColor(pct);
  const pctEl = gauge.querySelector('.ars-gauge-pct') as HTMLElement;
  pctEl.textContent = `${pct}%`;
  pctEl.style.color = tone;
  const fill = gauge.querySelector('.ars-gauge-fill') as HTMLElement;
  fill.style.background = tone;
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
};

// One value-over-microlabel cell appended to an .ars-stats row, preceded by the
// hairline divider whenever the row already holds a cell.
export const appendStat = (row: HTMLElement, value: string, label: string, color?: string): void => {
  const stat = el('div', 'ars-stat');
  const val = el('span', 'ars-stat-val', value);
  if (color) val.style.color = color;
  stat.append(val, el('span', 'ars-stat-lbl', label));
  if (row.children.length) row.appendChild(el('div', 'ars-stat-div'));
  row.appendChild(stat);
};
