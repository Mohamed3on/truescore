import { getActiveLLM, geminiEndpoint, OPENAI_ENDPOINT, OPENAI_MODEL } from './config';
import { el, renderMarkdown, renderMarkdownInline } from './utils';

export const renderStructuredSummary = (
  container: HTMLElement,
  { complaints, praised, conclusion, betterAlternative, suspiciousPatterns }: any,
  opts: { skipSuspicious?: boolean } = {},
) => {
  container.textContent = '';
  if (conclusion) {
    const el = document.createElement('div');
    el.className = 'ars-conclusion';
    renderMarkdown(el, conclusion);
    container.appendChild(el);
  }
  const addSection = (title: string, items: string[], type: string) => {
    if (!items?.length) return;
    const section = document.createElement('div');
    section.className = `ars-section ars-section--${type}`;
    const heading = document.createElement('div');
    heading.className = 'ars-section-title';
    heading.textContent = `${type === 'praised' ? '\u25B3' : '\u25BD'} ${title}`;
    section.appendChild(heading);
    for (const item of items) {
      const bullet = document.createElement('div');
      bullet.className = 'ars-section-item';
      renderMarkdownInline(bullet, item);
      section.appendChild(bullet);
    }
    container.appendChild(section);
  };
  addSection('Universally praised', praised, 'praised');
  addSection('Common complaints', complaints, 'complaints');
  if (betterAlternative) {
    const section = document.createElement('div');
    section.className = 'ars-section ars-section--alt';
    const heading = document.createElement('div');
    heading.className = 'ars-section-title';
    heading.textContent = '\u21C4 Better alternative';
    section.appendChild(heading);
    const item = document.createElement('div');
    item.className = 'ars-section-item';
    renderMarkdownInline(item, betterAlternative);
    section.appendChild(item);
    container.appendChild(section);
  }
  if (suspiciousPatterns && !opts.skipSuspicious) {
    const section = document.createElement('div');
    section.className = 'ars-section ars-section--suspicious';
    const heading = document.createElement('div');
    heading.className = 'ars-section-title';
    heading.textContent = '\u26A0 Suspicious patterns';
    section.appendChild(heading);
    const item = document.createElement('div');
    item.className = 'ars-section-item';
    renderMarkdownInline(item, suspiciousPatterns);
    section.appendChild(item);
    container.appendChild(section);
  }
};

const SUMMARY_SCHEMA = {
  type: 'object' as const,
  properties: {
    complaints: { type: 'array' as const, items: { type: 'string' as const } },
    praised: { type: 'array' as const, items: { type: 'string' as const } },
    conclusion: { type: 'string' as const },
    betterAlternative: { type: 'string' as const, nullable: true },
    suspiciousPatterns: { type: 'string' as const, description: 'Warning about review manipulation if detected: repetitive phrasing, astroturfing, suspiciously similar wording, lack of unique detail, incentivized reviews, etc. Empty string if reviews appear genuine.', nullable: true }
  },
  required: ['complaints', 'praised', 'conclusion']
};

// OpenAI strict structured output wants every property required and
// additionalProperties: false at each level; Gemini-style `nullable` becomes a
// type union. The schemas stay authored in the Gemini-friendly shape above.
const toStrictSchema = (s: any): any => {
  if (s?.type === 'object') {
    return {
      ...s,
      properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toStrictSchema(v)])),
      required: Object.keys(s.properties),
      additionalProperties: false,
    };
  }
  if (s?.type === 'array') return { ...s, items: toStrictSchema(s.items) };
  if (s?.nullable) {
    const { nullable, ...rest } = s;
    return { ...rest, type: [rest.type, 'null'] };
  }
  return s;
};

