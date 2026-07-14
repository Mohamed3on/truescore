import { renderMarkdown, renderMarkdownInline } from './markdown';
import {
  compileMatchRegex, overallScoreFromHistogram, parseOrQuery, reviewAge, sortChipsByImpact, sortedDisplayReviews, starString, textReviewsFor, timeAgo,
  type Chip, type DayHours, type HighlightEvent, type HighlightsResponse, type HistogramResponse,
  type LookupEvent, type LookupPayload, type PartialScore, type PlaceItem, type PlaceMeta,
  type PlacesResponse, type Review, type Score, type SearchEvent, type SearchResult,
  type SortStats, type Summary, type SummarizeResponse,
  type AskRequest, type HighlightSummaryRequest, type HighlightsRequest, type HistogramRequest, type LookupRequest, type SearchRequest, type SummarizeRequest,
} from '@truescore/gmaps-shared';

// Cloudflare 5xx (502/521/522/524) returns an HTML error page, which would
// hit resp.json() and surface as the cryptic "Unexpected token '<'". Retry
// transient failures so the user doesn't have to refresh to recover.
const RETRY_STATUSES = new Set([502, 503, 504, 521, 522, 524]);

async function fetchWithRetry(input: RequestInfo, init?: RequestInit, retries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetch(input, init);
      if (!RETRY_STATUSES.has(resp.status) || attempt >= retries) return resp;
    } catch (e) {
      if (attempt >= retries) throw e;
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 200));
  }
}

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const resp = await fetchWithRetry(input, init);
  const ct = resp.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new Error(`server returned ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`);
  const data = await resp.json() as T;
  if (!resp.ok) throw new Error((data as { error?: string }).error || `request failed (${resp.status})`);
  return data;
}

const postJson = <T>(url: string, body: unknown): Promise<T> =>
  fetchJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Stream NDJSON events from a fetch response body. Each JSON-line yields as
