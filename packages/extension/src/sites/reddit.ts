// Reddit: a Thread's Tally (CONTEXT.md). The Options its comments recommend or
// warn against, ranked by how many people take each side, in a drawer beside
// the thread, each opening onto the comments behind its count. Nothing runs
// until the post's "tally" link or Alt+T asks. Old reddit gets the link among
// the post's buttons and marks the counted comments in the thread; new Reddit a
// pill under the post and the drawer alone. At the drawer's foot, a box to ask
// the thread anything: answered from the same comments, citing the ones each
// answer rests on, and kept for the thread's next visit.
import { countsInTally, mdToHtml, MIN_TALLY_PEOPLE, replaceChips, signedNet, speakersOf, STANCE_MARKS, threadFromListing, type ListedOption, type OptionTally, type Stance, type TallyCount, type TallyEvent, type Thread, type TitleTally } from '@truescore/gmaps-shared';
import { loadQAs, saveQA } from '../shared/qa-history';
import { askThread, requestTally, tallyReady } from '../shared/tally';
import { el } from '../shared/utils';

const button = (className: string, text?: string) => {
  const b = el('button', className, text) as HTMLButtonElement;
  b.type = 'button';
  return b;
};

// `why`: a line on why people rate it as they do, once the server has written it;
// `maker`: the Option a title stands in for, among products.
type Row = { listed: ListedOption; tally?: OptionTally; why?: string; maker?: string };
// The shortcut, as the keyboard labels it.
const KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥T' : 'Alt+T';
type View = 'people' | 'upvotes';
// Makers ranks the Options as listed; products ranks their titles on their own.
type Level = 'makers' | 'products';

const THREAD_PATH = /^\/r\/[^/]+\/comments\/([a-z0-9]+)/i;
const onThread = () => THREAD_PATH.test(location.pathname);
// Where the questions asked of this thread are kept (qa-history).
const qaKey = () => `ts-tally-${location.pathname.match(THREAD_PATH)?.[1]}`;
const isOld = () => !!document.querySelector('.commentarea');

// The page's own comments: its `.json`, with its sort and count.
const threadUrl = () => {
  const u = new URL(location.href);
  u.pathname = `${u.pathname.replace(/\/?$/, '/')}.json`;
  u.searchParams.set('raw_json', '1');
  return u.toString();
};

let thread: Thread | null = null;
let rows: Row[] = [];
let phase: 'idle' | 'listing' | 'reading' | 'done' | 'error' = 'idle';
let failure = '';
let view: View = 'people';
let level: Level = 'makers';
let openKey: string | null = null;
let openTitle: string | null = null;
let stop: (() => void) | null = null;
// A question asked of the thread, with its answer as far as it's written, or
// why it couldn't be.
type Turn = { q: string; a: string; done: boolean; error?: string };
let turns: Turn[] = [];
let stopAsk: (() => void) | null = null;

// ---- figures ----

const sides = (c: TallyCount): [number, number] => (view === 'people' ? [c.for, c.against] : [c.upFor, c.upAgainst]);
const net = (c: TallyCount) => { const [a, b] = sides(c); return a - b; };
// Equal nets rank the less contested first (6–0 above 10–4): the one with fewer
// against, which is the one with the higher share for.
const byStanding = (a: TallyCount, b: TallyCount) => net(b) - net(a) || sides(a)[1] - sides(b)[1] || b.upFor - a.upFor;

const figures = (c: TallyCount) => {
  const [a, b] = sides(c);
  const box = el('span', 'ts-tally-fig');
  box.append(el('span', 'ts-up', `▲${a}`), el('span', 'ts-down', `▼${b}`), el('span', 'ts-net', signedNet(a - b)));
  box.title = `${c.for} for · ${c.against} against${c.mixed ? ` · ${c.mixed} mixed` : ''} (people) · ${c.upFor} upvotes for · ${c.upAgainst} against`;
  return box;
};

// ---- the thread itself ----

const commentEl = (id: string) =>
  document.querySelector<HTMLElement>(`.thing[data-fullname="t1_${id}"] > .entry, shreddit-comment[thingid="t1_${id}"]`);

