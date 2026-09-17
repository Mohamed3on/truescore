import { test, expect, describe } from 'bun:test';
import {
  appendStat,
  buildGauge,
  buildRecentGauge,
  createIslandShell,
  fillRecentGauge,
} from './score-island';

describe('createIslandShell', () => {
  test('is an .ars-wrapper carrying the Review Intelligence header', () => {
    const shell = createIslandShell();
    expect(shell.className).toBe('ars-wrapper');
    expect(shell.querySelector('.ars-header')?.textContent).toContain('Review Intelligence');
  });
});

describe('buildGauge', () => {
  test('renders rounded percent, sentiment colour, and comma-grouped stats', () => {
    const [gauge, stats] = buildGauge({ score: 1234, nps: 68, total: 5000 });
    expect(gauge.className).toBe('ars-gauge');

    const pct = gauge.querySelector('.ars-gauge-pct') as HTMLElement;
    expect(pct.textContent).toBe('68%');
    expect(pct.style.color).toContain('hsl');

    const fill = gauge.querySelector('.ars-gauge-fill') as HTMLElement;
    expect(fill.style.cssText).toContain('scaleX(0.68)');

    const vals = [...stats.querySelectorAll('.ars-stat-val')].map((el) => el.textContent);
    expect(vals).toEqual(['1,234', '5,000']);
  });

  test('rounds the percent', () => {
    const [gauge] = buildGauge({ score: 1, nps: 67.6, total: 10 });
    expect((gauge.querySelector('.ars-gauge-pct') as HTMLElement).textContent).toBe('68%');
  });

  test('clamps a negative nps to a zero-width fill (never a negative bar)', () => {
    const [gauge] = buildGauge({ score: -50, nps: -30, total: 100 });
    const fill = gauge.querySelector('.ars-gauge-fill') as HTMLElement;
    expect(fill.style.cssText).toContain('scaleX(0)');
  });

  test('without a recent ratio there is no trend', () => {
    const [gauge] = buildGauge({ score: 1, nps: 50, total: 2 }, null);
    expect(gauge.querySelector('.ars-gauge-trend')).toBeNull();
  });

  test('a recent ratio within 5 points reads as steady, with no tick', () => {
    const [gauge] = buildGauge({ score: 171, nps: 97, total: 181 }, 0.93);
    const trend = gauge.querySelector('.ars-gauge-trend') as HTMLElement;
    expect(trend.textContent).toBe('steady recently');
    expect(trend.title).toBe('93% positive in the newest reviews');
    expect(gauge.querySelector('.ars-gauge-tick')).toBeNull();
  });

  test('a diverging recent ratio shows its percent and ticks the bar where it lands', () => {
    const [gauge] = buildGauge({ score: 327, nps: 82, total: 484 }, 0.76);
    expect((gauge.querySelector('.ars-gauge-trend') as HTMLElement).textContent).toBe('76% recently');
    expect((gauge.querySelector('.ars-gauge-tick') as HTMLElement).style.left).toBe('76%');
  });

  test('a negative recent ratio ticks at the start of the bar', () => {
    const [gauge] = buildGauge({ score: 40, nps: 20, total: 200 }, -0.3);
    expect((gauge.querySelector('.ars-gauge-trend') as HTMLElement).textContent).toBe('-30% recently');
    expect((gauge.querySelector('.ars-gauge-tick') as HTMLElement).style.left).toBe('0%');
  });
});

describe('buildRecentGauge', () => {
  test('given a ratio, renders the percent and fill with no spinner left', () => {
    const gauge = buildRecentGauge(0.62);
    expect((gauge.querySelector('.ars-gauge-pct') as HTMLElement).textContent).toBe('62%');
    expect((gauge.querySelector('.ars-gauge-fill') as HTMLElement).style.transform).toBe('scaleX(0.62)');
    expect(gauge.querySelector('.ars-scan-spinner')).toBeNull();
  });

  test('without a ratio, renders a scanning placeholder', () => {
    const gauge = buildRecentGauge();
    expect((gauge.querySelector('.ars-gauge-pct') as HTMLElement).textContent).toBe('—');
    expect(gauge.querySelector('.ars-scan-spinner')).not.toBeNull();
  });

  test('fillRecentGauge removes the gauge when no reviews came back', () => {
    const host = document.createElement('div');
    const gauge = buildRecentGauge();
    host.appendChild(gauge);
    fillRecentGauge(gauge, null);
    expect(host.children.length).toBe(0);
  });

  test('a negative ratio shows its percent but clamps the fill to zero', () => {
    const gauge = buildRecentGauge(-0.3);
    expect((gauge.querySelector('.ars-gauge-pct') as HTMLElement).textContent).toBe('-30%');
    expect((gauge.querySelector('.ars-gauge-fill') as HTMLElement).style.transform).toBe('scaleX(0)');
  });
});

describe('appendStat', () => {
  test('first cell lands without a divider, later cells bring one', () => {
    const row = document.createElement('div');
    appendStat(row, '765', 'adjusted');
    expect(row.querySelectorAll('.ars-stat-div').length).toBe(0);
    appendStat(row, '104', 'analyzed');
    expect(row.querySelectorAll('.ars-stat-div').length).toBe(1);
    const labels = [...row.querySelectorAll('.ars-stat-lbl')].map((n) => n.textContent);
    expect(labels).toEqual(['adjusted', 'analyzed']);
  });
});