// one event; partial lines accumulate in a buffer until the next newline.
// Used by /api/lookup, /api/search, /api/highlights, /api/ask.
async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as T;
        } catch {
          console.warn('[readNdjson] skipping unparseable line');
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function postNdjson(url: string, body: unknown): Promise<Response> {
  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ct = resp.headers.get('content-type') ?? '';
  if (!resp.ok && ct.includes('json') && !ct.includes('ndjson')) {
    const data = await resp.json().catch(() => null);
    throw new Error(data?.error || `request failed (${resp.status})`);
  }
  if (!resp.ok) throw new Error(`server returned ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`);
  if (!ct.includes('ndjson') || !resp.body) throw new Error('expected NDJSON stream');
  return resp;
}

// Open an NDJSON POST stream and yield its events, throwing on a server-sent
// `error` event so callers only branch on their own event types.
async function* streamNdjson<T extends { type: string }>(url: string, body: unknown): AsyncGenerator<T> {
  const resp = await postNdjson(url, body);
  for await (const evt of readNdjson<T>(resp.body!)) {
    if (evt.type === 'error') throw new Error((evt as { error?: string }).error || 'request failed');
    yield evt;
  }
}

// Client-only: the wire Chip plus per-chip UI status while its score streams.
type ChipState = 'loading' | 'done' | 'error';
type UiChip = Chip & { state?: ChipState; error?: string };

const $ = (id: string) => document.getElementById(id)!;

const form = $('form') as HTMLFormElement;
const urlInput = $('url') as HTMLInputElement;
const goBtn = $('go') as HTMLButtonElement;
const result = $('result') as HTMLElement;
const status = $('status') as HTMLElement;
const askForm = $('askForm') as HTMLFormElement;
const questionInput = $('question') as HTMLInputElement;
const askBtn = $('askBtn') as HTMLButtonElement;
const answerEl = $('answer') as HTMLElement;
const resummarizeBtn = $('resummarize') as HTMLButtonElement;
const highlightsRow = $('highlightsRow') as HTMLElement;
const highlightsList = $('highlightsList') as HTMLElement;
const highlightsRefreshBtn = $('highlightsRefresh') as HTMLButtonElement;
const standoutsRow = $('standoutsRow') as HTMLElement;
const standoutsList = $('standoutsList') as HTMLElement;
const alternativesRow = $('alternativesRow') as HTMLElement;
const alternativesList = $('alternativesList') as HTMLElement;
const searchForm = $('searchForm') as HTMLFormElement;
const searchInput = $('searchInput') as HTMLInputElement;
const searchBtn = $('searchBtn') as HTMLButtonElement;
const searchRefreshBtn = $('searchRefreshBtn') as HTMLButtonElement;
const chipPanel = $('chipPanel') as HTMLElement;
const chipPanelTitle = $('chipPanelTitle') as HTMLElement;
const chipBody = $('chipBody') as HTMLElement;
const chipSummarizeBtn = $('chipSummarize') as HTMLButtonElement;
const chipCloseBtn = $('chipClose') as HTMLButtonElement;
const chipAskForm = $('chipAskForm') as HTMLFormElement;
const chipQuestionInput = $('chipQuestion') as HTMLInputElement;
const chipAskBtn = $('chipAskBtn') as HTMLButtonElement;
const verdictRow = document.querySelector('.verdict-row') as HTMLElement;
const highlightsListEl = $('highlights') as HTMLElement;
const placesSection = $('places') as HTMLElement;
const placesList = $('placesList') as HTMLElement;
const placesToggle = $('placesToggle') as HTMLButtonElement;
const explainerEl = $('explainer') as HTMLElement;

const PLACES_TOP_N = 8;
let placesCache: PlaceItem[] = [];
let placesExpanded = false;

let currentFeatureId = '';
let currentMergedPct = 0;
// The chip panel shows one subject at a time — a highlight chip or a free-text
// search result — so model it as one discriminated union rather than two
// mutually-exclusive nullable globals with a "set one, null the other" invariant.
type ActivePanel = { kind: 'highlight'; chip: UiChip } | { kind: 'search'; result: SearchResult };
let activePanel: ActivePanel | null = null;
const panelReviews = (): Review[] | undefined =>
  activePanel?.kind === 'highlight' ? activePanel.chip.reviews : activePanel?.kind === 'search' ? activePanel.result.reviews : undefined;
const panelFilter = (): string | undefined =>
  activePanel?.kind === 'highlight' ? activePanel.chip.label : activePanel?.kind === 'search' ? activePanel.result.query : undefined;
let currentHighlights: UiChip[] = [];
let highlightReviewsInflight: Promise<void> | null = null;

// Standouts (praised items) and Better-alternatives (rival places) are the same
// kind of group: each item is auto-scored by its own label search (a SearchResult
// once scored), shown with its score, most-mentioned first; clicking opens it in
// the search panel. They differ only in which row/list they render into.
type ScoredChip = { item: string; state: ChipState; result?: SearchResult };
const scoredGroups = {
  standouts: { chips: [] as ScoredChip[], row: standoutsRow, list: standoutsList, chipClass: '' },
  alternatives: { chips: [] as ScoredChip[], row: alternativesRow, list: alternativesList, chipClass: 'alternative-chip' },
};
type ScoredKind = keyof typeof scoredGroups;

function setStatus(msg: string, isErr = false) {
  status.textContent = msg;
  status.classList.toggle('err', isErr);
}

// Session-health banner: the server can only fetch reviews while the extension
// has seeded a live Google Maps session. When it's stale/credless every lookup
// reads empty, so surface an actionable reseed prompt instead of silent zeros.
const sessionBanner = $('sessionBanner') as HTMLElement;
async function refreshSessionHealth() {
  try {
    const r = await fetch('/api/session-health', { cache: 'no-store' });
    if (!r.ok) return;
    const { healthy } = (await r.json()) as { healthy: boolean };
    sessionBanner.hidden = healthy;
  } catch { /* transient network issue — leave the banner as-is */ }
}

function scoreClass(pct: number) {
  if (pct >= 60) return 'pos';
  if (pct <= 30) return 'neg';
  return 'mid';
}

function chipClass(pct: number, overall: number) {
  return pct >= overall ? 'pos' : 'neg';
}

// Build one element: tag + optional class + optional text. Collapses the
// pervasive createElement / className / textContent triples into one call.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// The one chip-button shape shared by highlights, scored groups, and pending
// placeholders: label · <pct span> · optional ·count. `pct` is the middle span's
// {text, class}; `cls` adds button modifiers (loading / errored / alternative-chip).
type ChipSpec = { label: string; pct: { text: string; cls: string }; count?: number | null; cls?: string; token?: string; title?: string; disabled?: boolean; onClick?: () => void };
function chip(spec: ChipSpec): HTMLButtonElement {
  const btn = el('button', spec.cls ? `chip ${spec.cls}` : 'chip');
  btn.type = 'button';
  if (spec.token) btn.dataset.token = spec.token;
  if (spec.title) btn.title = spec.title;
  btn.append(el('span', 'label', spec.label), el('span', `pct ${spec.pct.cls}`, spec.pct.text));
  if (spec.count != null) btn.append(el('span', 'count', `·${spec.count}`));
  if (spec.onClick) btn.addEventListener('click', spec.onClick);
  if (spec.disabled) btn.disabled = true;
  return btn;
}

function renderHighlights(highlights: UiChip[], sort = false) {
  const list = sort ? sortChipsByImpact(highlights, currentMergedPct) : highlights;
  highlightsList.replaceChildren(...list.map((h) => {
    const state: ChipState = h.state ?? (h.score ? 'done' : 'loading');
    const pct = state === 'done' && h.score
      ? { text: `${h.score.scorePct}%`, cls: chipClass(h.score.scorePct, currentMergedPct) }
      : state === 'error' ? { text: '✗', cls: 'neg' } : { text: '…', cls: 'chip-pending' };
    return chip({
      label: h.label, pct, count: h.count, token: h.token,
      cls: state === 'loading' ? 'loading' : state === 'error' ? 'errored' : undefined,
      title: state === 'error' && h.error ? h.error : undefined,
      disabled: state !== 'done',
      onClick: state === 'done' ? () => onHighlightClick(h) : undefined,
    });
  }));
}

// Render a scored group's chips, progressive-enhancement style: items still
// being scored show immediately as pulsing "…" placeholders, scored ones (≥2
// mentions, most-mentioned first) show their score and open the search panel on
// click. Scores fill in inline; a chip that lands below 2 mentions drops out.
function renderScored(kind: ScoredKind) {
  const g = scoredGroups[kind];
  const scored = g.chips
    .filter((d) => d.result && d.result.totalReviews >= 2)
    .sort((a, b) => b.result!.totalReviews - a.result!.totalReviews);
  const pending = g.chips.filter((d) => d.state === 'loading');
  g.row.hidden = scored.length === 0 && pending.length === 0;
  g.list.replaceChildren(
    ...scored.map((d) => {
      const r = d.result!;
      return chip({
        label: d.item, cls: g.chipClass || undefined, count: r.totalReviews,
        pct: { text: r.trustedReviews ? `${r.scorePct}%` : '—', cls: chipClass(r.scorePct, currentMergedPct) },
        onClick: () => showSearchPanel(r),
      });
    }),
    ...pending.map((d) => chip({
      label: d.item, pct: { text: '…', cls: 'chip-pending' },
      cls: g.chipClass ? `${g.chipClass} loading` : 'loading', disabled: true,
    })),
  );
}

async function scoreChip(kind: ScoredKind, featureId: string, d: ScoredChip) {
  try {
    // The server expands the term to its accent/hyphen/space spellings.
    let result: SearchResult | null = null;
    for await (const evt of streamNdjson<SearchEvent>('/api/search', { featureId, query: d.item } satisfies SearchRequest)) {
      if (evt.type === 'search') result = evt.result;
    }
    if (currentFeatureId !== featureId) return;
    d.result = result ?? undefined;
    d.state = result ? 'done' : 'error';
  } catch {
    if (currentFeatureId !== featureId) return;
    d.state = 'error';
  }
  renderScored(kind);
}

function showScored(kind: ScoredKind, items: string[] | undefined, featureId: string) {
  const g = scoredGroups[kind];
  g.chips = (items ?? []).map((item) => ({ item, state: 'loading' as ChipState }));
  renderScored(kind);
  for (const d of g.chips) scoreChip(kind, featureId, d);
}

function clearScored(kind: ScoredKind) {
  scoredGroups[kind].chips = [];
  renderScored(kind);
}

function showHighlightsLoading(msg: string) {
  highlightsRow.hidden = false;
  highlightsList.replaceChildren(el('span', 'chip-loading', msg));
}

function setActiveChip(token?: string) {
  highlightsList.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.token === token);
  });
}