// Provider comes from the popup toggle (getActiveLLM); same prompt either way.
export const llmSummarize = async (reviewTexts: string[], prompt: string, schema: any = SUMMARY_SCHEMA): Promise<any> => {
  const fullPrompt = prompt + '\n\nReviews:\n\n' + reviewTexts.join('\n---\n');

  const { provider, key, reasoningEffort } = await getActiveLLM();
  if (!key) throw new Error(`No ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API key \u2014 set one in the TrueScore popup`);

  if (provider === 'openai') {
    const res = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: fullPrompt }],
        reasoning_effort: reasoningEffort,
        max_completion_tokens: 32768,
        ...(schema && {
          response_format: { type: 'json_schema', json_schema: { name: 'summary', strict: true, schema: toStrictSchema(schema) } },
        }),
      }),
    });
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error(data?.error?.message || 'Empty OpenAI response');
    return schema ? JSON.parse(raw) : raw;
  }

  const generationConfig: any = {
    thinkingConfig: { thinkingLevel: 'MINIMAL' },
    maxOutputTokens: 32768,
  };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }

  const res = await fetch(geminiEndpoint(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig,
    }),
  });

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const raw = parts.filter((p: any) => !p.thought).pop()?.text;
  if (!raw) throw new Error(data.error?.message || 'Empty Gemini response');
  return schema ? JSON.parse(raw) : raw;
};

export const renderFreeFormAnswer = (container: HTMLElement, text: string) => {
  container.textContent = '';
  const div = document.createElement('div');
  div.className = 'ars-answer';
  renderMarkdown(div, text);
  container.appendChild(div);
};

const RL_KEY = 'ars-gemini-rate-limit';
const RL_MAX = 20;

const QUESTION_PROMPT = `Answer this question using ONLY evidence from the product reviews below. Quote or paraphrase the most concrete details. If reviewers disagree, surface the tension. Be direct and practical.`;

const checkRateLimit = () => {
  let rl = JSON.parse(localStorage.getItem(RL_KEY) || '{"count":0,"resetAt":0}');
  if (Date.now() > rl.resetAt) rl = { count: 0, resetAt: Date.now() + 86400000 };
  return rl;
};

const bumpRateLimit = () => {
  const rl = checkRateLimit();
  rl.count++;
  localStorage.setItem(RL_KEY, JSON.stringify(rl));
};

const QA_CACHE_LIMIT = 10;
const qaCacheKey = (cacheKey: string) => `${cacheKey}-qa`;

interface QAEntry { q: string; a: string; ts: number }

