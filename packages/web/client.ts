import { renderMarkdown, renderMarkdownInline } from './markdown';
import { overallScoreFromHistogram, textReviewsFor, timeAgo, type Review, type SortStats, type DayHours, type PlaceMeta } from '@truescore/gmaps-shared';

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
        if (line) yield JSON.parse(line) as T;
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

type SummaryHighlight = { text: string; description?: string; count: number; sentiment: string };
type Score = {
  featureId: string;
  totalReviews: number;
  trustedReviews: number;
  scorePct: number;
  relevant: SortStats;
  newest: SortStats;
  reviews: Review[];
};
type Summary = { highlights: SummaryHighlight[]; verdict: string; valueForMoney: number };
type LookupResponse = {
  name: string;
  score: Score;
  summary?: Summary;
  highlights?: Highlight[];
  histogram?: number[];
  overallPct?: number | null;
  meta?: PlaceMeta;
  resolvedUrl?: string;
  cached?: boolean;
  fetchMs?: number;
  error?: string;
};
// Score data emitted during streaming. The progressive `score-progress`
// events omit the per-review array (we don't ship 100+ review objects on
// each page tick); the final `score` event is the full Score.
type PartialScore = Omit<Score, 'reviews'>;
type LookupStreamEvent =
  | ({ type: 'lookup' } & LookupResponse)
  | { type: 'refreshed'; name: string; score: Score; histogram?: number[]; overallPct?: number | null; meta?: PlaceMeta; resolvedUrl?: string }
  | { type: 'highlights-refreshed'; highlights: Highlight[] }
  | { type: 'place'; name: string; featureId: string; resolvedUrl: string }
  | { type: 'preview'; histogram: number[] | null; overallPct: number | null; meta?: PlaceMeta }
  | { type: 'score-progress'; score: PartialScore }
  | { type: 'score'; score: Score; fetchMs: number }
  | { type: 'error'; error: string };
type SummarizeResponse = { summary?: Summary; error?: string; cached?: boolean };
type HistogramResponse = { histogram?: number[]; overallPct?: number; error?: string };
type ChipState = 'loading' | 'done' | 'error';
type Highlight = {
  label: string;
  count: number;
  token: string;
  score?: SortStats;
  reviews?: Review[];
  state?: ChipState;
  error?: string;
};
type HighlightsResponse = { highlights?: Highlight[]; cached?: boolean; error?: string };
type HighlightStreamEvent =
  | { type: 'chips'; chips: { label: string; count: number; token: string }[] }
  | { type: 'chip'; highlight: Highlight }
  | { type: 'chip-error'; token: string; label: string; error: string }
  | { type: 'done'; failures: number; totalFetched: number; cached: boolean };
type SearchResult = {
  query: string;
  totalReviews: number;
  trustedReviews: number;
  scorePct: number;
  reviews: Review[];
  summary?: Summary;
};
type SearchResponse = { result?: SearchResult; cached?: boolean; error?: string };
type SearchStats = { totalReviews: number; trustedReviews: number; scorePct: number };
type SearchStreamEvent =
  | ({ type: 'search-progress'; query: string } & SearchStats)
  | { type: 'search'; result: SearchResult; cached: boolean }
  | { type: 'search-summary'; summary: Summary }
  | { type: 'error'; error: string };
type PlaceItem = {
  featureId: string;
  name: string;
  scorePct: number;
  resolvedUrl: string;
  lastAccessTs: number;
};
type PlacesResponse = { places?: PlaceItem[]; error?: string };

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
let baseSummary: Summary | undefined;
let activeHighlight: Highlight | null = null;
let activeSearch: SearchResult | null = null;
let currentHighlights: Highlight[] = [];
let highlightReviewsInflight: Promise<void> | null = null;

function setStatus(msg: string, isErr = false) {
  status.textContent = msg;
  status.classList.toggle('err', isErr);
}

function scoreClass(pct: number) {
  if (pct >= 60) return 'pos';
  if (pct <= 30) return 'neg';
  return 'mid';
}

function chipClass(pct: number, overall: number) {
  return pct >= overall ? 'pos' : 'neg';
}