function setPanelTitle(label: string, scorePct: number, trusted: number, total: number) {
  chipPanelTitle.replaceChildren(
    el('span', undefined, label), ' · ',
    el('span', `pct ${chipClass(scorePct, currentMergedPct)}`, `${scorePct}%`),
    ` · ${trusted} trusted of ${total}`,
  );
}

function showChipPanel(h: UiChip) {
  activePanel = { kind: 'highlight', chip: h };
  setActiveChip(h.token);
  const score = h.score?.scorePct ?? 0;
  setPanelTitle(h.label.toUpperCase(), score, h.score?.trustedReviews ?? 0, h.reviews?.length ?? h.count);
  renderReviewList(h.reviews ?? []);
  chipPanel.hidden = false;
  verdictRow.style.display = 'none';
  highlightsListEl.style.display = 'none';
  resummarizeBtn.style.display = 'none';
  chipSummarizeBtn.disabled = false;
  chipSummarizeBtn.textContent = 'SUMMARIZE';
  chipQuestionInput.value = '';
  chipPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeChipPanel() {
  activePanel = null;
  setActiveChip(undefined);
  chipPanel.hidden = true;
  verdictRow.style.display = '';
  highlightsListEl.style.display = '';
  resummarizeBtn.style.display = '';
  searchInput.value = '';
  chipQuestionInput.value = '';
  setStatus('');
}

async function askChipPanel() {
  const q = chipQuestionInput.value.trim();
  if (!q || !currentFeatureId) return;
  const reviews = panelReviews();
  const filter = panelFilter();
  if (!reviews || !filter) return;
  const reviewTexts = textReviewsFor(reviews);
  if (!reviewTexts.length) { setStatus('No review text available', true); return; }
  chipAskBtn.disabled = true;
  setStatus(`Asking about "${filter}"…`);
  chipBody.replaceChildren(el('div', 'chip-loading', 'asking…'));
  try {
    const data = await postJson<{ answer?: string }>('/api/ask', {
      featureId: currentFeatureId, question: q, filter, reviewTexts,
    } satisfies AskRequest);
    const answer = el('div', 'answer');
    renderMarkdown(answer, data.answer ?? '');
    chipBody.replaceChildren(answer);
    chipQuestionInput.value = '';
    setStatus('');
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    chipAskBtn.disabled = false;
  }
}

function showSearchPanel(r: SearchResult) {
  activePanel = { kind: 'search', result: r };
  setActiveChip(undefined);
  setPanelTitle(`"${r.query.toUpperCase()}"`, r.scorePct, r.trustedReviews, r.reviews.length);
  chipPanel.hidden = false;
  verdictRow.style.display = 'none';
  highlightsListEl.style.display = 'none';
  resummarizeBtn.style.display = 'none';
  chipSummarizeBtn.disabled = false;
  chipQuestionInput.value = '';
  if (r.summary) {
    chipSummarizeBtn.textContent = 'SHOW REVIEWS';
    renderChipSummary(r.summary);
  } else {
    chipSummarizeBtn.textContent = 'SUMMARIZE';
    renderReviewList(r.reviews);
  }
  chipPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Fill `target` with `text`, wrapping case-insensitive occurrences of `terms`
// in <mark class="review-mark">. Review text is plain (no markdown), so build
// the nodes directly rather than walking a rendered tree.
function highlightInto(target: HTMLElement, text: string, terms: string[]) {
  const re = compileMatchRegex(terms);
  if (!re) { target.textContent = text; return; }
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement('mark');
    mark.className = 'review-mark';
    mark.textContent = m[0];
    target.appendChild(mark);
    last = m.index + m[0].length;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

function renderReviewList(reviews: Review[]) {
  // Same precedence as askChipPanel's `filter`: a chip search by its label, a
  // text search by its query — tokenized to words. Only the fallback for reviews
  // with no exact offsets (e.g. a shown translation); else r.matchTerms wins.
  const fallback = (activePanel?.kind === 'highlight' ? [activePanel.chip.label] : activePanel?.kind === 'search' ? parseOrQuery(activePanel.result.query) : [])
    .flatMap((t) => t.split(/\s+/));
  chipBody.replaceChildren(...sortedDisplayReviews(reviews).map((r) => {
    const meta = el('div', 'review-meta');
    meta.append(el('span', 'review-stars', starString(r.stars)), el('span', 'review-age', reviewAge(r.timestamp)));
    const text = el('p', 'review-text');
    highlightInto(text, r.text, r.matchTerms?.length ? r.matchTerms : fallback);
    const card = el('div', 'review-card');
    card.append(meta, text);
    return card;
  }));
}

// One <li><span class="h-text {sentiment}"> per highlight, appended to ul.
function renderHighlightList(ul: HTMLElement, highlights: Summary['highlights']) {
  for (const h of highlights) {
    const text = el('span', `h-text ${h.sentiment === 'positive' ? 'pos' : h.sentiment === 'negative' ? 'neg' : 'neutral'}`);
    renderMarkdownInline(text, h.text ?? '');
    const li = el('li');
    li.appendChild(text);
    ul.appendChild(li);
  }
}

function renderChipSummary(summary: Summary) {
  const verdict = el('div', 'verdict');
  renderMarkdown(verdict, summary.verdict);
  chipBody.replaceChildren(verdict);
  if (summary.highlights?.length) {
    const ul = el('ul', 'highlights');
    renderHighlightList(ul, summary.highlights);
    chipBody.appendChild(ul);
  }
}

async function onHighlightClick(h: UiChip) {
  if (!currentFeatureId) return;
  if (activePanel?.kind === 'highlight' && activePanel.chip.token === h.token) {
    closeChipPanel();
    return;
  }
  showChipPanel(h);
  if (h.reviews) return;
  chipBody.replaceChildren(el('div', 'chip-loading', 'loading reviews…'));
  await ensureHighlightReviews();
  if (activePanel?.kind !== 'highlight' || activePanel.chip !== h) return;
  setPanelTitle(h.label.toUpperCase(), h.score?.scorePct ?? 0, h.score?.trustedReviews ?? 0, (h as Chip).reviews?.length ?? h.count);
  renderReviewList(h.reviews ?? []);
}

async function summarizeActiveChip() {
  const h = activePanel?.kind === 'highlight' ? activePanel.chip : null;
  if (!h || !currentFeatureId) return;
  chipSummarizeBtn.disabled = true;
  chipSummarizeBtn.textContent = 'SUMMARIZING…';
  setStatus(`Summarizing "${h.label}"…`);
  const t0 = Date.now();
  try {
    const data = await postJson<{ summary?: Summary; cached?: boolean }>('/api/highlight-summary', {
      featureId: currentFeatureId, token: h.token,
    } satisfies HighlightSummaryRequest);
    if (data.summary) {
      renderChipSummary(data.summary);
      chipSummarizeBtn.disabled = false;
      chipSummarizeBtn.textContent = 'SHOW REVIEWS';
      setStatus(`"${h.label}" summarized${data.cached ? ' (cached)' : ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`}`);
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
    chipSummarizeBtn.disabled = false;
    chipSummarizeBtn.textContent = 'SUMMARIZE';
  }
}

async function summarizeActiveSearch() {
  const r = activePanel?.kind === 'search' ? activePanel.result : null;
  if (!r || !currentFeatureId) return;
  chipSummarizeBtn.disabled = true;
  chipSummarizeBtn.textContent = 'SUMMARIZING…';
  setStatus(`Summarizing "${r.query}"…`);
  const t0 = Date.now();
  try {
    let result: SearchResult | null = null;
    let cached = false;
    for await (const evt of streamNdjson<SearchEvent>('/api/search', {
      featureId: currentFeatureId, query: r.query, summarize: true,
    } satisfies SearchRequest)) {
      if (evt.type === 'search') {
        result = evt.result;
        cached = evt.cached;
      } else if (evt.type === 'search-summary') {
        if (result) {
          result.summary = evt.summary;
          activePanel = { kind: 'search', result };
        }
        renderChipSummary(evt.summary);
      }
    }
    chipSummarizeBtn.disabled = false;
    chipSummarizeBtn.textContent = result?.summary ? 'SHOW REVIEWS' : 'SUMMARIZE';
    if (result?.summary) {
      setStatus(`"${r.query}" summarized${cached ? ' (cached)' : ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`}`);
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
    chipSummarizeBtn.disabled = false;
    chipSummarizeBtn.textContent = 'SUMMARIZE';
  }
}

async function runSearch(query: string, force = false) {
  if (!currentFeatureId || !query.trim()) return;
  searchBtn.disabled = true;
  setStatus(`Searching "${query}"…`);
  const t0 = Date.now();
  try {
    for await (const evt of streamNdjson<SearchEvent>('/api/search', {
      featureId: currentFeatureId, query, force,
    } satisfies SearchRequest)) {
      if (evt.type === 'search-progress') {
        // Per-page progress: same `Searching "x" · N reviews · P%` shape so
        // the user sees the search count climb instead of staring at a fixed
        // spinner.
        setStatus(`Searching "${query}" · ${evt.totalReviews} reviews · ${evt.scorePct}%`);
      } else if (evt.type === 'search') {
        showSearchPanel(evt.result);
        setStatus(
          evt.cached
            ? `"${query}" cached · ${evt.result.totalReviews} reviews · ${evt.result.scorePct}%`
            : `"${query}" · ${evt.result.totalReviews} reviews · ${evt.result.scorePct}% in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        );
      }
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    searchBtn.disabled = false;
  }
}

// The server harvests a cold place's topic chips in the background (the preview
// RPC only serves them intermittently) and answers 202 `pending` in the
// meantime. Re-poll a bounded number of times until the chips arrive or it 404s.
let highlightsRepolls = 0;
let highlightsPollTimer: ReturnType<typeof setTimeout> | null = null;
const HIGHLIGHTS_MAX_REPOLLS = 12;
const HIGHLIGHTS_REPOLL_MS = 3500;

function scheduleHighlightsRepoll(featureId: string) {
  if (highlightsRepolls >= HIGHLIGHTS_MAX_REPOLLS) { highlightsPollTimer = null; highlightsRow.hidden = true; return; }
  highlightsRepolls++;
  highlightsPollTimer = setTimeout(() => {
    highlightsPollTimer = null;
    if (currentFeatureId === featureId) void loadHighlights(false, true);
  }, HIGHLIGHTS_REPOLL_MS);
}

async function loadHighlights(force = false, isRepoll = false) {
  if (!currentFeatureId) return;
  if (!isRepoll) {
    highlightsRepolls = 0;
    if (highlightsPollTimer) { clearTimeout(highlightsPollTimer); highlightsPollTimer = null; }
  }
  showHighlightsLoading(force ? 'refreshing…' : isRepoll ? 'finding topics…' : 'loading highlights…');
  highlightsRefreshBtn.hidden = true;
  try {
    const resp = await fetchWithRetry('/api/highlights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: currentFeatureId, force } satisfies HighlightsRequest),
    });
    const ct = resp.headers.get('content-type') ?? '';
    if (resp.ok && ct.includes('ndjson') && resp.body) {
      await consumeHighlightStream(resp.body);
      highlightsRefreshBtn.hidden = false;
      return;
    }
    if (!ct.includes('json')) throw new Error(`server returned ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`);
    const data = await resp.json() as HighlightsResponse;
    if (data.pending) { scheduleHighlightsRepoll(currentFeatureId); return; }
    if (!resp.ok) {
      if (resp.status === 404) { highlightsRow.hidden = true; return; } // no topic chips for this place
      throw new Error(data.error || `request failed (${resp.status})`);
    }
    if (data.highlights?.length) showHighlights(data.highlights);
    else highlightsRow.hidden = true;
  } catch (e) {
    showHighlightsLoading(`couldn't load highlights — ${e instanceof Error ? e.message : String(e)}`);
  }
}

function showHighlights(highlights: UiChip[]) {
  highlightsRow.hidden = false;
  currentHighlights = highlights;
  renderHighlights(highlights, true);
  highlightsRefreshBtn.hidden = false;
}

// /api/lookup returns highlights without per-chip review bodies — fetched
// here on demand the first time a user opens a chip. /api/highlights cache
// hit is fast and the result is mutated into the in-memory chips so
// subsequent clicks are instant.
async function ensureHighlightReviews(): Promise<void> {
  if (highlightReviewsInflight) return highlightReviewsInflight;
  if (!currentFeatureId || !currentHighlights.length) return;
  if (currentHighlights.every((h) => h.reviews)) return;
  highlightReviewsInflight = (async () => {
    try {
      const resp = await fetchWithRetry('/api/highlights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureId: currentFeatureId } satisfies HighlightsRequest),
      });
      const ct = resp.headers.get('content-type') ?? '';
      if (!resp.ok || !ct.includes('json')) return;
      const data = await resp.json() as HighlightsResponse;
      const byToken = new Map((data.highlights ?? []).map((h) => [h.token, h.reviews]));
      for (const h of currentHighlights) {
        if (!h.reviews) h.reviews = byToken.get(h.token);
      }
    } finally {
      highlightReviewsInflight = null;
    }
  })();
  return highlightReviewsInflight;
}

async function consumeHighlightStream(body: ReadableStream<Uint8Array>) {
  const chipMap = new Map<string, UiChip>();
  let lastFailures = 0;
  for await (const evt of readNdjson<HighlightEvent>(body)) {
    switch (evt.type) {
      case 'chips':
        chipMap.clear();
        for (const c of evt.chips) chipMap.set(c.token, { ...c, state: 'loading' });
        renderHighlights([...chipMap.values()]);
        break;
      case 'chip':
        chipMap.set(evt.highlight.token, { ...evt.highlight, state: 'done' });
        renderHighlights([...chipMap.values()]);
        break;
      case 'chip-error': {
        const existing = chipMap.get(evt.token) ?? { token: evt.token, label: evt.label, count: 0 };
        chipMap.set(evt.token, { ...existing, state: 'error', error: evt.error });
        renderHighlights([...chipMap.values()]);
        break;
      }
      case 'done':
        lastFailures = evt.failures;
        renderHighlights([...chipMap.values()], true);
        break;
      case 'error':
        throw new Error(evt.error || 'highlights failed');
    }
  }
  if (lastFailures > 0) {
    setStatus(`${lastFailures} highlight${lastFailures === 1 ? '' : 's'} failed — refresh to retry`, true);
  }
}

const DEFAULT_TITLE = document.title;

// Pure render: header, score numbers, freshness, histogram-derived overall.
// Safe to re-run on revalidate (no UI state reset) so the freshness label and
// score can update in place when the server pushes a `refreshed` event.
// Paints whichever subset of {place, preview, score} is currently in hand.
// Called both with full data (cache-hit `lookup` event, cache-miss `score`
// event) and partial data (cache-miss `place` / `preview` / `score-progress`).
// Missing fields render as em-dashes / hidden blocks so the user sees a
// stable layout that fills in instead of swapping wholesale.
type PaintData = {
  name?: string;
  featureId?: string;
  score?: PartialScore | Score;
  histogram?: number[] | null;
  overallPct?: number | null;
  meta?: PlaceMeta | null;
  resolvedUrl?: string;
};
function paintScore(data: PaintData) {
  const featureId = data.score?.featureId ?? data.featureId;
  const displayName = data.meta?.canonicalName || data.name || '(unnamed place)';
  const nameEl = $('name') as HTMLAnchorElement;
  nameEl.textContent = displayName;
  if (data.resolvedUrl) nameEl.href = data.resolvedUrl;
  else if (featureId) nameEl.href = `https://www.google.com/maps?q=&ftid=${featureId}`;
  document.title = data.score
    ? `${displayName} · ${data.score.scorePct}% · TrueScore`
    : `${displayName} · TrueScore`;
  renderPlaceMeta(data.meta ?? undefined);
  if (data.score && 'reviews' in data.score && data.score.reviews) {
    renderFreshness(data.score.reviews);
  }
  const pctEl = $('scorePct');
  if (data.score) {
    pctEl.textContent = `${data.score.scorePct}`;
    pctEl.className = `score-num ${scoreClass(data.score.scorePct)}`;
    const trustedPct = data.score.totalReviews
      ? Math.round((data.score.trustedReviews / data.score.totalReviews) * 100)
      : 0;
    $('reviewsLabel').textContent =
      `${data.score.totalReviews} · ${data.score.trustedReviews} (${trustedPct}%)`;
    $('relevantPct').textContent = `${data.score.relevant.scorePct}%`;
    $('newestPct').textContent = `${data.score.newest.scorePct}%`;
    const delta = data.score.newest.scorePct - data.score.relevant.scorePct;
    const deltaEl = $('newestDelta');
    if (data.score.newest.trustedReviews === 0 || data.score.relevant.trustedReviews === 0) {
      deltaEl.textContent = '';
    } else {
      deltaEl.textContent = delta === 0 ? '' : `${delta > 0 ? '+' : ''}${delta}`;
      deltaEl.className = `delta ${delta > 0 ? 'pos' : delta < 0 ? 'neg' : ''}`;
    }
    currentMergedPct = data.score.scorePct;
  } else {
    pctEl.textContent = '—';
    pctEl.className = 'score-num';
    $('reviewsLabel').textContent = '—';
    $('relevantPct').textContent = '—';
    $('newestPct').textContent = '—';
    $('newestDelta').textContent = '';
  }
  renderOverallScore(data.histogram ?? null);
  renderOverall(data.overallPct ?? null, data.score?.scorePct ?? 0);
}

// One-time setup for a new lookup: show the result panel, wipe the previous
// place's data, prep skeletons. Both the cache-hit `lookup` event and the
// cache-miss `place` event flow through this before painting whatever data
// they have. Subsequent `score-progress` / `preview` ticks just re-paint.
function initResultPanel(featureId: string, resolvedUrl?: string) {
  result.hidden = false;
  document.body.dataset.state = 'scored';
  currentFeatureId = featureId;
  activePanel = null;
  answerEl.textContent = '';
  questionInput.value = '';
  $('valueForMoney').textContent = '—';
  $('verdict').textContent = '';
  resummarizeBtn.hidden = true;
  highlightsRow.hidden = true;
  clearScored('standouts');
  clearScored('alternatives');
  chipPanel.hidden = true;
  verdictRow.style.display = '';
  highlightsListEl.style.display = '';
  searchForm.hidden = false;
  searchInput.value = '';
  searchRefreshBtn.hidden = true;
  highlightsList.replaceChildren();
  highlightsListEl.replaceChildren();
  chipBody.replaceChildren();
  // Wipe the previous place's meta/freshness so a fresh-lookup sequence
  // doesn't show stale photo + address until `preview` lands.
  renderPlaceMeta(undefined);
  renderFreshness([]);
  const shareUrl = resolvedUrl ?? urlInput.value;
  if (shareUrl) {
    const next = `?url=${encodeURIComponent(shareUrl)}`;
    if (location.search !== next) history.replaceState(null, '', next);
  }
}

function renderScore(data: LookupPayload) {
  initResultPanel(data.score.featureId, data.resolvedUrl);
  paintScore(data);
}

function flashIfChanged(el: HTMLElement, prev: string) {
  if (el.textContent === prev) return;
  el.classList.remove('flash');
  void el.offsetWidth; // restart animation
  el.classList.add('flash');
}

async function consumeLookupStream(body: ReadableStream<Uint8Array>, t0: number): Promise<void> {
  const freshnessLabel = $('freshnessLabel');
  // Accumulator for cache-miss progressive events. The server emits these in
  // arbitrary order (preview lands ~500ms-1s, score-progress every 1-2s) so
  // we merge each into `acc` and repaint with whatever's accumulated so far.
  const acc: PaintData = {};
  let cachedTotal = 0;
  let refreshed = false;
  let summaryKicked = false;

  try {
    for await (const evt of readNdjson<LookupEvent>(body)) {
      if (evt.type === 'lookup') {
        const scoreMs = Date.now() - t0;
        cachedTotal = evt.score.totalReviews;
        renderScore(evt);
        freshnessLabel.classList.add('rechecking');
        if (evt.overallPct == null) fetchHistogramFor(evt.score.featureId, evt.score.scorePct);
        if (evt.highlights?.length) showHighlights(evt.highlights);
        else loadHighlights();
        if (evt.summary) {
          renderSummary(evt.summary);
          setStatus(`Cached · ${scoreMs}ms`);
        } else {
          setStatus(`Score in ${(scoreMs / 1000).toFixed(1)}s · summarizing…`);
          fetchSummaryFor(evt.score.featureId).then((sum) => {
            if (!refreshed) {
              setStatus(sum.ok ? `Done in ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'Summary failed', !sum.ok);
            }
          });
        }
      } else if (evt.type === 'refreshed') {
        refreshed = true;
        freshnessLabel.classList.remove('rechecking');
        const prevFresh = freshnessLabel.textContent ?? '';
        const prevScore = $('scorePct').textContent ?? '';
        const prevReviews = $('reviewsLabel').textContent ?? '';
        paintScore(evt);
        flashIfChanged(freshnessLabel, prevFresh);
        flashIfChanged($('scorePct'), prevScore);
        flashIfChanged($('reviewsLabel'), prevReviews);
        if (currentHighlights.length) {
          renderHighlights(currentHighlights, true);
          if (activePanel?.kind === 'highlight') setActiveChip(activePanel.chip.token);
        }
        const diff = evt.score.totalReviews - cachedTotal;
        const diffMsg = diff > 0 ? ` (+${diff} new)` : '';
        setStatus(`Updated with fresh reviews${diffMsg}`);
      } else if (evt.type === 'highlights-refreshed') {
        if (evt.highlights?.length) showHighlights(evt.highlights);
      } else if (evt.type === 'place') {
        // First event on a cache-miss lookup: clear the panel, swap in the
        // name immediately so the user gets visual confirmation while the
        // preview + score scrapes are still pending.
        initResultPanel(evt.featureId, evt.resolvedUrl);
        acc.name = evt.name;
        acc.featureId = evt.featureId;
        acc.resolvedUrl = evt.resolvedUrl;
        paintScore(acc);
        setStatus('Reading reviews…');
      } else if (evt.type === 'preview') {
        // Histogram + meta arrive together off a single preview RPC, usually
        // well before scorePlace finishes. Paint them in place.
        acc.histogram = evt.histogram;
        acc.overallPct = evt.overallPct;
        acc.meta = evt.meta ?? null;
        paintScore(acc);
      } else if (evt.type === 'score-progress') {
        // Every page of either sort. The number visibly settles as both
        // sorts converge — same UX as the extension's per-page repaint.
        acc.score = evt.score;
        paintScore(acc);
        setStatus(`Scoring · ${evt.score.totalReviews} reviews so far…`);
      } else if (evt.type === 'score') {
        acc.score = evt.score;
        paintScore(acc);
        renderFreshness(evt.score.reviews);
        const featureId = evt.score.featureId;
        // Kick off summary + highlights now that we know the place is real
        // and the score has settled. Idempotent (summaryKicked guards reruns
        // if a future server change ever re-emits `score`).
        if (!summaryKicked) {
          summaryKicked = true;
          loadHighlights();
          setStatus(`Score in ${(evt.fetchMs / 1000).toFixed(1)}s · summarizing…`);
          fetchSummaryFor(featureId).then((sum) => {
            setStatus(sum.ok ? `Done in ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'Summary failed', !sum.ok);
          });
        }
      } else if (evt.type === 'error') {
        throw new Error(evt.error || 'lookup failed');
      }
    }
  } finally {
    freshnessLabel.classList.remove('rechecking');
  }
}

function formatHourLabel(h: number): string {
  if (h === 0 || h === 24) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function localHourInTz(tz: string | undefined, now = new Date()): { day: number; hour: number } {
  const fallback = { day: now.getDay(), hour: now.getHours() + now.getMinutes() / 60 };
  if (!tz) return fallback;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'long', hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    const day = WEEKDAYS.indexOf(parts.weekday as typeof WEEKDAYS[number]);
    return {
      day: day >= 0 ? day : fallback.day,
      hour: parseInt(parts.hour!, 10) + parseInt(parts.minute!, 10) / 60,
    };
  } catch {
    return fallback;
  }
}

function isOpenNow(today: DayHours | undefined, hour: number): boolean | null {
  if (!today) return null;
  if (today.openHour != null && today.closeHour != null) {
    const close = today.closeHour <= today.openHour ? today.closeHour + 24 : today.closeHour;
    const cur = hour < today.openHour ? hour + 24 : hour;
    return cur >= today.openHour && cur < close;
  }
  if (today.label === 'Closed') return false;
  return null;
}

function renderHoursToday(meta: PlaceMeta | undefined) {
  const hoursEl = $('placeHours');
  const hoursStatusEl = $('placeHoursStatus');
  const hoursTodayEl = $('placeHoursToday');
  const week = meta?.hoursWeek;
  if (!week?.length) { hoursEl.hidden = true; return; }
  const { day, hour } = localHourInTz(meta?.timezone);
  const today = week.find((d) => WEEKDAYS.indexOf(d.day as typeof WEEKDAYS[number]) === day) ?? week[0];
  const open = isOpenNow(today, hour);
  const status = open === true ? 'open' : open === false ? 'closed' : null;
  hoursStatusEl.className = `place-hours-status ${status ?? ''}`;
  hoursStatusEl.textContent = status ? status.toUpperCase() : '';
  hoursStatusEl.hidden = status === null;
  const hoursLabel = today?.openHour != null && today.closeHour != null
    ? `${formatHourLabel(today.openHour)}–${formatHourLabel(today.closeHour)}`
    : (today?.label ?? '');
  hoursTodayEl.textContent = hoursLabel && today ? `${today.day.slice(0, 3)} · ${hoursLabel}` : '';
  hoursEl.hidden = false;
}

function renderPlaceMeta(meta: PlaceMeta | undefined) {
  const photoEl = $('placePhoto') as HTMLImageElement;
  const metaRow = $('placeMetaRow');
  const googleEl = $('placeGoogle');
  const addressEl = $('placeAddress');

  if (meta?.photoUrl) {
    photoEl.src = meta.photoUrl;
    photoEl.hidden = false;
  } else {
    photoEl.removeAttribute('src');
    photoEl.hidden = true;
  }

  const showTag = (el: HTMLElement, text: string | undefined) => {
    if (text) { el.textContent = text; el.hidden = false; } else { el.hidden = true; }
  };
  showTag($('placeCategory'), meta?.category);
  showTag($('placePrice'), meta?.priceRange);

  if (meta?.googleRating != null) {
    googleEl.replaceChildren(el('span', 'star', '★'), el('span', undefined, meta.googleRating.toFixed(1)));
    if (meta.googleReviewCount != null) {
      googleEl.appendChild(el('span', 'count', ` · ${meta.googleReviewCount.toLocaleString()} on Google`));
    }
    googleEl.hidden = false;
  } else {
    googleEl.hidden = true;
  }

  metaRow.hidden = !(meta?.category || meta?.priceRange || meta?.googleRating != null) && $('placeOverallScore').hidden;
  showTag(addressEl, meta?.address);
  renderHoursToday(meta);
}

function renderFreshness(reviews: Review[]) {
  const row = $('freshnessRow');
  const label = $('freshnessLabel');
  let latest = 0;
  for (const r of reviews) {
    if (r.timestamp != null && r.timestamp > latest) latest = r.timestamp;
  }
  if (!latest) { row.hidden = true; return; }
  // Google review timestamps come in microseconds; normalise to ms.
  const ms = latest > 1e14 ? latest / 1000 : latest;
  label.textContent = timeAgo(ms);
  row.hidden = false;
}

function renderOverall(overallPct: number | null, mergedPct: number) {
  const el = $('overallDelta');
  if (overallPct == null) {
    el.textContent = '';
    return;
  }
  const diff = mergedPct - overallPct;
  const sign = diff > 0 ? '+' : '';
  el.textContent = `${sign}${diff}% vs overall`;
  el.className = `overall-delta ${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}`;
}

function renderOverallScore(histogram: number[] | undefined | null) {
  const el = $('placeOverallScore');
  if (!histogram || !histogram.length) { el.hidden = true; return; }
  const score = overallScoreFromHistogram(histogram);
  el.textContent = `score ${score.toLocaleString()}`;
  el.hidden = false;
  $('placeMetaRow').hidden = false;
}

function renderSummary(summary: Summary) {
  $('valueForMoney').textContent = `${summary.valueForMoney}/5`;
  renderMarkdown($('verdict'), summary.verdict);
  resummarizeBtn.hidden = false;
  highlightsListEl.replaceChildren();
  renderHighlightList(highlightsListEl, summary.highlights);
  if (currentFeatureId) {
    showScored('standouts', summary.items, currentFeatureId);
    showScored('alternatives', summary.alternatives, currentFeatureId);
  } else { clearScored('standouts'); clearScored('alternatives'); }
}

function renderSummaryError(msg: string) {
  $('verdict').textContent = `summary failed: ${msg}`;
  clearScored('standouts');
  clearScored('alternatives');
}

async function fetchHistogramFor(featureId: string, mergedPct: number) {
  try {
    const data = await postJson<HistogramResponse>('/api/histogram', { featureId } satisfies HistogramRequest);
    if (data.overallPct != null) renderOverall(data.overallPct, mergedPct);
    if (data.histogram) renderOverallScore(data.histogram);
  } catch {}
}

async function fetchSummaryFor(featureId: string, force = false): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  try {
    const data = await postJson<SummarizeResponse>('/api/summarize', { featureId, force } satisfies SummarizeRequest);
    if (data.error) {
      renderSummaryError(data.error);
      return { ok: false, ms: Date.now() - t0 };
    }
    if (data.summary) {
      renderSummary(data.summary);
    }
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    renderSummaryError(e instanceof Error ? e.message : String(e));
    return { ok: false, ms: Date.now() - t0 };
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  // Push a history entry for user-initiated nav so back/forward works. Skip
  // when already at this URL (initial load with ?url=, popstate replay, or
  // a duplicate submit).
  const nextSearch = `?url=${encodeURIComponent(url)}`;
  if (location.search !== nextSearch) history.pushState(null, '', nextSearch);
  document.body.dataset.state = 'loading';
  goBtn.disabled = true;
  goBtn.textContent = 'FETCHING';
  setStatus('Resolving link…');
  const t0 = Date.now();
  try {
    const resp = await postNdjson('/api/lookup', { url } satisfies LookupRequest);
    await consumeLookupStream(resp.body!, t0);
  } catch (e) {
    delete document.body.dataset.state;
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = 'SCORE';
    // A lookup is when staleness surfaces (empty reviews) — re-check health so
    // the banner appears right when the user hits it.
    refreshSessionHealth();
  }
});

resummarizeBtn.addEventListener('click', async () => {
  if (!currentFeatureId) return;
  resummarizeBtn.disabled = true;
  setStatus('Re-summarizing…');
  const { ok, ms } = await fetchSummaryFor(currentFeatureId, true);
  setStatus(ok ? `New summary in ${(ms / 1000).toFixed(1)}s` : 'Re-summarize failed', !ok);
  resummarizeBtn.disabled = false;
});

highlightsRefreshBtn.addEventListener('click', async () => {
  highlightsRefreshBtn.disabled = true;
  setStatus('Refreshing highlights…');
  await loadHighlights(true);
  setStatus('');
  highlightsRefreshBtn.disabled = false;
});

chipSummarizeBtn.addEventListener('click', () => {
  if (chipSummarizeBtn.textContent === 'SHOW REVIEWS') {
    renderReviewList(panelReviews() ?? []);
    chipSummarizeBtn.textContent = 'SUMMARIZE';
    return;
  }
  if (activePanel?.kind === 'highlight') summarizeActiveChip();
  else if (activePanel?.kind === 'search') summarizeActiveSearch();
});

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  runSearch(q, false);
});

searchInput.addEventListener('input', () => {
  searchRefreshBtn.hidden = !searchInput.value.trim();
});

searchRefreshBtn.addEventListener('click', () => {
  const q = searchInput.value.trim();
  if (!q) return;
  runSearch(q, true);
});

chipCloseBtn.addEventListener('click', closeChipPanel);

function goHome() {
  delete document.body.dataset.state;
  result.hidden = true;
  urlInput.value = '';
  setStatus('');
  document.title = DEFAULT_TITLE;
  urlInput.focus();
  loadPlaces();
}

document.getElementById('brand')?.addEventListener('click', () => {
  if (location.search) history.pushState(null, '', location.pathname);
  goHome();
});

// Browser back/forward — route off the URL bar. Form submit checks
// location.search to avoid pushing a duplicate entry on replay.
window.addEventListener('popstate', () => {
  const u = new URLSearchParams(location.search).get('url');
  if (u) {
    urlInput.value = u;
    form.requestSubmit();
  } else {
    goHome();
  }
});

function renderPlaces() {
  placesList.replaceChildren();
  if (placesCache.length === 0) {
    placesSection.hidden = true;
    explainerEl.hidden = false;
    return;
  }
  placesSection.hidden = false;
  explainerEl.hidden = true;
  const list = placesExpanded ? placesCache : placesCache.slice(0, PLACES_TOP_N);
  for (const p of list) {
    const tile = el('button', 'place-tile');
    tile.type = 'button';
    tile.append(
      el('span', 'place-name', p.name),
      el('span', `place-score ${scoreClass(p.scorePct)}`, `${p.scorePct}`),
      el('span', 'place-age', timeAgo(p.lastAccessTs)),
    );
    tile.addEventListener('click', () => { urlInput.value = p.resolvedUrl; form.requestSubmit(); });
    placesList.appendChild(tile);
  }
  if (placesCache.length > PLACES_TOP_N) {
    placesToggle.hidden = false;
    placesToggle.textContent = placesExpanded ? 'SHOW LESS' : `SHOW ALL (${placesCache.length})`;
  } else {
    placesToggle.hidden = true;
  }
}

async function loadPlaces() {
  try {
    const data = await fetchJson<PlacesResponse>('/api/places');
    placesCache = data.places ?? [];
    renderPlaces();
  } catch (e) {
    console.error('[places]', e);
  }
}

placesToggle.addEventListener('click', () => {
  placesExpanded = !placesExpanded;
  renderPlaces();
});

chipAskForm.addEventListener('submit', (e) => { e.preventDefault(); askChipPanel(); });

askForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = questionInput.value.trim();
  if (!q || !currentFeatureId) return;
  askBtn.disabled = true;
  answerEl.textContent = '';
  setStatus('Asking…');
  try {
    const data = await postJson<{ answer?: string }>('/api/ask', {
      featureId: currentFeatureId, question: q,
    } satisfies AskRequest);
    renderMarkdown(answerEl, data.answer ?? '');
    questionInput.value = '';
    setStatus('');
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    askBtn.disabled = false;
  }
});

refreshSessionHealth();
// Poll so the banner clears (or appears) as the server's self-renewal heals or
// the session genuinely dies — not only on the next lookup.
setInterval(refreshSessionHealth, 30_000);
const sharedUrl = new URLSearchParams(location.search).get('url');
if (sharedUrl) {
  urlInput.value = sharedUrl;
  form.requestSubmit();
} else {
  loadPlaces();
}
