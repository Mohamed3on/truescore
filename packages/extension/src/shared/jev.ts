import { countStances, isTrusted, MAX_JUDGED, opinionTone, signedNet, mentionsText, STANCE_MARKS, type StanceMark, type Answer, type Opinions, type ReceiptsResponse, type Review, type Stance, type StanceResponse, type StanceResult, type Tone } from '@truescore/gmaps-shared';
import { cacheGet, cacheSet } from './cache';
import { el, npsColor } from './utils';

// What reviews say about a topic or a question, and which of them make a
// summary's points — read by Jev on the truescore server, which holds its key
// (web/jev.ts); nothing here needs one. A site's content script asks through the
// background worker, which carries the server's password; gmaps.ts runs in the
// page's own world and calls the server directly (the browser adds the password
// there, see background.ts). Every read is optional: null, and the caller shows
// what it showed before.

const TRUESCORE_API_BASE = 'https://truescore.mohamed3on.com';
// A site's content script has the extension's runtime; gmaps.ts, in Maps' own
// world, has neither it nor the need (see above). Anywhere else — a test — reads
// nothing.
const viaWorker = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const inPage = !viaWorker && typeof location !== 'undefined' && /(^|\.)google\.[a-z.]+$/.test(location.hostname);
// A refusal (no password set, or Jev down) holds off further asks for a while,
// so the star share shows at once instead of after a wait each time.
const OFF_MS = 10 * 60_000;
let offUntil = 0;

