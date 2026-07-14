import { test, expect, describe } from 'bun:test';
import { createIslandShell, buildGauge } from './score-island';

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
});