const loadQAs = (cacheKey: string): QAEntry[] => {
  try {
    const raw = localStorage.getItem(qaCacheKey(cacheKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

const saveQA = (cacheKey: string, entry: QAEntry) => {
  const existing = loadQAs(cacheKey).filter((e) => e.q !== entry.q);
  const next = [entry, ...existing].slice(0, QA_CACHE_LIMIT);
  try { localStorage.setItem(qaCacheKey(cacheKey), JSON.stringify(next)); } catch {}
};

const removeQA = (cacheKey: string, q: string) => {
  const existing = loadQAs(cacheKey).filter((e) => e.q !== q);
  try { localStorage.setItem(qaCacheKey(cacheKey), JSON.stringify(existing)); } catch {}
};

interface AlternateEntry { key: string; meta: any; ts: number }

interface AlternatesConfig {
  prefix: string;
  decode: (entry: AlternateEntry) => { label: string; onSelect: () => void } | null;
}

interface SummarizeWidgetOpts {
  wrapper: HTMLElement;
  cacheKey: string;
  summaryPrompt: string;
  fetchReviews: () => Promise<string[]>;
  questionPlaceholder?: string;
  questionPrompt?: string;
  context?: string;
  cacheMeta?: any;
  alternates?: AlternatesConfig;
  skipSuspicious?: boolean;
  autoSummarize?: boolean;
}

const collectAlternates = (prefix: string, currentKey: string): AlternateEntry[] => {
  const items: AlternateEntry[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key === currentKey || !key.startsWith(prefix)) continue;
    try {
      const v = JSON.parse(localStorage.getItem(key) || '');
      if (v?.parsed) items.push({ key, ts: v.ts || 0, meta: v.meta ?? null });
    } catch {}
  }
  return items.sort((a, b) => b.ts - a.ts);
};

const renderAlternatesRow = (config: AlternatesConfig, currentKey: string): HTMLElement | null => {
  const decoded = collectAlternates(config.prefix, currentKey)
    .map((entry) => config.decode(entry))
    .filter((d): d is { label: string; onSelect: () => void } => d !== null);
  if (!decoded.length) return null;
  const row = el('div', 'ars-alternates');
  row.appendChild(el('span', 'ars-alternates-label', 'Also cached'));
  for (const item of decoded) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ars-alternate';
    chip.textContent = item.label;
    chip.addEventListener('click', item.onSelect);
    row.appendChild(chip);
  }
  return row;
};

export const buildSummarizeWidget = ({
  wrapper,
  cacheKey,
  summaryPrompt,
  fetchReviews,
  questionPlaceholder = 'Ask about this product\u2026',
  questionPrompt = QUESTION_PROMPT,
  context,
  cacheMeta,
  alternates,
  skipSuspicious,
  autoSummarize,
}: SummarizeWidgetOpts) => {
  const renderOpts = { skipSuspicious };
  // Reference material (e.g. a course's volume/chapter breakdown) appended to
  // both the structured-summary prompt and every Ask, so questions can map vague
  // reviewer mentions to specific named sections too — not just the summary.
  const withContext = (prompt: string) => (context ? `${prompt}\n\n${context}` : prompt);

  const questionRow = document.createElement('div');
  questionRow.className = 'ars-question-row';
  const questionInput = document.createElement('input');
  questionInput.type = 'text';
  questionInput.placeholder = questionPlaceholder;
  questionInput.className = 'ars-question-input';
  questionRow.appendChild(questionInput);
  wrapper.appendChild(questionRow);

  const summarizeBtn = document.createElement('button');
  summarizeBtn.className = 'ars-summarize-btn';

  // "Summarized on …" + Re-summarize. Shown only while the panel holds the
  // structured summary — never beside a Q&A answer, where "Re-summarize" would
  // be the wrong label and the wrong action.
  const dateRow = el('div', 'ars-summary-meta');
  dateRow.style.display = 'none';
  const dateLabel = el('div', 'ars-summary-date');
  const reBtn = document.createElement('button');
  reBtn.className = 'ars-resummarize-btn';
  reBtn.textContent = '\u21BB Re-summarize';
  reBtn.addEventListener('click', () => runSummary(reBtn));
  dateRow.append(dateLabel, reBtn);

  const summaryPanel = document.createElement('div');
  summaryPanel.className = 'ars-summary-panel';
  summaryPanel.style.display = 'none';

  // What summaryPanel currently shows, so the controls stay honest: the date row
  // belongs to a summary, the Ask button to a question.
  let panelMode: 'none' | 'summary' | 'answer' = 'none';
  let summaryTs = 0;

  const syncControls = () => {
    const asking = !!questionInput.value.trim();
    summarizeBtn.textContent = asking ? 'Ask' : '\u2726 Summarize Reviews';
    // Hide the redundant Summarize button only once the summary is on screen.
    summarizeBtn.style.display = !asking && panelMode === 'summary' ? 'none' : '';
    const showDate = !asking && panelMode === 'summary';
    dateRow.style.display = showDate ? '' : 'none';
    if (showDate) {
      dateLabel.textContent = `Summarized on ${new Date(summaryTs).toLocaleDateString()}`;
      reBtn.style.display = checkRateLimit().count < RL_MAX ? '' : 'none';
    }
  };

  const loadReviews = async () => {
    const reviews = [...await fetchReviews()];
    if (!reviews.length) throw new Error('No reviews found');
    reviews.sort((a, b) => b.length - a.length);
    return reviews;
  };

  const runSummary = async (btn: HTMLButtonElement) => {
    btn.disabled = true;
    btn.textContent = '\u23F3 Fetching reviews\u2026';
    try {
      const reviews = await loadReviews();
      btn.textContent = '\u23F3 Summarizing\u2026';
      const parsed = await llmSummarize(reviews, withContext(summaryPrompt));
      bumpRateLimit();
      summaryTs = Date.now();
      localStorage.setItem(cacheKey, JSON.stringify({ parsed, ts: summaryTs, meta: cacheMeta }));
      renderStructuredSummary(summaryPanel, parsed, renderOpts);
      summaryPanel.style.display = 'block';
      panelMode = 'summary';
    } catch (e: any) {
      summaryPanel.textContent = `Error: ${e.message}`;
      summaryPanel.style.display = 'block';
    } finally {
      btn.disabled = false;
      syncControls();
    }
  };

  const runAsk = async (btn: HTMLButtonElement, question: string) => {
    const hit = loadQAs(cacheKey).find((e) => e.q.toLowerCase() === question.toLowerCase());
    if (hit) {
      renderFreeFormAnswer(summaryPanel, hit.a);
      summaryPanel.style.display = 'block';
      panelMode = 'answer';
      syncControls();
      return;
    }
    btn.disabled = true;
    btn.textContent = '\u23F3 Fetching reviews\u2026';
    try {
      const reviews = await loadReviews();
      btn.textContent = '\u23F3 Asking\u2026';
      const answer = await llmSummarize(reviews, `${withContext(questionPrompt)}\n\nQuestion: ${question}`, null);
      bumpRateLimit();
      saveQA(cacheKey, { q: question, a: answer, ts: Date.now() });
      renderFreeFormAnswer(summaryPanel, answer);
      summaryPanel.style.display = 'block';
      panelMode = 'answer';
      renderQAHistory();
    } catch (e: any) {
      summaryPanel.textContent = `Error: ${e.message}`;
      summaryPanel.style.display = 'block';
    } finally {
      btn.disabled = false;
      syncControls();
    }
  };

  const qaHistoryRow = el('div', 'ars-alternates ars-qa-history');
  qaHistoryRow.style.display = 'none';

  const renderQAHistory = () => {
    qaHistoryRow.textContent = '';
    const items = loadQAs(cacheKey);
    if (!items.length) { qaHistoryRow.style.display = 'none'; return; }
    qaHistoryRow.style.display = '';
    qaHistoryRow.appendChild(el('span', 'ars-alternates-label', 'Recent questions'));
    for (const item of items) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ars-alternate ars-qa-chip';
      chip.title = item.q;
      const text = el('span', 'ars-qa-chip-text', item.q);
      const remove = el('span', 'ars-qa-chip-remove', '×');
      remove.title = 'Remove';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        removeQA(cacheKey, item.q);
        renderQAHistory();
      });
      chip.appendChild(text);
      chip.appendChild(remove);
      chip.addEventListener('click', () => {
        questionInput.value = item.q;
        renderFreeFormAnswer(summaryPanel, item.a);
        summaryPanel.style.display = 'block';
        panelMode = 'answer';
        syncControls();
      });
      qaHistoryRow.appendChild(chip);
    }
  };

  questionInput.addEventListener('input', syncControls);
  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') summarizeBtn.click();
  });
  summarizeBtn.addEventListener('click', () => {
    const question = questionInput.value.trim();
    if (question) runAsk(summarizeBtn, question);
    else runSummary(summarizeBtn);
  });
  questionRow.appendChild(summarizeBtn);

  // Restore cached summary
  const rawCache = localStorage.getItem(cacheKey);
  let cached: any = null;
  if (rawCache) {
    try { cached = JSON.parse(rawCache); } catch (_) {}
  }
  if (cached?.parsed) {
    summaryTs = cached.ts;
    renderStructuredSummary(summaryPanel, cached.parsed, renderOpts);
    summaryPanel.style.display = 'block';
    panelMode = 'summary';
  }

  wrapper.appendChild(dateRow);
  wrapper.appendChild(summaryPanel);
  wrapper.appendChild(qaHistoryRow);
  renderQAHistory();
  syncControls();

  if (alternates) {
    const altRow = renderAlternatesRow(alternates, cacheKey);
    if (altRow) wrapper.appendChild(altRow);
  }

  // Auto-summarize on landing — skip silently if a summary is already cached
  // or the active provider has no key (the manual button stays available either way).
  if (autoSummarize && !cached?.parsed) {
    getActiveLLM().then(({ key }) => {
      if (key && !questionInput.value.trim()) summarizeBtn.click();
    });
  }
};