const post = async <T,>(route: 'stance' | 'receipts', body: unknown): Promise<T | null> => {
  if (Date.now() < offUntil || (!viaWorker && !inPage)) return null;
  try {
    const r = inPage
      ? await fetch(`${TRUESCORE_API_BASE}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then((res) => (res.ok ? res.json() : null))
      : await chrome.runtime.sendMessage({ type: 'jev', route, body });
    if (!r || r.error) offUntil = Date.now() + OFF_MS;
    return r?.error ? null : (r as T | null);
  } catch {
    offUntil = Date.now() + OFF_MS;
    return null;
  }
};

// A read is kept, like the summaries: the same question of the same reviews is
// never asked twice.
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
const kept = async <T,>(kind: string, parts: unknown[], read: () => Promise<T | null>): Promise<T | null> => {
  const key = `ts_jev_${kind}_${hash(JSON.stringify(parts))}`;
  const hit = cacheGet(key, KEEP_MS) as T | null;
  if (hit) return hit;
  const fresh = await read();
  if (fresh) cacheSet(key, fresh);
  return fresh;
};

// Each text's stance on `topic`, aligned with the first MAX_JUDGED of `texts`.
export const readStances = (topic: string, texts: string[]): Promise<Stance[] | null> => {
  const read = texts.slice(0, MAX_JUDGED);
  if (!read.length) return Promise.resolve(null);
  return kept('stance', [topic, read], () => post<StanceResponse>('stance', { topic, texts: read }).then((r) => (r?.stances?.every(Boolean) ? (r.stances as Stance[]) : null)));
};

// Each text's answer to an Ask's `question`.
export const readAnswers = (question: string, texts: string[]): Promise<Answer[] | null> => {
  const read = texts.slice(0, MAX_JUDGED);
  if (!read.length) return Promise.resolve(null);
  return kept('answer', [question, read], () => post<StanceResponse>('stance', { question, texts: read }).then((r) => (r?.answers?.every(Boolean) ? (r.answers as Answer[]) : null)));
};

// A Maps chip's or Search's reviews read for their stance on `topic`: the trusted
// ones with text, the same reviews its TrueScore counts (as the server reads them).
export const readStanceOf = async (topic: string, reviews: Review[]): Promise<StanceResult | null> => {
  const readable = reviews.filter((r) => isTrusted(r.reviewerReviewCount) && r.text.trim().length > 1);
  const read = readable.slice(0, MAX_JUDGED);
  if (!read.length) return null;
  const labels = await readStances(topic, read.map((r) => r.text));
  if (!labels) return null;
  return { stance: countStances(labels), stances: Object.fromEntries(read.map((r, i) => [r.reviewId, labels[i]!])), ...(readable.length > read.length ? { of: readable.length } : {}) };
};

// Per point, the indices of `texts` that make it.
export const readSupport = (points: string[], texts: string[]): Promise<number[][] | null> =>
  kept('support', [points, texts], () => post<ReceiptsResponse>('receipts', { points, texts }).then((r) => r?.support ?? null));

// One small sheet for every host skin (daylight, Goodreads paper, Letterboxd and
// Maps at night): colours come from the text around them (currentColor) and the
// score palette (npsColor), so nothing here picks a skin.
const STYLES = `
.ts-opinions { display: inline-flex; align-items: baseline; gap: 6px; }
.ts-op-net { opacity: .55; font-weight: 500; font-size: .8em; }
/* The ▲/▼ filters sit in the small text beside a score, in the island's own
   praise and complaint inks (a skin can set --ts-praise / --ts-complain). */
.ts-op-filters { display: inline-flex; align-items: baseline; gap: 2px; min-width: 11ch; }
.ts-op-filter { font: inherit; font-weight: 600; color: var(--ts-praise, #15803D); padding: 0 3px; margin: 0; background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; transition: transform 160ms ease-out, background-color 160ms ease-out, border-color 160ms ease-out; }
.ts-op-filter.neg { color: var(--ts-complain, #C2410C); }
.ts-op-filter:active { transform: scale(0.97); }
.ts-op-filter:disabled { opacity: .4; cursor: default; }
.ts-op-filter[aria-pressed="true"] { background: color-mix(in srgb, currentColor 12%, transparent); border-color: color-mix(in srgb, currentColor 45%, transparent); }
@media (hover: hover) and (pointer: fine) { .ts-op-filter:hover:not(:disabled) { border-color: color-mix(in srgb, currentColor 30%, transparent); } }
.ts-op-slot { display: inline-flex; justify-content: flex-end; align-items: baseline; gap: 6px; min-width: 7ch; font-variant-numeric: tabular-nums; }
.ts-op-slot:not(.ts-op-in) { opacity: .4; }
/* A search header's read brings its filters along: its room is held from the start. */
.ars-search-score > .ts-op-slot, .rc-search-score > .ts-op-slot { min-width: 4ch; justify-content: flex-start; }
.ts-op-in > * { animation: ts-op-in 150ms ease-out; }
@keyframes ts-op-in { from { opacity: 0; filter: blur(2px); } to { opacity: 1; filter: none; } }
.ars-receipt { margin-left: 6px; padding: 0 7px; font: inherit; font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; color: inherit; opacity: .7; background: transparent; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 999px; cursor: pointer; transition: transform 160ms ease-out, opacity 160ms ease-out, border-color 160ms ease-out; }
.ars-receipt:active { transform: scale(0.97); }
.ars-receipt[aria-expanded="true"] { opacity: 1; border-color: color-mix(in srgb, currentColor 50%, transparent); }
@media (hover: hover) and (pointer: fine) { .ars-receipt:hover { opacity: 1; } }
.ars-receipt-quotes { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 4px; flex-basis: 100%; animation: ts-enter 180ms cubic-bezier(0.23, 1, 0.32, 1); }
.rc-highlight:has(.ars-receipt) { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.rc-highlight:has(.ars-receipt) .rc-h-text { flex: 1; }
.ars-receipt-quote { margin: 0; padding: 6px 8px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 6px; }
.ars-receipt-more { font-size: 11px; opacity: .65; }
/* A listed review's stance on the subject, after its stars (stanceMark). */
.ts-stance { font-size: 10px; line-height: 1; color: var(--ts-praise, #15803D); }
.ts-stance.complain { color: var(--ts-complain, #C2410C); }
.ts-stance.mixed { color: var(--ts-mixed, hsl(40, 70%, 35%)); }
.ts-stance.off { color: inherit; opacity: .6; }
.ts-stance.untrusted { font-size: inherit; color: inherit; }
@keyframes ts-enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes ts-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .ars-receipt-quotes, .ts-op-in > * { animation-name: ts-fade; } }
`;
export const ensureJevStyles = () => {
  if (typeof document === 'undefined' || document.getElementById('ts-jev-styles')) return;
  const style = document.createElement('style');
  style.id = 'ts-jev-styles';
  style.textContent = STYLES;
  (document.head ?? document.documentElement).appendChild(style);
};

// How a surface draws the numbers: the classes its own score and count already
// wear (and the colour its score took), so the share and net sit in the same
// fonts, sizes and palette as the star share they replace. No `net` class: the
// surface shows the share alone (an Ask row, whose count is its matches).
export type NumberStyle = { share: (tone: Tone | '') => string; net?: string; color?: (o: Opinions) => string; sparse?: 'count' | 'dash' };

// Opinions as every TrueScore surface shows them: the share of those taking a
// side who are positive, then the net with its sign — or, when too few take a
// side, just how many reviews speak to it (a muted ·N, or — where there's no
// count style). `word` names the positive side where the bare share would be
// ambiguous ("82% yes").
export const opinionNumbers = (o: Opinions, style: NumberStyle, word = ''): HTMLElement[] => {
  if (o.sparse) return [style.net && style.sparse !== 'dash' ? el('span', style.net, `·${o.mentions}`) : el('span', style.share(''), '—')];
  const share = el('span', style.share(opinionTone(o)), `${o.share}%${word && ` ${word}`}`);
  if (style.color) share.style.color = style.color(o);
  return style.net ? [share, el('span', style.net, `·${signedNet(o.net)}`)] : [share];
};
// The same, held together where the host has no row of its own to lay them out
// in (a header, a panel title), with the counts behind them in the tooltip.
export const opinionsEl = (o: Opinions, style: NumberStyle, word = ''): HTMLElement => {
  ensureJevStyles();
  const span = el('span', 'ts-opinions');
  span.title = o.title;
  span.append(...opinionNumbers(o, style, word));
  return span;
};
export const opinionsLabel = (o: Opinions) => (o.sparse ? mentionsText(o.mentions) : `${o.share}% ${o.posWord}, net ${signedNet(o.net)} (${o.title})`);

// A ▲ and a ▼ that list just the reviews praising or complaining about the
// subject; pressing the pressed one again clears it. Instant: a frequent action.
export const opinionFilters = (o: Opinions, current: () => Stance | null, set: (s: Stance | null) => void): HTMLButtonElement[] => {
  const press = (stance: Stance, glyph: string, n: number, word: string) => {
    const btn = el('button', `ts-op-filter ${stance === 'praise' ? 'pos' : 'neg'}`, `${glyph}${n}`) as HTMLButtonElement;
    btn.type = 'button';
    btn.disabled = !n;
    btn.dataset.stance = stance;
    btn.setAttribute('aria-label', `${n} ${word} — show only these reviews`);
    btn.setAttribute('aria-pressed', String(current() === stance));
    btn.onclick = () => set(current() === stance ? null : stance);
    return btn;
  };
  return [press('praise', '▲', o.pos, 'praise'), press('complain', '▼', o.neg, 'complain')];
};
export const markPressed = (root: Element, stance: Stance | null) =>
  root.querySelectorAll<HTMLButtonElement>('.ts-op-filter').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.stance === stance)));

// A listed review's stance on the subject, or that its untrusted author kept it
// unread (STANCE_MARKS); none when it wasn't read.
export const stanceMark = (stance: StanceMark | undefined): HTMLElement[] => {
  if (!stance) return [];
  ensureJevStyles();
  const { text, label } = STANCE_MARKS[stance];
  const mark = el('span', `ts-stance ${stance}`, text);
  mark.title = label;
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', label);
  return [mark];
};

// A summary bullet's receipt: how many reviews make its point; a press opens
// them below it. `title` says what was checked when it wasn't every review;
// `renderQuote` draws a review as the site's own card, else it shows as text.
export const receiptButton = (
  item: HTMLElement,
  n: number,
  quotes: string[],
  title = 'Show the reviews that say this',
  renderQuote?: (text: string) => HTMLElement | null,
): HTMLButtonElement => {
  ensureJevStyles();
  const btn = el('button', 'ars-receipt', `${n} reviews`) as HTMLButtonElement;
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => {
    const open = item.querySelector('.ars-receipt-quotes');
    btn.setAttribute('aria-expanded', String(!open));
    if (open) { open.remove(); return; }
    const box = el('div', 'ars-receipt-quotes');
    for (const q of quotes) box.appendChild(renderQuote?.(q) ?? el('p', 'ars-receipt-quote', q));
    if (n > quotes.length) box.appendChild(el('span', 'ars-receipt-more', `+${n - quotes.length} more`));
    item.appendChild(box);
  });
  return btn;
};

// Space held where counts will land, filled once with a short fade — never a
// number ticking up. `fill` gets the settled element, or the fallback when the
// read came back empty.
export const opinionsSlot = (read: Promise<HTMLElement[] | null>, fallback: () => HTMLElement | null): HTMLElement => {
  ensureJevStyles();
  const slot = el('span', 'ts-op-slot', '…');
  void read.then((filled) => {
    const fell = filled ? null : fallback();
    slot.replaceChildren(...(filled ?? (fell ? [fell] : [])));
    slot.classList.add('ts-op-in');
  });
  return slot;
};