function renderHighlights(highlights: Highlight[], sort = false) {
  while (highlightsList.firstChild) highlightsList.removeChild(highlightsList.firstChild);
  const weight = (h: Highlight) => {
    const r = (h.score?.scorePct ?? 0) / 100;
    return r * Math.abs(r) * h.count;
  };
  const isAbove = (h: Highlight) => (h.score?.scorePct ?? 0) >= currentMergedPct;
  const list = sort
    ? [...highlights].sort((a, b) => {
        const above = Number(isAbove(b)) - Number(isAbove(a));
        if (above !== 0) return above;
        return weight(b) - weight(a);
      })
    : highlights;
  for (const h of list) {
    const state: ChipState = h.state ?? (h.score ? 'done' : 'loading');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.token = h.token;
    if (state === 'loading') btn.classList.add('loading');
    if (state === 'error') btn.classList.add('errored');
    if (state === 'error' && h.error) btn.title = h.error;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = h.label;
    btn.appendChild(label);
    if (state === 'done' && h.score) {
      const pct = document.createElement('span');
      pct.className = `pct ${chipClass(h.score.scorePct, currentMergedPct)}`;
      pct.textContent = `${h.score.scorePct}%`;
      btn.appendChild(pct);
    } else if (state === 'error') {
      const err = document.createElement('span');
      err.className = 'pct neg';
      err.textContent = '✗';
      btn.appendChild(err);
    } else {
      const dot = document.createElement('span');
      dot.className = 'pct chip-pending';
      dot.textContent = '…';
      btn.appendChild(dot);
    }
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `·${h.count}`;
    btn.appendChild(count);
    if (state === 'done') {
      btn.addEventListener('click', () => onHighlightClick(h));
    } else {
      btn.disabled = true;
    }
    highlightsList.appendChild(btn);
  }
}

function showHighlightsLoading(msg: string) {
  highlightsRow.hidden = false;
  while (highlightsList.firstChild) highlightsList.removeChild(highlightsList.firstChild);
  const span = document.createElement('span');
  span.className = 'chip-loading';
  span.textContent = msg;
  highlightsList.appendChild(span);
}

function setActiveChip(token?: string) {
  highlightsList.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.token === token);
  });
}

function starString(stars: number) {
  return '★'.repeat(stars) + '☆'.repeat(Math.max(0, 5 - stars));
}

function setPanelTitle(label: string, scorePct: number, trusted: number, total: number) {
  while (chipPanelTitle.firstChild) chipPanelTitle.removeChild(chipPanelTitle.firstChild);
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  chipPanelTitle.append(labelSpan, document.createTextNode(' · '));
  const pctSpan = document.createElement('span');
  pctSpan.className = `pct ${chipClass(scorePct, currentMergedPct)}`;
  pctSpan.textContent = `${scorePct}%`;
  chipPanelTitle.append(pctSpan, document.createTextNode(` · ${trusted} trusted of ${total}`));
}

function showChipPanel(h: Highlight) {
  activeHighlight = h;
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
  activeHighlight = null;
  activeSearch = null;
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
  const reviews = activeHighlight?.reviews ?? activeSearch?.reviews;
  const filter = activeHighlight?.label ?? activeSearch?.query;
  if (!reviews || !filter) return;
  const reviewTexts = textReviewsFor(reviews);
  if (!reviewTexts.length) { setStatus('No review text available', true); return; }
  chipAskBtn.disabled = true;
  setStatus(`Asking about "${filter}"…`);
  while (chipBody.firstChild) chipBody.removeChild(chipBody.firstChild);
  const loading = document.createElement('div');
  loading.className = 'chip-loading';
  loading.textContent = 'asking…';
  chipBody.appendChild(loading);
  try {
    const data = await postJson<{ answer?: string }>('/api/ask', {
      featureId: currentFeatureId, question: q, filter, reviewTexts,
    });
    while (chipBody.firstChild) chipBody.removeChild(chipBody.firstChild);
    const answer = document.createElement('div');
    answer.className = 'answer';
    renderMarkdown(answer, data.answer ?? '');
    chipBody.appendChild(answer);
    chipQuestionInput.value = '';
    setStatus('');
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    chipAskBtn.disabled = false;
  }
}