// Old reddit: each comment speaking of the open Option (or title) gets its mark
// beside the author, as the drawer's receipts do.
const markThread = (reads: Record<string, Stance> | null, subject = '') => {
  for (const m of document.querySelectorAll('.ts-tally-mark')) m.remove();
  if (!reads || !isOld()) return;
  for (const [id, s] of Object.entries(reads)) {
    const tagline = commentEl(id)?.querySelector('.tagline');
    if (!tagline) continue;
    const m = el('span', `ts-tally-mark ts-${s}`, STANCE_MARKS[s].text);
    m.title = STANCE_MARKS[s].label(subject);
    tagline.append(m);
  }
};

// A receipt opens its comment: scrolled to and flashed when the page shows it,
// else its permalink (it sits behind "load more", or under a collapsed one).
const goTo = (id: string) => {
  const target = commentEl(id);
  if (target?.offsetParent) {
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target.classList.remove('ts-tally-flash');
    void target.offsetWidth;
    target.classList.add('ts-tally-flash');
    return;
  }
  const [, , sub, , post] = location.pathname.split('/');
  window.open(`${location.origin}/r/${sub}/comments/${post}/_/${id}/`, '_blank', 'noopener');
};

const plain = (md: string) => md.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_>#`~]+/g, '').replace(/\s+/g, ' ').trim();
const QUOTE_CHARS = 220;

const receipts = (reads: Record<string, Stance>, subject: string) => {
  const byId = new Map(thread!.comments.map((c) => [c.id, c]));
  const rank = (s: Stance) => (s === 'mixed' ? 1 : 0);
  const ids = Object.keys(reads).filter((id) => byId.has(id))
    .sort((a, b) => rank(reads[a]!) - rank(reads[b]!) || byId.get(b)!.score - byId.get(a)!.score);
  const list = el('ul', 'ts-tally-receipts');
  for (const id of ids) {
    const c = byId.get(id)!, s = reads[id]!;
    const b = button('ts-tally-receipt');
    b.title = `${STANCE_MARKS[s].label(subject)} · open the comment`;
    const text = plain(c.body);
    b.append(el('span', `ts-tally-mark ts-${s}`, STANCE_MARKS[s].text), el('span', 'ts-pts', c.score),
      el('span', 'ts-quote', text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text));
    b.addEventListener('click', () => goTo(id));
    const li = el('li');
    li.append(b);
    list.append(li);
  }
  return list;
};

// ---- the drawer ----

