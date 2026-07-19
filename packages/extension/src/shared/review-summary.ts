import { getActiveLLM, geminiEndpoint, OPENAI_ENDPOINT, OPENAI_MODEL, DEEPSEEK_ENDPOINT, DEEPSEEK_MODEL } from './config';
import { el, renderMarkdown, renderMarkdownInline } from './utils';
import { cacheGet, cacheSet } from './cache';

// Shared default summary prompt for retail product pages (Amazon, Decathlon, dm…).
// Domain-specific pages (hotels, films, BJJ courses) keep their own prompts.
export const PRODUCT_SUMMARY_PROMPT = `Analyze these product reviews. Ignore shipping, delivery, packaging, or seller issues — focus ONLY on the product itself. Skip generic praise like "great product".

Cover the recurring themes mentioned by 3+ reviewers, ranked by how often they come up. Each bullet is one concrete, specific point with enough detail to be useful — e.g. "Adhesive lifts at the edges after a few hours", not just "doesn't stick". When reviewers disagree on a point, say so. Give the 4–6 strongest points for praised and for complaints; don't pad with weak or one-off mentions.

betterAlternative: only if 2+ reviewers name a specific competing product, give its name and how they say it compares — nothing else. If no competing product is named, return an empty string for this field. Never write a sentence explaining that there's no alternative; absence must be silent.

conclusion: 2–4 sentences — the overall verdict: what owners consistently say, who it suits best or the main thing to watch out for, and whether it's good value when reviewers mention price. Don't just restate the bullets, and don't mention what reviewers didn't say.`;

// Free-form prompt for summarizing a searched subset of product reviews
// (the review-search section's "Summarize <query>" pass).
export const FILTERED_PRODUCT_SUMMARY_PROMPT = `Summarize what these product reviews say about the searched topic. Lead with the bottom line. Ignore shipping, delivery, packaging, or seller issues — focus only on the product itself. Be punchy and decisive, no hedging. A few short paragraphs or bullets are fine.`;

