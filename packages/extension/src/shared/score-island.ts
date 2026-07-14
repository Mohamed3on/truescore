import { addCommas, npsColor } from './utils';

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
