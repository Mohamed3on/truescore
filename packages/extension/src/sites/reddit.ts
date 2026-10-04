// Reddit: a Thread's Tally (CONTEXT.md). The Options its comments recommend or
// warn against, ranked by how many people take each side, in a drawer beside
// the thread, each opening onto the comments behind its count. Nothing runs
// until the post's "tally" link or Alt+T asks. Old reddit gets the link among
// the post's buttons and marks the counted comments in the thread; new Reddit a
// pill under the post and the drawer alone.
import { countsInTally, MIN_TALLY_PEOPLE, replaceChips, signedNet, speakersOf, STANCE_MARKS, threadFromListing, type ListedOption, type OptionTally, type Stance, type TallyCount, type TallyEvent, type Thread, type TitleTally } from '@truescore/gmaps-shared';
import { requestTally, tallyReady } from '../shared/tally';
import { el } from '../shared/utils';

const button = (className: string, text?: string) => {
  const b = el('button', className, text) as HTMLButtonElement;
  b.type = 'button';
  return b;
};

// `why`: a line on why people rate it as they do, once the server has written it.
type Row = { listed: ListedOption; tally?: OptionTally; why?: string };
// The shortcut, as the keyboard labels it.
const KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥T' : 'Alt+T';
type View = 'people' | 'upvotes';

const onThread = () => /^\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(location.pathname);
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
let openKey: string | null = null;
let openTitle: string | null = null;
let stop: (() => void) | null = null;

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
}
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
  background: var(--ts-ground);
  border-bottom: 1px solid var(--ts-line);
}
.ts-tally-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px 4px; }
.ts-tally-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ts-ink-3);
}
.ts-tally-view { display: inline-flex; margin-left: auto; border: 1px solid var(--ts-line); border-radius: 6px; overflow: hidden; }
.ts-tally button { font: inherit; color: inherit; }
.ts-tally-seg,
.ts-tally-close,
.ts-tally-opt,
.ts-tally-title,
.ts-tally-receipt,
.ts-tally-retry {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
}
.ts-tally-seg { padding: 2px 8px; font-size: 11px; color: var(--ts-ink-2); }
.ts-tally-seg[aria-pressed='true'] { background: var(--ts-hover); color: var(--ts-accent); font-weight: 700; }
.ts-tally-close { padding: 0 2px 2px 6px; font-size: 18px; line-height: 1; color: var(--ts-ink-3); }
.ts-tally-close:hover { color: var(--ts-ink); }
.ts-tally-keys { color: var(--ts-ink-3); font-size: 10px; }
.ts-tally-status { padding: 0 16px 10px; color: var(--ts-ink-3); font-variant-numeric: tabular-nums; }
.ts-tally-error { display: flex; align-items: baseline; gap: 10px; padding: 0 16px 10px; color: #b91c1c; }
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
.ts-tally-retry:focus-visible { outline: 2px solid var(--ts-accent); outline-offset: -2px; }
.ts-tally-name { flex: 1; min-width: 0; font-weight: 700; overflow-wrap: anywhere; }
.ts-tally-opt[aria-expanded='true'] .ts-tally-name { color: var(--ts-accent); }
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
`;

const host = el('div', 'ts-tally-host');
const shadow = host.attachShadow({ mode: 'open' });
const drawer = el('aside', 'ts-tally');
drawer.setAttribute('aria-label', 'Tally');
drawer.hidden = true;
const status = el('div', 'ts-tally-status');
status.setAttribute('aria-live', 'polite');
const viewSwitch = el('div', 'ts-tally-view');
const list = el('ol', 'ts-tally-list');
const once = el('details', 'ts-tally-once') as HTMLDetailsElement;
const onceLabel = el('summary', 'ts-tally-label');
const onceList = el('ol', 'ts-tally-list');
once.append(onceLabel, onceList);
const failBox = el('div', 'ts-tally-error');

{
  const head = el('div', 'ts-tally-head');
  const close = button('ts-tally-close', '×');
  close.setAttribute('aria-label', 'Close the tally (Esc)');
  close.addEventListener('click', () => toggleDrawer(false));
  for (const v of ['people', 'upvotes'] as View[]) {
    const b = button('ts-tally-seg', v);
    b.dataset.view = v;
    b.addEventListener('click', () => { view = v; render(); });
    viewSwitch.append(b);
  }
  const keys = el('span', 'ts-tally-keys', KEY);
  keys.title = `${KEY} opens and closes the tally, Esc closes it`;
  head.append(el('span', 'ts-tally-label', 'Tally'), keys, viewSwitch, close);
  const top = el('div', 'ts-tally-top');
  top.append(head, status, failBox);
  drawer.append(top, list, once);
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
  head.append(el('span', 'ts-tally-name', listed.name), tally ? figures(tally.count) : el('span', 'ts-tally-pending', 'reading…'));
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
  for (const b of viewSwitch.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  status.textContent = statusText();
  failBox.replaceChildren();
  if (phase === 'error') {
    const retry = button('ts-tally-retry', 'Try again');
    retry.addEventListener('click', () => void start());
    failBox.append(el('span', '', failure), retry);
  }
  const visible = shown();
  const counted = visible.filter((r) => r.tally && speakersOf(r.tally.count) >= MIN_TALLY_PEOPLE).sort((a, b) => byStanding(a.tally!.count, b.tally!.count));
  const pending = visible.filter((r) => !r.tally);
  const folded = visible.filter((r) => r.tally && speakersOf(r.tally.count) < MIN_TALLY_PEOPLE).sort((a, b) => byStanding(a.tally!.count, b.tally!.count));
  replaceChips(list, [...counted, ...pending].map((r) => ({ key: r.listed.key, el: rowEl(r) })));
  onceList.replaceChildren(...folded.map(rowEl));
  onceLabel.textContent = `Named by one person · ${folded.length}`;
  once.hidden = !folded.length;
  const open = rows.find((r) => r.listed.key === openKey)?.tally;
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

async function start() {
  stop?.();
  rows = [];
  rowEls.clear();
  openKey = openTitle = null;
  phase = 'listing';
  thread = null;
  render();
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
