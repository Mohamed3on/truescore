import { mdInline, mdToHtml, netScore, type Tone } from '@truescore/gmaps-shared';

export const addCommas = (x: number | string): string =>
  String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Red through green by net-positive share. The default lightness reads on white;
// pass a lighter one for a dark host.
export const npsColor = (nps: number, lightness = 35): string => {
  const hue = Math.min(120, Math.max(0, (nps - 50) * 3));
  return `hsl(${hue}, 70%, ${lightness}%)`;
};

// An opinion share's tone (opinionTone) in the same palette: green, amber, red,
// so the retail sites grade it in the three bands the Maps surfaces use.
const TONE_HUE: Record<Tone, number> = { pos: 120, mid: 40, neg: 0 };
export const toneColor = (tone: Tone, lightness = 35): string => `hsl(${TONE_HUE[tone]}, 70%, ${lightness}%)`;

// Net sentiment from 5★/1★ counts: `nps` is the net-positive share as a
// -100..100 percentage, `score` weights it by volume and keeps its sign (see
// netScore). Callers guard total > 0 where the NaN nps at total === 0 would matter.
export const npsStats = (five: number, one: number, total: number) => ({
  score: netScore(five - one, total),
  nps: ((five - one) / total) * 100,
});

export const el = (tag: string, className?: string, text?: string | number) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = String(text);
  return e;
};

// Resolves once a server-rendered host has had its chance to hydrate: after the
// load event, at the first idle moment. React hydrates in chunks that can run past
// load, and a node we add before it's done fails hydration (#418), so React throws
// the page's HTML away and renders it again from scratch.
export const afterHydration = () => new Promise<void>((resolve) => {
  const idle = () => requestIdleCallback(() => resolve(), { timeout: 3000 });
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
});

export const renderMarkdown = (container: HTMLElement, text: string) => {
  container.innerHTML = mdToHtml(text);
};

export const renderMarkdownInline = (container: HTMLElement, text: string) => {
  container.innerHTML = mdInline(text);
};