function showSearchPanel(r: SearchResult) {
  activeHighlight = null;
  activeSearch = r;
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

function renderReviewList(reviews: Review[]) {
  while (chipBody.firstChild) chipBody.removeChild(chipBody.firstChild);
  const sorted = reviews.slice().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  for (const r of sorted) {
    if (!r.text || r.text.length < 10) continue;
    const card = document.createElement('div');
    card.className = 'review-card';
    const meta = document.createElement('div');
    meta.className = 'review-meta';
    const stars = document.createElement('span');
    stars.className = 'review-stars';
    stars.textContent = starString(r.stars);
    const trust = document.createElement('span');
    const isTrustedRev = r.reviewerReviewCount >= 3;
    trust.className = isTrustedRev ? 'review-trusted' : 'review-untrusted';
    trust.textContent = `${r.reviewerReviewCount} rev${isTrustedRev ? '' : ' · untrusted'}`;
    meta.append(stars, trust);
    const text = document.createElement('p');
    text.className = 'review-text';
    text.textContent = r.text;
    card.append(meta, text);
    chipBody.appendChild(card);
  }
}

function renderChipSummary(summary: Summary) {
  while (chipBody.firstChild) chipBody.removeChild(chipBody.firstChild);
  const verdict = document.createElement('div');
  verdict.className = 'verdict';
  renderMarkdown(verdict, summary.verdict);
  chipBody.appendChild(verdict);
  if (summary.highlights?.length) {
    const ul = document.createElement('ul');
    ul.className = 'highlights';
    for (const h of summary.highlights) {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.className = `h-text ${h.sentiment === 'positive' ? 'pos' : h.sentiment === 'negative' ? 'neg' : 'neutral'}`;
      renderMarkdownInline(text, h.text);
      const count = document.createElement('span');
      count.className = 'h-count';
      count.textContent = `×${h.count}`;
      li.append(text, count);
      ul.appendChild(li);
    }
    chipBody.appendChild(ul);
  }
}

async function onHighlightClick(h: Highlight) {
  if (!currentFeatureId) return;
  if (activeHighlight?.token === h.token) {
    closeChipPanel();
    return;
  }
  showChipPanel(h);
  if (h.reviews) return;
  while (chipBody.firstChild) chipBody.removeChild(chipBody.firstChild);
  const loading = document.createElement('div');
  loading.className = 'chip-loading';
  loading.textContent = 'loading reviews…';
  chipBody.appendChild(loading);
  await ensureHighlightReviews();
  if (activeHighlight !== h) return;
  setPanelTitle(h.label.toUpperCase(), h.score?.scorePct ?? 0, h.score?.trustedReviews ?? 0, h.reviews?.length ?? h.count);
  renderReviewList(h.reviews ?? []);
}

async function summarizeActiveChip() {
  const h = activeHighlight;
  if (!h || !currentFeatureId) return;
  chipSummarizeBtn.disabled = true;
  chipSummarizeBtn.textContent = 'SUMMARIZING…';
  setStatus(`Summarizing "${h.label}"…`);
  const t0 = Date.now();
  try {
    const data = await postJson<{ summary?: Summary; cached?: boolean }>('/api/highlight-summary', {
      featureId: currentFeatureId, token: h.token,
    });
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
  const r = activeSearch;
  if (!r || !currentFeatureId) return;
  chipSummarizeBtn.disabled = true;
  chipSummarizeBtn.textContent = 'SUMMARIZING…';
  setStatus(`Summarizing "${r.query}"…`);
  const t0 = Date.now();
  try {
    const resp = await postNdjson('/api/search', {
      featureId: currentFeatureId, query: r.query, summarize: true,
    });
    let result: SearchResult | null = null;
    let cached = false;
    for await (const evt of readNdjson<SearchStreamEvent>(resp.body!)) {
      if (evt.type === 'search') {
        result = evt.result;
        cached = evt.cached;
      } else if (evt.type === 'search-summary') {
        if (result) {
          result.summary = evt.summary;
          activeSearch = result;
        }
        renderChipSummary(evt.summary);
      } else if (evt.type === 'error') {
        throw new Error(evt.error);
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
    const resp = await postNdjson('/api/search', {
      featureId: currentFeatureId, query, force,
    });
    for await (const evt of readNdjson<SearchStreamEvent>(resp.body!)) {
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
      } else if (evt.type === 'error') {
        throw new Error(evt.error);
      }
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    searchBtn.disabled = false;
  }
}

async function loadHighlights(force = false) {
  if (!currentFeatureId) return;
  showHighlightsLoading(force ? 'refreshing…' : 'loading highlights…');
  highlightsRefreshBtn.hidden = true;
  try {
    const resp = await fetchWithRetry('/api/highlights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: currentFeatureId, force }),
    });
    const ct = resp.headers.get('content-type') ?? '';
    if (resp.ok && ct.includes('ndjson') && resp.body) {
      await consumeHighlightStream(resp.body);
      highlightsRefreshBtn.hidden = false;
      return;
    }
    if (!ct.includes('json')) throw new Error(`server returned ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`);
    const data = await resp.json() as HighlightsResponse;
    if (!resp.ok) throw new Error(data.error || `request failed (${resp.status})`);
    if (data.highlights?.length) showHighlights(data.highlights);
    else highlightsRow.hidden = true;
  } catch (e) {
    showHighlightsLoading(`couldn't load highlights — ${e instanceof Error ? e.message : String(e)}`);
  }
}

function showHighlights(highlights: Highlight[]) {
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
        body: JSON.stringify({ featureId: currentFeatureId }),
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
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chipMap = new Map<string, Highlight>();
  let buffer = '';
  let lastFailures = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const evt = JSON.parse(line) as HighlightStreamEvent;
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
      }
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
  baseSummary = undefined;
  activeHighlight = null;
  activeSearch = null;
  answerEl.textContent = '';
  questionInput.value = '';
  $('valueForMoney').textContent = '—';
  $('verdict').textContent = '';
  resummarizeBtn.hidden = true;
  highlightsRow.hidden = true;
  chipPanel.hidden = true;
  verdictRow.style.display = '';
  highlightsListEl.style.display = '';
  searchForm.hidden = false;
  searchInput.value = '';
  searchRefreshBtn.hidden = true;
  while (highlightsList.firstChild) highlightsList.removeChild(highlightsList.firstChild);
  while (highlightsListEl.firstChild) highlightsListEl.removeChild(highlightsListEl.firstChild);
  while (chipBody.firstChild) chipBody.removeChild(chipBody.firstChild);
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

function renderScore(data: LookupResponse) {
  initResultPanel(data.score.featureId, data.resolvedUrl);
  baseSummary = data.summary;
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
    for await (const evt of readNdjson<LookupStreamEvent>(body)) {
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
          if (activeHighlight) setActiveChip(activeHighlight.token);
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
      hour: parseInt(parts.hour, 10) + parseInt(parts.minute, 10) / 60,
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
  hoursTodayEl.textContent = hoursLabel ? `${today.day.slice(0, 3)} · ${hoursLabel}` : '';
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
    while (googleEl.firstChild) googleEl.removeChild(googleEl.firstChild);
    const star = document.createElement('span');
    star.className = 'star';
    star.textContent = '★';
    const num = document.createElement('span');
    num.textContent = meta.googleRating.toFixed(1);
    googleEl.append(star, num);
    if (meta.googleReviewCount != null) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = ` · ${meta.googleReviewCount.toLocaleString()} on Google`;
      googleEl.appendChild(count);
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
  while (highlightsListEl.firstChild) highlightsListEl.removeChild(highlightsListEl.firstChild);
  for (const h of summary.highlights) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = `h-text ${h.sentiment === 'positive' ? 'pos' : h.sentiment === 'negative' ? 'neg' : 'neutral'}`;
    const title = document.createElement('span');
    title.className = 'h-title';
    renderMarkdownInline(title, h.text);
    text.appendChild(title);
    if (h.description) {
      const desc = document.createElement('span');
      desc.className = 'h-desc';
      renderMarkdownInline(desc, h.description);
      text.append(' ', desc);
    }
    const count = document.createElement('span');
    count.className = 'h-count';
    count.textContent = `×${h.count}`;
    li.append(text, count);
    highlightsListEl.appendChild(li);
  }
}

function renderSummaryError(msg: string) {
  $('verdict').textContent = `summary failed: ${msg}`;
}

async function fetchHistogramFor(featureId: string, mergedPct: number) {
  try {
    const data = await postJson<HistogramResponse>('/api/histogram', { featureId });
    if (data.overallPct != null) renderOverall(data.overallPct, mergedPct);
    if (data.histogram) renderOverallScore(data.histogram);
  } catch {}
}

async function fetchSummaryFor(featureId: string, force = false): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  try {
    const data = await postJson<SummarizeResponse>('/api/summarize', { featureId, force });
    if (data.error) {
      renderSummaryError(data.error);
      return { ok: false, ms: Date.now() - t0 };
    }
    if (data.summary) {
      baseSummary = data.summary;
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
    const resp = await postNdjson('/api/lookup', { url });
    await consumeLookupStream(resp.body!, t0);
  } catch (e) {
    delete document.body.dataset.state;
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = 'SCORE';
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
    if (activeHighlight) renderReviewList(activeHighlight.reviews ?? []);
    else if (activeSearch) renderReviewList(activeSearch.reviews);
    chipSummarizeBtn.textContent = 'SUMMARIZE';
    return;
  }
  if (activeHighlight) summarizeActiveChip();
  else if (activeSearch) summarizeActiveSearch();
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
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'place-tile';
    const name = document.createElement('span');
    name.className = 'place-name';
    name.textContent = p.name;
    const score = document.createElement('span');
    score.className = `place-score ${scoreClass(p.scorePct)}`;
    score.textContent = `${p.scorePct}`;
    const age = document.createElement('span');
    age.className = 'place-age';
    age.textContent = timeAgo(p.lastAccessTs);
    tile.append(name, score, age);
    tile.addEventListener('click', () => {
      urlInput.value = p.resolvedUrl;
      form.requestSubmit();
    });
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
    });
    renderMarkdown(answerEl, data.answer ?? '');
    setStatus('');
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    askBtn.disabled = false;
  }
});

const sharedUrl = new URLSearchParams(location.search).get('url');
if (sharedUrl) {
  urlInput.value = sharedUrl;
  form.requestSubmit();
} else {
  loadPlaces();
}