// The model is told to leave betterAlternative empty when no competitor is named,
// but it sometimes ignores that and writes a sentence explaining the absence instead
// ("no distinct competitor is named", "cannot be reliably inferred"). Those aren't
// alternatives — drop them so the section only ever shows a real recommendation.
const isNonAlternative = (text: string): boolean => {
  const t = text.toLowerCase();
  return /\bno\s+(\w+\s+){0,3}(alternative|competitor|competing|other (product|brand))/.test(t)
    || /\b(none|not)\s+(\w+\s+){0,3}(named|mentioned|inferred|identified|specified|found)/.test(t)
    || /\bcan(?:not|['’]?t)\s+(\w+\s+){0,4}(inferred|determined|identified)/.test(t)
    || /does\s?(?:n['’]?t|\snot)\s+appear/.test(t);
};

export const renderStructuredSummary = (
  container: HTMLElement,
  { complaints, praised, conclusion, betterAlternative }: any,
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
  if (betterAlternative && !isNonAlternative(betterAlternative)) {
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
};

const SUMMARY_SCHEMA = {
  type: 'object' as const,
  properties: {
    complaints: { type: 'array' as const, items: { type: 'string' as const } },
    praised: { type: 'array' as const, items: { type: 'string' as const } },
    conclusion: { type: 'string' as const },
    betterAlternative: { type: 'string' as const, nullable: true }
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

const PROVIDER_LABEL: Record<string, string> = { gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' };

// Provider comes from the popup toggle (getActiveLLM); same prompt either way.
export const llmSummarize = async (reviewTexts: string[], prompt: string, schema: any = SUMMARY_SCHEMA): Promise<any> => {
  // Reviews arrive in the page's locale (amazon.es, booking.de, …), so without
  // this the model answers in that language. Pin output to English for every site.
  const fullPrompt = prompt + '\n\nAlways respond in English, even if the reviews are written in another language.\n\nReviews:\n\n' + reviewTexts.join('\n---\n');

  const { provider, key, reasoningEffort } = await getActiveLLM();
  if (!key) throw new Error(`No ${PROVIDER_LABEL[provider]} API key \u2014 set one in the TrueScore popup`);

  // OpenAI and DeepSeek both speak the OpenAI Chat Completions API; they differ
  // only in endpoint/model and how thinking + structured output are requested.
  // nano takes a strict json_schema and the popup's reasoning effort; DeepSeek
  // has no native schema mode, so we ask for json_object and pin the shape into
  // the prompt, and keep it non-thinking (its thinking ladder was slower for no
  // quality gain \u2014 see web evals/latency.ts).
  if (provider === 'openai' || provider === 'deepseek') {
    const isDeepseek = provider === 'deepseek';
    const content = isDeepseek && schema ? `${fullPrompt}\n\nReturn ONLY a JSON object matching this schema (no markdown, no extra keys):\n${JSON.stringify(schema)}` : fullPrompt;
    const res = await fetch(isDeepseek ? DEEPSEEK_ENDPOINT : OPENAI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: isDeepseek ? DEEPSEEK_MODEL : OPENAI_MODEL,
        messages: [{ role: 'user', content }],
        ...(isDeepseek
          ? { thinking: { type: 'disabled' }, max_tokens: 8192, ...(schema && { response_format: { type: 'json_object' } }) }
          : {
              reasoning_effort: reasoningEffort,
              max_completion_tokens: 32768,
              ...(schema && { response_format: { type: 'json_schema', json_schema: { name: 'summary', strict: true, schema: toStrictSchema(schema) } } }),
            }),
      }),
    });
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error(data?.error?.message || `Empty ${PROVIDER_LABEL[provider]} response`);
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
  autoSummarize,
}: SummarizeWidgetOpts) => {
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
      // Quota-full must not discard a summary the LLM call already paid for.
      try { localStorage.setItem(cacheKey, JSON.stringify({ parsed, ts: summaryTs, meta: cacheMeta })); } catch {}
      renderStructuredSummary(summaryPanel, parsed);
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
    renderStructuredSummary(summaryPanel, cached.parsed);
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

interface MediaSummaryOpts {
  anchor: Element;
  classPrefix: string;
  heading: string;
  summaryPrompt: string;
  schema: any;
  sections: [string, string][];
  summaryCacheKey: string | null;
  summaryTtl: number;
  fetchReviews: () => Promise<string[]>;
  initialButtonLabel: string;
  ask?: { placeholder: string; questionPrompt: string; qaCacheKey: string | null };
}

// Shared summary + Q&A panel for media-review sites (Goodreads books, Letterboxd
// films): a labeled structured summary over a caller-supplied schema/sections,
// instant synchronous restore of the cached summary on mount, and an optional
// free-form Ask with cached recent-question chips. Styled entirely by the host
// via `classPrefix` (each site ships its own CSS using the same suffixes). This
// is the editorial counterpart to buildSummarizeWidget (the retail praised/
// complaints product widget with hardcoded ars-* styling); both share the
// llmSummarize / rate-limit / Q&A primitives above.
export const buildMediaSummary = ({
  anchor,
  classPrefix: p,
  heading,
  summaryPrompt,
  schema,
  sections,
  summaryCacheKey,
  summaryTtl,
  fetchReviews,
  initialButtonLabel,
  ask,
}: MediaSummaryOpts): HTMLElement => {
  const section = el('section', p);
  const head = el('div', `${p}-head`);
  head.append(el('h3', `${p}-header`, heading));
  const relink = el('span', `${p}-relink`, '↻ Re-summarize');
  relink.style.display = 'none';
  relink.addEventListener('click', () => runSummary());
  head.append(relink);

  const askRow = el('div', `${p}-ask`);
  let input: HTMLInputElement | null = null;
  if (ask) {
    input = document.createElement('input');
    input.type = 'text';
    input.className = `${p}-input`;
    input.placeholder = ask.placeholder;
    askRow.append(input);
  }
  const btn = el('button', `${p}-btn`) as HTMLButtonElement;
  askRow.append(btn);

  const body = el('div', `${p}-body`);
  body.style.display = 'none';
  const qaRow = ask ? el('div', `${p}-qa`) : null;
  if (qaRow) qaRow.style.display = 'none';

  section.append(head, askRow, body);
  if (qaRow) section.append(qaRow);
  anchor.parentNode!.insertBefore(section, anchor.nextSibling);

  let showingSummary = false;

  const renderMediaSummary = (data: any) => {
    body.textContent = '';
    for (const [label, field] of sections) {
      const value = data?.[field];
      if (!value || !String(value).trim()) continue;
      const sec = el('div', `${p}-sec`);
      sec.append(el('div', `${p}-label`, label));
      const text = el('div', `${p}-text`);
      renderMarkdownInline(text, String(value));
      sec.append(text);
      body.append(sec);
    }
    body.style.display = 'block';
  };

  const renderAnswer = (text: string) => {
    body.textContent = '';
    const div = el('div', `${p}-text`);
    renderMarkdown(div, text);
    body.append(div);
    body.style.display = 'block';
  };

  const note = (cls: string, msg: string) => {
    body.textContent = '';
    body.append(el('div', cls, msg));
    body.style.display = 'block';
  };

  const syncBtn = () => {
    const asking = !!input?.value.trim();
    btn.textContent = asking ? 'Ask' : initialButtonLabel;
    const showControls = !asking && showingSummary;
    btn.style.display = showControls ? 'none' : '';
    relink.style.display = showControls && checkRateLimit().count < RL_MAX ? '' : 'none';
  };

  const runSummary = async () => {
    btn.disabled = true;
    note(`${p}-progress`, '⏳ Reading reviews…');
    try {
      const texts = await fetchReviews();
      if (!texts.length) throw new Error('No written reviews found yet.');
      note(`${p}-progress`, '✦ Summarizing…');
      const data = await llmSummarize(texts, summaryPrompt, schema);
      bumpRateLimit();
      if (summaryCacheKey) cacheSet(summaryCacheKey, data);
      renderMediaSummary(data);
      showingSummary = true;
    } catch (e: any) {
      note(`${p}-error`, e.message);
    } finally {
      btn.disabled = false;
      syncBtn();
    }
  };

  const renderQA = () => {
    if (!qaRow || !ask) return;
    const items = ask.qaCacheKey ? loadQAs(ask.qaCacheKey) : [];
    qaRow.textContent = '';
    if (!items.length) { qaRow.style.display = 'none'; return; }
    qaRow.style.display = 'flex';
    qaRow.append(el('span', `${p}-qa-label`, 'Recent questions'));
    for (const item of items) {
      const chip = el('button', `${p}-qa-chip`, item.q) as HTMLButtonElement;
      chip.title = item.q;
      chip.addEventListener('click', () => {
        if (input) input.value = item.q;
        renderAnswer(item.a);
        showingSummary = false;
        syncBtn();
      });
      qaRow.append(chip);
    }
  };

  const runAsk = async (question: string) => {
    if (!ask) return;
    const cachedQAs = ask.qaCacheKey ? loadQAs(ask.qaCacheKey) : [];
    const hit = cachedQAs.find((e) => e.q.toLowerCase() === question.toLowerCase());
    if (hit) { renderAnswer(hit.a); showingSummary = false; syncBtn(); return; }
    btn.disabled = true;
    note(`${p}-progress`, '⏳ Reading reviews…');
    try {
      const texts = await fetchReviews();
      if (!texts.length) throw new Error('No written reviews found yet.');
      note(`${p}-progress`, '⏳ Asking…');
      const answer = (await llmSummarize(texts, `${ask.questionPrompt}\n\nQuestion: ${question}`, null)) as string;
      bumpRateLimit();
      if (ask.qaCacheKey) saveQA(ask.qaCacheKey, { q: question, a: answer, ts: Date.now() });
      renderAnswer(answer);
      showingSummary = false;
      renderQA();
    } catch (e: any) {
      note(`${p}-error`, e.message);
    } finally {
      btn.disabled = false;
      syncBtn();
    }
  };

  btn.addEventListener('click', () => {
    const q = input?.value.trim();
    if (ask && q) runAsk(q);
    else runSummary();
  });
  if (input) {
    input.addEventListener('input', syncBtn);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
  }

  const cached = summaryCacheKey ? cacheGet(summaryCacheKey, summaryTtl) : null;
  if (cached?.summary) {
    renderMediaSummary(cached);
    showingSummary = true;
  }
  renderQA();
  syncBtn();

  return section;
};