// The drawer lives in a shadow root: old reddit's subreddit stylesheets (and
// RES) style buttons and lists page-wide, and restyled its rows on hover. The
// root takes the page's typeface through --ts-font and nothing else, and keeps
// the ledger's grammar: tabular figures, an uppercase micro-label, hairline
// rules, sentiment only on the figures (DESIGN.md).
const DRAWER_CSS = `:host { all: initial !important; }
.ts-tally {
  --ts-ground: #fff;
  --ts-ink: #222;
  --ts-ink-2: #555;
  --ts-ink-3: #888;
  --ts-line: #e3e3e3;
  --ts-hover: #f2f6fb;
  --ts-accent: #369;
  position: fixed;
  inset: 0 0 0 auto;
  z-index: 2147483000;
  box-sizing: border-box;
  width: min(380px, 100vw);
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--ts-ground);
  color: var(--ts-ink);
  border-left: 1px solid var(--ts-line);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.12);
  font-family: var(--ts-font, verdana, arial, helvetica, sans-serif);
  font-size: 12px;
  line-height: 1.45;
  display: flex;
  flex-direction: column;
}
.ts-tally > * { flex-shrink: 0; }
.ts-tally[hidden] { display: none; }
:host-context(.res-nightmode) .ts-tally,
:host-context(.theme-dark) .ts-tally {
  --ts-ground: #1a1a1b;
  --ts-ink: #ddd;
  --ts-ink-2: #aaa;
  --ts-ink-3: #808080;
  --ts-line: #343536;
  --ts-hover: #26272a;
  --ts-accent: #8cb3d9;
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.45);
}

.ts-tally-top {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 4px 8px;
  padding: 12px 16px 10px;
  background: var(--ts-ground);
  border-bottom: 1px solid var(--ts-line);
}
.ts-tally-head { display: flex; align-items: center; gap: 8px; }
.ts-tally-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ts-ink-3);
}
.ts-tally-view { display: inline-flex; justify-self: end; border: 1px solid var(--ts-line); border-radius: 6px; overflow: hidden; }
.ts-tally-view[hidden] { display: none; }
.ts-tally-level { grid-row: 2; grid-column: 2; }
.ts-tally button { font: inherit; color: inherit; }
.ts-tally-seg,
.ts-tally-close,
.ts-tally-opt,
.ts-tally-title,
.ts-tally-receipt,
.ts-tally-retry,
.ts-cite,
.ts-ask-send {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
}
.ts-tally-seg { padding: 2px 8px; font-size: 11px; color: var(--ts-ink-2); }
.ts-tally-seg[aria-pressed='true'] { background: var(--ts-hover); color: var(--ts-accent); font-weight: 700; }
.ts-tally-close { padding: 0 2px 2px 6px; font-size: 18px; line-height: 1; color: var(--ts-ink-3); }
.ts-tally-close:hover { color: var(--ts-ink); }
.ts-tally-keys { color: var(--ts-ink-3); font-size: 10px; }
.ts-tally-status { grid-column: 1 / -1; color: var(--ts-ink-3); font-variant-numeric: tabular-nums; }
.ts-tally-level:not([hidden]) ~ .ts-tally-status { grid-column: 1; }
.ts-tally-error { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 10px; color: #b91c1c; }
.ts-tally-error:empty { display: none; }
.ts-tally-retry { color: var(--ts-accent); text-decoration: underline; }

.ts-tally-list { list-style: none; margin: 0; padding: 0; }
.ts-tally-row { border-bottom: 1px solid var(--ts-line); }
.ts-tally-opt,
.ts-tally-title,
.ts-tally-receipt { display: flex; align-items: baseline; gap: 8px; width: 100%; }
.ts-tally-opt { padding: 8px 16px; flex-wrap: wrap; }
.ts-tally-why { flex-basis: 100%; color: var(--ts-ink-2); font-size: 11.5px; line-height: 1.4; }
.ts-tally-opt:disabled { cursor: default; }
.ts-tally-opt:hover:not(:disabled),
.ts-tally-title:hover,
.ts-tally-receipt:hover { background: var(--ts-hover); }
.ts-tally-seg:focus-visible,
.ts-tally-close:focus-visible,
.ts-tally-opt:focus-visible,
.ts-tally-title:focus-visible,
.ts-tally-receipt:focus-visible,
.ts-tally-retry:focus-visible,
.ts-cite:focus-visible,
.ts-ask-send:focus-visible { outline: 2px solid var(--ts-accent); outline-offset: -2px; }
.ts-tally-name { flex: 1; min-width: 0; font-weight: 700; overflow-wrap: anywhere; }
.ts-tally-opt[aria-expanded='true'] .ts-tally-name { color: var(--ts-accent); }
.ts-tally-maker { margin-left: 6px; font-weight: 400; color: var(--ts-ink-3); }
.ts-tally-fig { display: inline-flex; gap: 6px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ts-up { color: #15803d; }
.ts-down { color: #b91c1c; }
.ts-net { min-width: 3em; text-align: right; font-weight: 700; }
.ts-tally-pending { color: var(--ts-ink-3); font-style: italic; }

.ts-tally-detail { padding: 0 16px 10px; }
.ts-tally-titles { list-style: none; margin: 0 0 8px; padding: 0 0 8px; border-bottom: 1px dashed var(--ts-line); }
.ts-tally-title { padding: 4px 8px; border-radius: 4px; }
.ts-tally-title .ts-tally-name { font-weight: 400; }
.ts-tally-title[aria-pressed='true'] { background: var(--ts-hover); }
.ts-tally-title[aria-pressed='true'] .ts-tally-name { color: var(--ts-accent); }
.ts-tally-receipts { list-style: none; margin: 0; padding: 0; max-height: 360px; overflow-y: auto; }
.ts-tally-receipt { align-items: flex-start; padding: 6px 8px; border-radius: 4px; }
.ts-pts { min-width: 2.2em; text-align: right; color: var(--ts-ink-3); font-variant-numeric: tabular-nums; }
.ts-quote { flex: 1; min-width: 0; color: var(--ts-ink-2); overflow-wrap: anywhere; }

.ts-tally-once > summary { padding: 10px 16px; cursor: pointer; }
.ts-tally-once .ts-tally-name { font-weight: 400; }
.ts-tally-mark { font-weight: 700; }
.ts-tally-mark.ts-praise { color: #15803d; }
.ts-tally-mark.ts-complain { color: #b91c1c; }
.ts-tally-mark.ts-mixed { color: #a16207; }

.ts-chat { padding: 0 16px; border-top: 1px solid var(--ts-line); }
.ts-chat:empty { display: none; }
.ts-chat-turn { padding: 12px 0; border-bottom: 1px solid var(--ts-line); }
.ts-chat-turn:last-child { border-bottom: 0; }
.ts-chat-q { font-weight: 700; overflow-wrap: anywhere; }
.ts-chat-a { margin-top: 4px; color: var(--ts-ink-2); overflow-wrap: anywhere; }
.ts-chat-a p, .ts-chat-a ul, .ts-chat-a ol { margin: 0 0 6px; }
.ts-chat-a ul, .ts-chat-a ol { padding-left: 18px; }
.ts-chat-a > :last-child { margin-bottom: 0; }
.ts-chat-a strong { color: var(--ts-ink); }
.ts-chat-reading { color: var(--ts-ink-3); font-style: italic; animation: ts-pulse 1.4s ease-in-out infinite; }
@keyframes ts-pulse { 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) { .ts-chat-reading { animation: none; } }
.ts-chat-error { color: #b91c1c; }
.ts-cite {
  display: inline;
  margin: 0 1px;
  padding: 1px 4px;
  white-space: nowrap;
  border-radius: 4px;
  background: var(--ts-hover);
  color: var(--ts-accent);
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  vertical-align: 1px;
}
.ts-cite:hover { background: var(--ts-accent); color: var(--ts-ground); }
.ts-ask {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  gap: 6px;
  margin-top: auto;
  padding: 10px 16px 12px;
  background: var(--ts-ground);
  border-top: 1px solid var(--ts-line);
}
.ts-ask-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 6px 9px;
  border: 1px solid var(--ts-line);
  border-radius: 6px;
  background: var(--ts-ground);
  color: var(--ts-ink);
  font: inherit;
}
.ts-ask-input::placeholder { color: var(--ts-ink-3); }
.ts-ask-input:focus { outline: 2px solid var(--ts-accent); outline-offset: -1px; }
.ts-ask-send { padding: 6px 10px; border-radius: 6px; font-weight: 700; color: var(--ts-accent); }
.ts-ask-send:hover:not(:disabled) { background: var(--ts-hover); }
.ts-ask-send:disabled { cursor: default; color: var(--ts-ink-3); }
`;

