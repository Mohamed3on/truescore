import { getGeminiApiKey, geminiEndpoint } from './config';

export const renderStructuredSummary = (container: HTMLElement, { complaints, praised, conclusion, betterAlternative, suspiciousPatterns }: any) => {
  container.textContent = '';
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
      bullet.textContent = item;
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
    item.textContent = betterAlternative;
    section.appendChild(item);
    container.appendChild(section);
  }
  if (suspiciousPatterns) {
    const section = document.createElement('div');
    section.className = 'ars-section ars-section--suspicious';
    const heading = document.createElement('div');
    heading.className = 'ars-section-title';
    heading.textContent = '\u26A0 Suspicious patterns';
    section.appendChild(heading);
    const item = document.createElement('div');
    item.className = 'ars-section-item';
    item.textContent = suspiciousPatterns;
    section.appendChild(item);
    container.appendChild(section);
  }
  if (conclusion) {
    const el = document.createElement('div');
    el.className = 'ars-conclusion';
    el.textContent = conclusion;
    container.appendChild(el);
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

export const geminiSummarize = async (reviewTexts: string[], prompt: string): Promise<any> => {
  const apiKey = await getGeminiApiKey();
  if (!apiKey) throw new Error('No Gemini API key \u2014 set one in the TrueScore popup');

  const res = await fetch(geminiEndpoint(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt + '\n\nReviews:\n\n' + reviewTexts.join('\n---\n') }] }],
      generationConfig: {
        temperature: 0,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        responseSchema: SUMMARY_SCHEMA
      }
    }),
  });

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const raw = parts.filter((p: any) => !p.thought).pop()?.text;
  if (!raw) throw new Error(data.error?.message || 'Empty Gemini response');
  return JSON.parse(raw);
};

const THIRTY_DAYS = 30 * 86400000;
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

interface SummarizeWidgetOpts {
  wrapper: HTMLElement;
  cacheKey: string;
  summaryPrompt: string;
  fetchReviews: () => Promise<string[]>;
}

export const buildSummarizeWidget = ({ wrapper, cacheKey, summaryPrompt, fetchReviews }: SummarizeWidgetOpts) => {
  const questionRow = document.createElement('div');
  questionRow.className = 'ars-question-row';
  const questionInput = document.createElement('input');
  questionInput.type = 'text';
  questionInput.placeholder = 'Ask about this product\u2026';
  questionInput.className = 'ars-question-input';
  questionRow.appendChild(questionInput);
  wrapper.appendChild(questionRow);

  const summaryPanel = document.createElement('div');
  summaryPanel.className = 'ars-summary-panel';
  summaryPanel.style.display = 'none';

  const runSummarize = async (btn: HTMLButtonElement) => {
    const question = questionInput.value.trim();
    btn.disabled = true;
    btn.textContent = '\u23F3 Fetching reviews\u2026';
    try {
      const reviews = [...await fetchReviews()];
      if (!reviews.length) throw new Error('No reviews found');
      reviews.sort((a, b) => b.length - a.length);
      btn.textContent = '\u23F3 Summarizing\u2026';

      const prompt = question
        ? `${QUESTION_PROMPT}\n\nQuestion: ${question}`
        : summaryPrompt;

      const parsed = await geminiSummarize(reviews, prompt);
      const ts = Date.now();

      bumpRateLimit();
      if (!question) localStorage.setItem(cacheKey, JSON.stringify({ parsed, ts }));

      renderStructuredSummary(summaryPanel, parsed);
      summaryPanel.style.display = 'block';
      return ts;
    } catch (e: any) {
      summaryPanel.textContent = `Error: ${e.message}`;
      summaryPanel.style.display = 'block';
      btn.disabled = false;
      btn.textContent = question ? 'Ask' : '\u2726 Summarize Reviews';
      return null;
    }
  };

  const showDateRow = (ts: number) => {
    const row = document.createElement('div');
    row.className = 'ars-summary-meta';
    const dateLabel = document.createElement('div');
    dateLabel.className = 'ars-summary-date';
    dateLabel.textContent = `Summarized on ${new Date(ts).toLocaleDateString()}`;
    row.appendChild(dateLabel);
    if (checkRateLimit().count < RL_MAX) {
      const reBtn = document.createElement('button');
      reBtn.className = 'ars-resummarize-btn';
      reBtn.textContent = '\u21BB Re-summarize';
      reBtn.addEventListener('click', async () => {
        const newTs = await runSummarize(reBtn);
        if (newTs) row.replaceWith(showDateRow(newTs));
      });
      row.appendChild(reBtn);
    }
    wrapper.appendChild(row);
    return row;
  };

  const summarizeBtn = document.createElement('button');
  summarizeBtn.className = 'ars-summarize-btn';
  summarizeBtn.textContent = '\u2726 Summarize Reviews';

  questionInput.addEventListener('input', () => {
    summarizeBtn.textContent = questionInput.value.trim() ? 'Ask' : '\u2726 Summarize Reviews';
  });
  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') summarizeBtn.click();
  });
  summarizeBtn.addEventListener('click', async () => {
    const ts = await runSummarize(summarizeBtn);
    if (ts && !questionInput.value.trim()) summarizeBtn.replaceWith(showDateRow(ts));
    else if (ts) { summarizeBtn.disabled = false; summarizeBtn.textContent = 'Ask'; }
  });

  questionRow.appendChild(summarizeBtn);

  // Restore cached summary
  const rawCache = localStorage.getItem(cacheKey);
  let cached: any = null;
  if (rawCache) {
    try { cached = JSON.parse(rawCache); } catch (_) {}
    if (cached && Date.now() - cached.ts > THIRTY_DAYS) {
      localStorage.removeItem(cacheKey);
      cached = null;
    }
  }
  if (cached?.parsed) {
    showDateRow(cached.ts);
    renderStructuredSummary(summaryPanel, cached.parsed);
    summaryPanel.style.display = 'block';
  }

  wrapper.appendChild(summaryPanel);
};
