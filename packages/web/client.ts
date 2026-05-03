type SummaryHighlight = { text: string; count: number; sentiment: string };
type Review = { reviewId: string; stars: number; reviewerReviewCount: number; timestamp: number | null; text: string };
type SortStats = { totalReviews: number; trustedReviews: number; scorePct: number };
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
  histogram?: number[];
  overallPct?: number | null;
  cached?: boolean;
  fetchMs?: number;
  error?: string;
};
type SummarizeResponse = { summary?: Summary; error?: string; cached?: boolean };
type HistogramResponse = { histogram?: number[]; overallPct?: number; error?: string };
type HighlightStats = { totalReviews: number; trustedReviews: number; scorePct: number };
type Highlight = { label: string; count: number; token: string; score?: HighlightStats; reviews?: Review[] };
type HighlightsResponse = { highlights?: Highlight[]; cached?: boolean; error?: string };
type SearchResult = {
  query: string;
  totalReviews: number;
  trustedReviews: number;
  scorePct: number;
  reviews: Review[];
  summary?: Summary;
};
type SearchResponse = { result?: SearchResult; cached?: boolean; error?: string };

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
const verdictRow = document.querySelector('.verdict-row') as HTMLElement;
const highlightsListEl = $('highlights') as HTMLElement;

let currentFeatureId = '';
let currentMergedPct = 0;
let baseSummary: Summary | undefined;
let activeHighlight: Highlight | null = null;
let activeSearch: SearchResult | null = null;

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