const host = el('div', 'ts-tally-host');
const shadow = host.attachShadow({ mode: 'open' });
const drawer = el('aside', 'ts-tally');
drawer.setAttribute('aria-label', 'Tally');
drawer.hidden = true;
const status = el('div', 'ts-tally-status');
status.setAttribute('aria-live', 'polite');
// A segmented switch over `values`; render() presses the one in force.
const segments = <T extends string>(values: T[], pick: (v: T) => void) => {
  const box = el('div', 'ts-tally-view');
  for (const v of values) {
    const b = button('ts-tally-seg', v);
    b.dataset.value = v;
    b.addEventListener('click', () => { pick(v); render(); });
    box.append(b);
  }
  return box;
};
const press = (box: HTMLElement, value: string) => {
  for (const b of box.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.value === value));
};
const viewSwitch = segments<View>(['people', 'upvotes'], (v) => { view = v; });
const levelSwitch = segments<Level>(['makers', 'products'], (v) => { level = v; });
levelSwitch.classList.add('ts-tally-level');
const list = el('ol', 'ts-tally-list');
const once = el('details', 'ts-tally-once') as HTMLDetailsElement;
const onceLabel = el('summary', 'ts-tally-label');
const onceList = el('ol', 'ts-tally-list');
once.append(onceLabel, onceList);
const failBox = el('div', 'ts-tally-error');
const chatLog = el('div', 'ts-chat');
const askForm = el('form', 'ts-ask') as HTMLFormElement;
const askInput = el('input', 'ts-ask-input') as HTMLInputElement;
askInput.placeholder = 'Ask the thread…';
askInput.setAttribute('aria-label', 'Ask a question about this thread');
const askButton = button('ts-ask-send', 'Ask');
askButton.type = 'submit';
askForm.append(askInput, askButton);

