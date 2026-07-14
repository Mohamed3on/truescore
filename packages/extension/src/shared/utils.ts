import { mdInline, mdToHtml } from '@truescore/gmaps-shared';

export const addCommas = (x: number | string): string =>
  String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const npsColor = (nps: number): string => {
  const hue = Math.min(120, Math.max(0, (nps - 50) * 3));
  return `hsl(${hue}, 70%, 35%)`;
};

// Net sentiment from 5★/1★ counts: `nps` is the net-positive share as a
// -100..100 percentage, `score` weights it by volume. Callers guard total > 0
// where the NaN at total === 0 would matter.
export const npsStats = (five: number, one: number, total: number) => {
  const ratio = (five - one) / total;
  return { score: Math.round((five - one) * ratio), nps: ratio * 100 };
};

export const el = (tag: string, className?: string, text?: string | number) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = String(text);
  return e;
};

export const renderMarkdown = (container: HTMLElement, text: string) => {
  container.innerHTML = mdToHtml(text);
};

export const renderMarkdownInline = (container: HTMLElement, text: string) => {
  container.innerHTML = mdInline(text);
};