function renderHighlights(highlights: Highlight[], activeToken?: string) {
  while (highlightsList.firstChild) highlightsList.removeChild(highlightsList.firstChild);
  const weight = (h: Highlight) => {
    const r = (h.score?.scorePct ?? 0) / 100;
    return r * Math.abs(r) * h.count;
  };
  const isAbove = (h: Highlight) => (h.score?.scorePct ?? 0) >= currentMergedPct;
  const sorted = [...highlights].sort((a, b) => {
    const above = Number(isAbove(b)) - Number(isAbove(a));
    if (above !== 0) return above;
    return weight(b) - weight(a);
  });
  for (const h of sorted) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.token = h.token;
    if (activeToken === h.token) btn.classList.add('active');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = h.label;
    btn.appendChild(label);
    if (h.score) {
      const pct = document.createElement('span');
      pct.className = `pct ${chipClass(h.score.scorePct, currentMergedPct)}`;
      pct.textContent = `${h.score.scorePct}%`;
      btn.appendChild(pct);
    }
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `·${h.count}`;
    btn.appendChild(count);
    btn.addEventListener('click', () => onHighlightClick(h));
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

function renderChipReviews(h: Highlight) {
  while (chipBody.firstChild) chipBody.removeChild(chipBody.firstChild);
  const reviews = (h.reviews ?? []).slice().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  for (const r of reviews) {
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
  renderChipReviews(h);
  chipPanel.hidden = false;
  verdictRow.style.display = 'none';
  highlightsListEl.style.display = 'none';
  resummarizeBtn.style.display = 'none';
  chipSummarizeBtn.disabled = false;
  chipSummarizeBtn.textContent = 'SUMMARIZE';
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
  setStatus('');
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
  verdict.textContent = summary.verdict;
  chipBody.appendChild(verdict);
  if (summary.highlights?.length) {
    const ul = document.createElement('ul');
    ul.className = 'highlights';
    for (const h of summary.highlights) {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.className = `h-text ${h.sentiment === 'positive' ? 'pos' : h.sentiment === 'negative' ? 'neg' : 'neutral'}`;
      text.textContent = h.text;
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
}

async function summarizeActiveChip() {
  const h = activeHighlight;
  if (!h || !currentFeatureId) return;
  chipSummarizeBtn.disabled = true;
  chipSummarizeBtn.textContent = 'SUMMARIZING…';
  setStatus(`Summarizing "${h.label}"…`);
  const t0 = Date.now();
  try {
    const resp = await fetch('/api/highlight-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: currentFeatureId, token: h.token }),
    });
    const data = await resp.json() as { summary?: Summary; error?: string; cached?: boolean };
    if (data.error) throw new Error(data.error);
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
    const resp = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: currentFeatureId, query: r.query, summarize: true }),
    });
    const data: SearchResponse = await resp.json();
    if (data.error) throw new Error(data.error);
    if (data.result?.summary) {
      activeSearch = data.result;
      renderChipSummary(data.result.summary);
      chipSummarizeBtn.disabled = false;
      chipSummarizeBtn.textContent = 'SHOW REVIEWS';
      setStatus(`"${r.query}" summarized${data.cached ? ' (cached)' : ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`}`);
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
    const resp = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: currentFeatureId, query, force }),
    });
    const data: SearchResponse = await resp.json();
    if (data.error) throw new Error(data.error);
    if (data.result) {
      showSearchPanel(data.result);
      setStatus(
        data.cached
          ? `"${query}" cached · ${data.result.totalReviews} reviews · ${data.result.scorePct}%`
          : `"${query}" · ${data.result.totalReviews} reviews · ${data.result.scorePct}% in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
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
    const resp = await fetch('/api/highlights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: currentFeatureId, force }),
    });
    const data: HighlightsResponse = await resp.json();
    if (data.error) throw new Error(data.error);
    if (data.highlights && data.highlights.length) {
      renderHighlights(data.highlights);
      highlightsRefreshBtn.hidden = false;
    } else {
      highlightsRow.hidden = true;
    }
  } catch (e) {
    showHighlightsLoading(`failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function renderScore(data: LookupResponse) {
  result.hidden = false;
  document.body.dataset.state = 'scored';
  $('name').textContent = data.name || '(unnamed place)';
  const pctEl = $('scorePct');
  pctEl.textContent = `${data.score.scorePct}`;
  pctEl.className = `score-num ${scoreClass(data.score.scorePct)}`;
  $('reviewsLabel').textContent = `${data.score.totalReviews} · ${data.score.trustedReviews}`;
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
  renderOverall(data.overallPct ?? null, data.score.scorePct);
  currentFeatureId = data.score.featureId;
  currentMergedPct = data.score.scorePct;
  baseSummary = data.summary;
  activeHighlight = null;
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
  activeSearch = null;
  while (highlightsList.firstChild) highlightsList.removeChild(highlightsList.firstChild);
  while (highlightsListEl.firstChild) highlightsListEl.removeChild(highlightsListEl.firstChild);
  while (chipBody.firstChild) chipBody.removeChild(chipBody.firstChild);
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

function renderSummary(summary: Summary) {
  $('valueForMoney').textContent = `${summary.valueForMoney}/5`;
  $('verdict').textContent = summary.verdict;
  resummarizeBtn.hidden = false;
  while (highlightsListEl.firstChild) highlightsListEl.removeChild(highlightsListEl.firstChild);
  for (const h of summary.highlights) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = `h-text ${h.sentiment === 'positive' ? 'pos' : h.sentiment === 'negative' ? 'neg' : 'neutral'}`;
    text.textContent = h.text;
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
    const resp = await fetch('/api/histogram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId }),
    });
    const data: HistogramResponse = await resp.json();
    if (data.overallPct != null) renderOverall(data.overallPct, mergedPct);
  } catch {}
}

async function fetchSummaryFor(featureId: string, force = false): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  try {
    const resp = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId, force }),
    });
    const data: SummarizeResponse = await resp.json();
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
  goBtn.disabled = true;
  setStatus('Fetching reviews…');
  const t0 = Date.now();
  try {
    const resp = await fetch('/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data: LookupResponse = await resp.json();
    if (data.error) throw new Error(data.error);
    renderScore(data);
    const scoreMs = Date.now() - t0;
    const featureId = data.score.featureId;
    const mergedPct = data.score.scorePct;

    const histogramTask = data.overallPct != null
      ? Promise.resolve()
      : fetchHistogramFor(featureId, mergedPct);
    const highlightsTask = loadHighlights();

    if (data.summary) {
      renderSummary(data.summary);
      setStatus(data.cached ? `Cached · ${scoreMs}ms` : `Done in ${(scoreMs / 1000).toFixed(1)}s`);
      await Promise.all([histogramTask, highlightsTask]);
      return;
    }

    setStatus(`Score in ${(scoreMs / 1000).toFixed(1)}s · summarizing…`);
    const [sum] = await Promise.all([fetchSummaryFor(featureId), histogramTask, highlightsTask]);
    setStatus(sum.ok ? `Done in ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'Summary failed', !sum.ok);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    goBtn.disabled = false;
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
    if (activeHighlight) renderChipReviews(activeHighlight);
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

document.getElementById('brand')?.addEventListener('click', () => {
  delete document.body.dataset.state;
  result.hidden = true;
  urlInput.value = '';
  setStatus('');
  urlInput.focus();
});

askForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = questionInput.value.trim();
  if (!q || !currentFeatureId) return;
  askBtn.disabled = true;
  answerEl.textContent = '';
  setStatus('Asking…');
  try {
    const resp = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: currentFeatureId, question: q }),
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    answerEl.textContent = data.answer;
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
}