{
  const head = el('div', 'ts-tally-head');
  const close = button('ts-tally-close', '×');
  close.setAttribute('aria-label', 'Close the tally (Esc)');
  close.addEventListener('click', () => toggleDrawer(false));
  const keys = el('span', 'ts-tally-keys', KEY);
  keys.title = `${KEY} opens and closes the tally, Esc closes it`;
  head.append(el('span', 'ts-tally-label', 'Tally'), keys);
  const top = el('div', 'ts-tally-top');
  top.append(head, viewSwitch, close, levelSwitch, status, failBox);
  drawer.append(top, list, once, chatLog, askForm);
  shadow.append(el('style', '', DRAWER_CSS), drawer);
}

const rowEls = new Map<string, HTMLElement>();

const titleRow = (t: TitleTally) => {
  const b = button('ts-tally-title');
  b.setAttribute('aria-pressed', String(openTitle === t.key));
  b.append(el('span', 'ts-tally-name', t.name), figures(t.count));
  b.addEventListener('click', () => { openTitle = openTitle === t.key ? null : t.key; render(); });
  const li = el('li');
  li.append(b);
  return li;
};

const rowEl = (row: Row) => {
  const { listed, tally } = row;
  const li = rowEls.get(listed.key) ?? el('li', 'ts-tally-row');
  rowEls.set(listed.key, li);
  const isOpen = openKey === listed.key && !!tally;
  const head = button('ts-tally-opt');
  head.setAttribute('aria-expanded', String(isOpen));
  const name = el('span', 'ts-tally-name', listed.name);
  if (row.maker && !listed.name.toLowerCase().includes(row.maker.toLowerCase())) name.append(el('span', 'ts-tally-maker', row.maker));
  head.append(name, tally ? figures(tally.count) : el('span', 'ts-tally-pending', 'reading…'));
  if (row.why) head.append(el('span', 'ts-tally-why', row.why));
  head.disabled = !tally;
  head.addEventListener('click', () => {
    openKey = isOpen ? null : listed.key;
    openTitle = null;
    render();
  });
  li.replaceChildren(head);
  if (isOpen) {
    const detail = el('div', 'ts-tally-detail');
    const counted = tally.titles.filter((t) => speakersOf(t.count) > 0).sort((a, b) => byStanding(a.count, b.count));
    if (counted.length) {
      const titles = el('ul', 'ts-tally-titles');
      titles.append(...counted.map(titleRow));
      detail.append(titles);
    }
    const title = tally.titles.find((t) => t.key === openTitle);
    detail.append(receipts(title?.reads ?? tally.reads, title?.name ?? listed.name));
    li.append(detail);
  }
  return li;
};

// An Option the model listed but no counted comment turns out to speak of isn't shown.
const shown = () => rows.filter((r) => !r.tally || speakersOf(r.tally.count) > 0);
// Products: each Option's titles in its place, ranked on their own; an Option
// with none spoken of stands as it is.
const products = (r: Row): Row[] => {
  const titles = r.tally?.titles.filter((t) => speakersOf(t.count) > 0) ?? [];
  return titles.length ? titles.map((t) => ({ listed: { key: t.key, name: t.name, titles: [] }, tally: { ...t, titles: [] }, maker: r.listed.name })) : [r];
};

const statusText = () => {
  const read = thread?.comments.filter(countsInTally).length ?? 0;
  const counted = rows.filter((r) => r.tally).length;
  const options = shown().length;
  if (phase === 'listing') return thread ? `Listing the options in ${read} comments…` : 'Loading the comments…';
  if (phase === 'reading') return counted < rows.length || !rows.length ? `Reading ${read} comments · ${counted} of ${rows.length} options counted…` : 'Summing up why each is rated as it is…';
  if (phase === 'done') return options ? `${options} options · ${read} comments` : `No options to tally in ${read} comments`;
  return '';
};

function render() {
  press(viewSwitch, view);
  press(levelSwitch, level);
  levelSwitch.hidden = !rows.some((r) => r.listed.titles.length);
  status.textContent = statusText();
  failBox.replaceChildren();
  if (phase === 'error') {
    const retry = button('ts-tally-retry', 'Try again');
    retry.addEventListener('click', () => void start());
    failBox.append(el('span', '', failure), retry);
  }
  const visible = level === 'products' && !levelSwitch.hidden ? shown().flatMap(products) : shown();
  const counted = visible.filter((r) => r.tally && speakersOf(r.tally.count) >= MIN_TALLY_PEOPLE).sort((a, b) => byStanding(a.tally!.count, b.tally!.count));
  const pending = visible.filter((r) => !r.tally);
  const folded = visible.filter((r) => r.tally && speakersOf(r.tally.count) < MIN_TALLY_PEOPLE).sort((a, b) => byStanding(a.tally!.count, b.tally!.count));
  replaceChips(list, [...counted, ...pending].map((r) => ({ key: r.listed.key, el: rowEl(r) })));
  onceList.replaceChildren(...folded.map(rowEl));
  onceLabel.textContent = `Named by one person · ${folded.length}`;
  once.hidden = !folded.length;
  const open = visible.find((r) => r.listed.key === openKey)?.tally;
  const title = open?.titles.find((t) => t.key === openTitle);
  markThread(drawer.hidden ? null : title?.reads ?? open?.reads ?? null, title?.name ?? open?.name);
}

const onEvent = (e: TallyEvent) => {
  if (e.type === 'listed') {
    if (!rows.some((r) => r.listed.key === e.option.key)) rows.push({ listed: e.option });
    phase = 'reading';
  } else if (e.type === 'option') {
    const row = rows.find((r) => r.listed.key === e.option.key);
    if (row) row.tally = e.option;
  } else if (e.type === 'why') {
    const row = rows.find((r) => r.listed.key === e.key);
    if (row) row.why = e.text;
  } else if (e.type === 'done') {
    phase = 'done';
  } else {
    phase = 'error';
    failure = e.error;
  }
  render();
};

// ---- asking the thread ----

// The comments an answer cites ("[k3j9x2a]", several to a pair of brackets)
// become buttons onto them, numbered in the order it first cites them. An id
// the page didn't load stays as written.
const CITATION = /\[([a-z0-9]+(?:,\s*[a-z0-9]+)*)\]/gi;
const paintAnswer = (box: HTMLElement, text: string) => {
  const byId = new Map(thread?.comments.map((c) => [c.id, c]));
  const cited: string[] = [];
  const number = (id: string) => (cited.includes(id) ? cited.indexOf(id) : cited.push(id) - 1) + 1;
  box.innerHTML = mdToHtml(text).replace(CITATION, (written, ids: string) => {
    const known = ids.split(/,\s*/).filter((id) => byId.has(id));
    return known.length ? known.map((id) => `<button type="button" class="ts-cite" data-id="${id}">${number(id)}</button>`).join('') : written;
  });
  for (const b of box.querySelectorAll<HTMLButtonElement>('.ts-cite')) {
    const c = byId.get(b.dataset.id!)!;
    const quote = plain(c.body);
    b.title = `u/${c.author} · ${c.score} points — ${quote.length > QUOTE_CHARS ? `${quote.slice(0, QUOTE_CHARS)}…` : quote}`;
    b.addEventListener('click', () => goTo(c.id));
  }
};

const turnEl = (t: Turn) => {
  const box = el('div', 'ts-chat-turn');
  const answer = el('div', 'ts-chat-a');
  box.append(el('div', 'ts-chat-q', t.q), answer);
  if (t.error) answer.append(el('span', 'ts-chat-error', t.error));
  else if (t.a) paintAnswer(answer, t.a);
  else answer.append(el('span', 'ts-chat-reading', 'Reading the thread…'));
  return box;
};

function renderChat() {
  chatLog.replaceChildren(...turns.map(turnEl));
  askButton.disabled = !thread || !!stopAsk;
}

// The drawer follows an answer as it's written, unless the reader scrolled up.
const atFoot = () => drawer.scrollHeight - drawer.scrollTop - drawer.clientHeight < 24;

// Asks `q` with the questions answered before it, so a follow-up ("and for
// beginners?") reads as one. A finished answer is kept for the thread.
const ask = (q: string) => {
  const turn: Turn = { q, a: '', done: false };
  const chat = [...turns.filter((t) => t.done).map((t) => ({ question: t.q, answer: t.a })), { question: q }];
  turns.push(turn);
  stopAsk = askThread(thread!, chat, (e) => {
    const follow = atFoot();
    if (e.type === 'text') {
      turn.a += e.text;
      chatLog.lastElementChild?.replaceWith(turnEl(turn));
    } else {
      stopAsk = null;
      if (e.type === 'error') turn.error = e.error;
      else if (!turn.a.trim()) turn.error = 'The answer was cut off — try again';
      else { turn.done = true; saveQA(qaKey(), { q, a: turn.a, ts: Date.now() }); }
      renderChat();
    }
    if (follow) drawer.scrollTop = drawer.scrollHeight;
  });
  renderChat();
  drawer.scrollTop = drawer.scrollHeight;
};

askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = askInput.value.trim();
  if (!q || !thread || stopAsk) return;
  askInput.value = '';
  ask(q);
});

// Single-key page shortcuts (RES's, Reddit's own) see a key typed in the
// drawer as coming from its host, not an input: keys typed in the box stop at
// the window. Esc still closes the drawer.
for (const type of ['keydown', 'keypress', 'keyup']) {
  window.addEventListener(type, (e) => {
    if (e.composedPath()[0] === askInput && (e as KeyboardEvent).key !== 'Escape') e.stopPropagation();
  }, true);
}

async function start() {
  stop?.();
  rows = [];
  rowEls.clear();
  openKey = openTitle = null;
  phase = 'listing';
  thread = null;
  render();
  renderChat();
  try {
    const res = await fetch(threadUrl(), { credentials: 'include' });
    if (!res.ok) throw new Error(`Reddit answered ${res.status}`);
    thread = threadFromListing(await res.json());
  } catch {
    phase = 'error';
    failure = "Couldn't load this thread's comments";
    render();
    return;
  }
  render();
  // The questions asked of it on earlier visits, oldest first.
  if (!turns.length) turns = loadQAs(qaKey()).reverse().map((e) => ({ q: e.q, a: e.a, done: true }));
  renderChat();
  stop = requestTally(thread, onEvent);
}

function toggleDrawer(show = drawer.hidden || !host.isConnected) {
  if (!host.isConnected) {
    host.style.setProperty('--ts-font', getComputedStyle(document.body).fontFamily);
    document.body.append(host);
  }
  drawer.hidden = !show;
  if (show && phase === 'idle') void start();
  else render();
}

// ---- the way in ----

const LINK_CLASS = 'ts-tally-link';
const placeEntry = () => {
  if (!onThread() || document.querySelector(`.${LINK_CLASS}`)) return;
  const open = (e: Event) => { e.preventDefault(); toggleDrawer(); };
  const buttons = document.querySelector('#siteTable .thing.link .flat-list.buttons');
  if (buttons) {
    const a = el('a', LINK_CLASS, 'tally') as HTMLAnchorElement;
    a.href = '#';
    a.title = `Tally the options this thread recommends (${KEY})`;
    a.addEventListener('click', open);
    const li = el('li');
    li.append(a);
    buttons.append(li);
    return;
  }
  const post = document.querySelector('shreddit-post');
  if (!post) return;
  const pill = button(`${LINK_CLASS} ts-tally-pill`, 'Tally the options');
  pill.title = KEY;
  pill.addEventListener('click', open);
  post.after(pill);
};

// A new thread in new Reddit's single-page app starts afresh.
let shownFor = location.pathname;
const sync = () => {
  if (location.pathname !== shownFor) {
    shownFor = location.pathname;
    stop?.();
    stop = null;
    stopAsk?.();
    stopAsk = null;
    turns = [];
    renderChat();
    phase = 'idle';
    rows = [];
    drawer.hidden = true;
    markThread(null);
  }
  placeEntry();
};

void tallyReady().then((ready) => {
  if (!ready) return;
  sync();
  let pending = 0;
  new MutationObserver(() => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; sync(); });
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (e.code === 'KeyT' && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && onThread()) {
      e.preventDefault();
      toggleDrawer();
    } else if (e.key === 'Escape' && host.isConnected && !drawer.hidden) {
      toggleDrawer(false);
    }
  });
});
