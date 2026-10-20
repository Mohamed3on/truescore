import { getActiveLLM } from './config';
import { addCommas, el, renderMarkdown, renderMarkdownInline } from './utils';
import { cacheGet, cacheSet } from './cache';
import { askTransport, bumpRateLimit, checkRateLimit, RL_MAX, summarize } from './llm';
import { loadQAs, removeQA } from './qa-history';
import { askReviews, mountAskView, type SearchAsk } from './review-ask';
import { bySupport, enter, fadeIn, foldAway, mountBullets, parseOrQuery, receiptsFor, smoothDrafts, writeMarkdown, type AskSearch, type SearchReviews } from '@truescore/gmaps-shared';
import type { JSONSchema7 } from 'ai';
import { readAnswers, readSupport, receiptButton } from './jev';

// Rivals checked per summary, at a search and a Jev read each.
const MAX_RIVALS = 3;

// The betterAlternative rule every structured summary prompt shares (retail,
// BJJ courses, hotels), so the "Better alternative" section means the same thing
// on every site: a rival reviewers endorse over this one, never one they merely
// mention or compare. `rival` names what a rival is on that site. The model's
// own pick shows only when Jev can't check its `rivals` (see withReceipts).
export const betterAlternativeRule = (rival: string) => `betterAlternative: only if 2+ reviewers say a specific ${rival} is better than this one — they prefer it, switched to it, or recommend it instead — give its name and why they prefer it, nothing else. Merely being mentioned or compared is not enough: leave out ones reviewers call equal, only marginally different, or worse, and ones reviewers disagree about. If none clears that bar, return an empty string for this field. Never write a sentence explaining that there's no alternative; absence must be silent.

rivals: every specific ${rival} that even one of these reviews says is better than this one in that sense, most-preferred first, at most ${MAX_RIVALS} — including ones betterAlternative leaves out for too few reviewers or for disagreement, since every review naming each is read before it shows. name: its name, spelled out as reviewers who write it in full do, never starred out ("Acme Pro"); aliases: every other way reviewers write it, exactly as written ("Acme", "AcmePro"), as each is searched; why: in one line, what they say it does better ("lasts twice as long") — never who or how many say so, as the count shows beside it. An empty list if no review prefers one.`;

// Shared default summary prompt for retail product pages (Amazon, Decathlon, dm…).
// Domain-specific pages (hotels, films, BJJ courses) keep their own prompts.
export const PRODUCT_SUMMARY_PROMPT = `Analyze these product reviews. Ignore shipping, delivery, packaging, or seller issues — focus ONLY on the product itself. Skip generic praise like "great product".

Cover the recurring themes mentioned by 2+ reviewers, ranked by how often they come up. Each bullet is one concrete, specific point with enough detail to be useful — e.g. "Adhesive lifts at the edges after a few hours", not just "doesn't stick". When reviewers disagree on a point, say so. Give the 4–6 strongest points for praised and for complaints; don't pad with weak or one-off mentions.

${betterAlternativeRule('competing product')}

conclusion: 2–4 sentences — the overall verdict: what owners consistently say, who it suits best or the main thing to watch out for, and whether it's good value when reviewers mention price. Don't just restate the bullets, and don't mention what reviewers didn't say.`;

// The prompt for the summarize widget under a search's
// matches (see summarizeMatches). The searched term is only a lens: without this
// framing a brand-name search ("Durex") on a competitor page came back as a
// review of Durex.
export const keywordSummaryPrompt = (kw: string) =>
  `These are reviews of the product on this page that mention "${kw}". This product is always the subject, never ${kw}: do not review, rate, or give a verdict on ${kw} itself. Cover what reviewers praise and complain about regarding this product where ${kw} comes up, most-mentioned first; include a point only if 2+ reviewers make it. If ${kw} is a competing product or brand, frame each point as how reviewers say this product compares to it. Ignore shipping, delivery, packaging, and seller issues. If reviewers disagree, surface the tension. End with a short verdict on this product in relation to ${kw}.`;

// A product's Summary and Ask read every review up to the newest this many: more
// would put hundreds of thousands of tokens into each one. An Ask on an item with
// more reaches the rest by Searching.
export const SAMPLE_MAX = 3000;

// Reviews a summary's points are checked against: the longest, as the summary
// reads them first. Past this a point's count says how many it covers.
const RECEIPT_REVIEWS = 200;
type Receipt = { n: number; quotes: string[] };

type Rival = { name: string; aliases: string[]; why: string };

// The reviews naming a rival: every one of the page's when it can search them,
// else the ones in hand — not the model's sample, which may hold too few of them
// to settle it (Amazon's newest 100 held 3 of a syrup's 8 reviews naming More).
const naming = async ({ name, aliases }: Rival, reviews: string[], search?: SearchReviews): Promise<string[]> => {
  const query = [name, ...(aliases ?? [])].join(' OR ');
  const names = parseOrQuery(query);
  return (search && (await search(query, () => {}))?.texts) || reviews.filter((t) => names.some((n) => t.toLowerCase().includes(n.toLowerCase())));
};

// The structured summary with its receipts (receiptsFor), read by Jev through
// the server's endpoints: each praise and complaint keeps how many reviews make
// it and which, one too few make is dropped before it's ever shown, and the
// better alternative is the rival most reviewers naming it would rather have,
// when the shared rule keeps one. Unchanged when Jev can't read them; the
// model's own pick stands when only the rivals couldn't be read.
export const withReceipts = async (parsed: any, reviews: string[], search?: SearchReviews) => {
  const texts = reviews.slice(0, RECEIPT_REVIEWS);
  const points: string[] = [...(parsed.praised ?? []), ...(parsed.complaints ?? [])];
  const rivals: Rival[] = (parsed.rivals ?? []).filter((r: Rival) => r?.name?.trim()).slice(0, MAX_RIVALS);
  const checked = await receiptsFor(points, texts, rivals.map((r) => ({ name: r.name, texts: naming(r, reviews, search) })), { support: readSupport, answers: readAnswers });
  if (!checked) return parsed;
  const receipts: Record<string, Receipt> = {};
  points.forEach((p, i) => { const r = checked.points[i]; if (r) receipts[p] = { n: r.support, quotes: r.quotes }; });
  const [best] = [...(checked.alternatives ?? [])].sort((a, b) => b.support - a.support);
  const why = best && rivals.find((r) => r.name === best.name)?.why;
  const line = best ? (why ? `**${best.name}** — ${why}` : `**${best.name}**`) : '';
  if (best) receipts[line] = { n: best.support, quotes: best.quotes };
  const made = (p: string) => p in receipts;
  return {
    ...parsed,
    praised: (parsed.praised ?? []).filter(made),
    complaints: (parsed.complaints ?? []).filter(made),
    betterAlternative: checked.alternatives ? line : parsed.betterAlternative,
    receipts,
    ...(reviews.length > texts.length ? { receiptsOf: reviews.length } : {}),
  };
};

// Draws one of the texts the model read as the site's review card (see
// quoteCards); null leaves it as the text.
export type RenderQuote = (text: string) => HTMLElement | null | Promise<HTMLElement | null>;

const receiptFor = (item: HTMLElement, { n, quotes }: Receipt, checkedOf: number | undefined, renderQuote: RenderQuote) =>
  receiptButton(item, n, quotes, renderQuote, checkedOf ? `Of the ${RECEIPT_REVIEWS} longest of ${checkedOf} reviews — show the ones that say this` : undefined);

// Where a summary on screen stands: being written (each bullet shows as it
// streams in), written and being checked against the reviews, or checked.
type SummaryPhase = 'writing' | 'checking' | 'checked';

// A panel's blocks join `container` in their fixed order, whichever is drawn first.
const inOrder = (container: HTMLElement, blocks: () => (HTMLElement | undefined)[]) => (node: HTMLElement) => {
  if (node.isConnected) return;
  const all = blocks();
  container.insertBefore(node, all.slice(all.indexOf(node) + 1).find((b) => b?.isConnected) ?? null);
};

const sectionOf = (type: string, title: string) => {
  const section = el('div', `ars-section ars-section--${type}`);
  section.appendChild(el('div', 'ars-section-title', title));
  return section;
};

// A summary drawn into `container` and redrawn in place: its praise and
// complaints are bullet lists drawn as they stream in (gmaps-shared
// summary-draw), and the verdict, written last but shown first, holds its
// place. Drawing a checked summary straight away (a cached one) builds it at
// once, with nothing moving.
const mountStructuredSummary = (container: HTMLElement, renderQuote: RenderQuote) => {
  container.textContent = '';
  const conclusion = el('div', 'ars-conclusion');
  let receiptsOf: number | undefined;
  const listOf = (type: string, title: string) => {
    const section = sectionOf(type, title);
    const bullets = mountBullets<{ text: string; receipt?: Receipt }>(section, (b) => b.text, () => el('div', 'ars-section-item'), (row, b) => {
      renderMarkdownInline(row, b.text);
      if (b.receipt) row.appendChild(receiptFor(row, b.receipt, receiptsOf, renderQuote));
    });
    return { section, bullets };
  };
  const lists = [listOf('praised', '\u25B3 Universally praised'), listOf('complaints', '\u25BD Common complaints')] as const;
  let alt: HTMLElement | undefined;
  let streamed = false;
  const show = inOrder(container, () => [conclusion, lists[0].section, lists[1].section, alt]);

  const drawConclusion = (text: string | undefined, phase: SummaryPhase) => {
    if (text) {
      conclusion.classList.remove('ars-conclusion-wait');
      writeMarkdown(conclusion, text, renderMarkdown);
      show(conclusion);
    } else if (phase === 'writing') {
      if (!conclusion.classList.contains('ars-conclusion-wait')) {
        conclusion.classList.add('ars-conclusion-wait');
        conclusion.replaceChildren(el('span'), el('span'), el('span'));
      }
      show(conclusion);
    } else conclusion.remove();
  };

  return (summary: any, phase: SummaryPhase = 'checked') => {
    const texts = (list: unknown) => (Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string' && !!t) : []);
    const written = [texts(summary.praised), texts(summary.complaints)];
    container.setAttribute('aria-busy', String(phase !== 'checked'));
    drawConclusion(summary.conclusion, phase);
    const { receipts, betterAlternative } = summary;
    receiptsOf = summary.receiptsOf;
    for (const [i, { section, bullets }] of lists.entries()) {
      if (phase !== 'checked') {
        streamed = true;
        bullets.draft(written[i]!.map((text) => ({ text })));
        if (written[i]!.length) show(section);
        continue;
      }
      // Most-backed first once checked.
      const ordered = receipts ? bySupport(written[i]!.map((text) => ({ text, support: receipts[text]?.n }))).map((x) => x.text) : written[i]!;
      void bullets.settle(ordered.map((text) => ({ text, receipt: receipts?.[text] })));
      if (ordered.length) show(section);
      else void foldAway(section);
    }
    if (phase !== 'checked' || !betterAlternative) return;
    alt = sectionOf('alt', '\u21C4 Better alternative');
    const item = alt.appendChild(el('div', 'ars-section-item'));
    renderMarkdownInline(item, betterAlternative);
    // Its count spans every review naming it, not the longest RECEIPT_REVIEWS.
    if (receipts?.[betterAlternative]) item.appendChild(receiptFor(item, receipts[betterAlternative], undefined, renderQuote));
    if (streamed) alt.classList.add('ars-arrive');
    show(alt);
  };
};

export const renderStructuredSummary = (container: HTMLElement, summary: any, renderQuote: RenderQuote) =>
  mountStructuredSummary(container, renderQuote)(summary);

const SUMMARY_SCHEMA = {
  type: 'object' as const,
  // Written in the order the panel shows them, so a streamed summary fills in
  // top to bottom (the conclusion, shown first, holds its place till last).
  properties: {
    praised: { type: 'array' as const, items: { type: 'string' as const } },
    complaints: { type: 'array' as const, items: { type: 'string' as const } },
    conclusion: { type: 'string' as const },
    betterAlternative: { type: 'string' as const },
    rivals: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: { name: { type: 'string' as const }, aliases: { type: 'array' as const, items: { type: 'string' as const } }, why: { type: 'string' as const } },
        required: ['name', 'aliases', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['praised', 'complaints', 'conclusion', 'betterAlternative', 'rivals'],
  additionalProperties: false,
};

// Reference material (e.g. a course's volume/chapter breakdown) appended to
// both the structured-summary prompt and every Ask, so questions can map vague
// reviewer mentions to specific named sections too — not just the summary.
export const withContext = (prompt: string, context?: string) => (context ? `${prompt}\n\n${context}` : prompt);

// One pass over the reviews on the popup's model: free-form text for a null
// schema, else an object matching it, streamed to `onPartial` (see llm.ts).
export const llmSummarize = (reviewTexts: string[], prompt: string, schema: JSONSchema7 | null = SUMMARY_SCHEMA, onPartial?: (partial: any) => void): Promise<any> =>
  summarize(reviewTexts, prompt, schema, onPartial);

// Rewrites the answer already there, so a streamed one grows in place.
export const renderFreeFormAnswer = (container: HTMLElement, text: string) => {
  let answer = container.querySelector<HTMLElement>(':scope > .ars-answer');
  if (!answer) container.replaceChildren((answer = el('div', 'ars-answer')));
  writeMarkdown(answer, text, renderMarkdown);
};

const QUESTION_PROMPT = `Answer this question using ONLY evidence from the product reviews below. Quote or paraphrase the most concrete details. If reviewers disagree, surface the tension. Be direct and practical.`;

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
  // Summarize on landing when nothing is cached — or once the promise says to,
  // for a panel that may yet be replaced before it should spend a model call.
  autoSummarize?: boolean | Promise<boolean>;
  // Lets an Ask Search every review before it answers; without it an Ask is
  // one pass over fetchReviews.
  searchAsk?: SearchAsk;
  // Draws one of fetchReviews' texts as the site's review card, for a summary
  // point's receipts.
  renderQuote: RenderQuote;
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
  searchAsk,
  renderQuote,
}: SummarizeWidgetOpts) => {
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
  const RESUMMARIZE_LABEL = '\u21BB Re-summarize';
  const reBtn = document.createElement('button');
  reBtn.className = 'ars-resummarize-btn';
  reBtn.textContent = RESUMMARIZE_LABEL;
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
      // It shows as it's written, its points dim until they're checked
      // against the reviews.
      const draw = mountStructuredSummary(summaryPanel, renderQuote);
      void draw({}, 'writing');
      summaryPanel.style.display = 'block';
      const summary = await llmSummarize(reviews, withContext(summaryPrompt, context), undefined, (partial) => draw(partial, 'writing'));
      btn.textContent = '\u23F3 Checking it against the reviews\u2026';
      void draw(summary, 'checking');
      const parsed = await withReceipts(summary, reviews, searchAsk?.search);
      bumpRateLimit();
      summaryTs = Date.now();
      // Quota-full must not discard a summary the LLM call already paid for.
      try { localStorage.setItem(cacheKey, JSON.stringify({ parsed, ts: summaryTs, meta: cacheMeta })); } catch {}
      void draw(parsed);
      panelMode = 'summary';
    } catch (e: any) {
      summaryPanel.textContent = `Error: ${e.message}`;
      summaryPanel.removeAttribute('aria-busy');
      summaryPanel.style.display = 'block';
    } finally {
      btn.disabled = false;
      // syncControls relabels the Summarize button only; without this the
      // Re-summarize button keeps the progress label it wore during the run.
      if (btn === reBtn) btn.textContent = RESUMMARIZE_LABEL;
      syncControls();
    }
  };

  // An Answer in the panel, under the Searches that reached it.
  const showAnswer = (text: string, searches: AskSearch[] = []) => {
    mountAskView(summaryPanel, 'ars-answer', searchAsk?.open)({ searches, text, done: true });
    summaryPanel.style.display = 'block';
    panelMode = 'answer';
  };

  const runAsk = async (btn: HTMLButtonElement, question: string) => {
    try {
      await askReviews({
        question, search: searchAsk?.search, qaKey: cacheKey, limited: true,
        live: () => summaryPanel.isConnected,
        transport: async (canSearch) => {
          btn.disabled = true;
          btn.textContent = '\u23F3 Fetching reviews\u2026';
          const reviews = await loadReviews();
          btn.textContent = '\u23F3 Asking\u2026';
          return askTransport(withContext(questionPrompt, context), reviews, canSearch);
        },
        mount: (reads) => {
          summaryPanel.style.display = 'block';
          panelMode = 'answer';
          return mountAskView(summaryPanel, 'ars-answer', searchAsk?.open, reads);
        },
      });
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
        showAnswer(item.a, item.searches);
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

  // The reviews as the model reads them, under the page's title and URL, to
  // paste into another tool: a quiet icon closing the Ask row, a check once copied.
  const COPY_ICON = '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>';
  const copyBtn = el('button', 'ars-copy-btn') as HTMLButtonElement;
  copyBtn.type = 'button';
  const showCopy = (state: 'idle' | 'copied' | 'failed', label: string) => {
    copyBtn.dataset.state = state;
    copyBtn.title = label;
    copyBtn.setAttribute('aria-label', label);
    copyBtn.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${state === 'copied' ? '<path d="M3.5 8.5l3 3 6-7"/>' : COPY_ICON}</svg>`;
  };
  showCopy('idle', 'Copy reviews');
  let copyReset: ReturnType<typeof setTimeout> | undefined;
  copyBtn.addEventListener('click', async () => {
    clearTimeout(copyReset);
    copyBtn.disabled = true;
    try {
      const reviews = await loadReviews();
      await navigator.clipboard.writeText(`${document.title}\n${location.href}\n\n${reviews.join('\n---\n')}`);
      showCopy('copied', `Copied ${addCommas(reviews.length)} reviews`);
    } catch (e: any) {
      showCopy('failed', `Couldn't copy: ${e.message}`);
    } finally {
      copyBtn.disabled = false;
      copyReset = setTimeout(() => showCopy('idle', 'Copy reviews'), 2000);
    }
  });
  questionRow.appendChild(copyBtn);

  // Restore cached summary
  const rawCache = localStorage.getItem(cacheKey);
  let cached: any = null;
  if (rawCache) {
    try { cached = JSON.parse(rawCache); } catch (_) {}
  }
  if (cached?.parsed) {
    summaryTs = cached.ts;
    renderStructuredSummary(summaryPanel, cached.parsed, renderQuote);
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
    Promise.resolve(autoSummarize).then(async (go) => {
      if (go && (await getActiveLLM()).key && !questionInput.value.trim()) summarizeBtn.click();
    });
  }
};

// The full summarize widget under a search's matches (buildSearchSection's
// mountSummarize): a summary of them and an Ask about them, cached per query
// under `cacheKey`, its receipts drawn as the matches' cards.
export const summarizeMatches = (cacheKey: string, opts: Pick<SummarizeWidgetOpts, 'context' | 'searchAsk'> = {}) =>
  (wrapper: HTMLElement, query: string, texts: string[], renderQuote: RenderQuote) => buildSummarizeWidget({
    wrapper,
    cacheKey: `${cacheKey}-kw-${query.toLowerCase()}`,
    summaryPrompt: keywordSummaryPrompt(query),
    fetchReviews: async () => texts,
    questionPlaceholder: `Ask about “${query}” reviews…`,
    renderQuote,
    ...opts,
  });

// A book's or film's summary: a verdict, then the points the most reviewers
// make, each loved, disliked or divided. A kind no common point falls under has
// none, so a film everyone loves shows no complaints and one everyone pans no
// praise. Each point is written before it's judged: with `sentiment` first, the
// mark led and the text followed (a pan's five complaints came out "loved").
export const MEDIA_SUMMARY_SCHEMA: JSONSchema7 = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: 'One sentence: how strongly reviewers recommend it, and to whom.' },
    points: {
      type: 'array',
      description: 'The most common points, most-made first.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The thing in **bold**, then its effect in a short sentence.' },
          sentiment: { type: 'string', enum: ['loved', 'disliked', 'divided'], description: 'Whether the point is praise (loved) or a complaint (disliked); divided only when many reviewers land on each side.' },
        },
        required: ['text', 'sentiment'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'points'],
  additionalProperties: false,
};

// The stance marks reviews already carry (STANCE_MARKS' ▲ ▼ ●), drawn so the
// three match in size and centre on a point's first line.
const MEDIA_MARKS: Record<string, { label: string; shape: string }> = {
  loved: { label: 'Loved', shape: '<path d="M4 .5 8 7.5H0z"/>' },
  disliked: { label: 'Didn’t enjoy', shape: '<path d="M0 .5h8L4 7.5z"/>' },
  divided: { label: 'Divided', shape: '<circle cx="4" cy="4" r="3"/>' },
};

interface MediaSummaryOpts {
  anchor: Element;
  classPrefix: string;
  heading: string;
  // Or built from the fetched reviews, for a rule that only fits some of them.
  summaryPrompt: string | ((texts: string[]) => string);
  summaryCacheKey: string | null;
  summaryTtl: number;
  fetchReviews: () => Promise<string[]>;
  initialButtonLabel: string;
  ask?: { placeholder: string; questionPrompt: string; qaCacheKey: string | null };
  // As on buildSummarizeWidget: lets the Ask Search every review first.
  searchAsk?: SearchAsk;
}

// Shared summary + Q&A panel for media-review sites (Goodreads books, Letterboxd
// films): a verdict and stance-marked points (MEDIA_SUMMARY_SCHEMA), instant
// synchronous restore of the cached summary on mount, and an optional
// free-form Ask with cached recent-question chips. Styled entirely by the host
// via `classPrefix` (each site ships its own CSS using the same suffixes). This
// is the editorial counterpart to buildSummarizeWidget (the retail praised/
// complaints product widget with hardcoded ars-* styling); both share the
// llmSummarize, the rate limit (llm.ts) and the Ask run (review-ask.ts).
export const buildMediaSummary = ({
  anchor,
  classPrefix: p,
  heading,
  summaryPrompt,
  summaryCacheKey,
  summaryTtl,
  fetchReviews,
  initialButtonLabel,
  ask,
  searchAsk,
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

  // The summary drawn into `body`, redrawn in place as it streams: the verdict
  // leads, unlabelled, and the marks stand in for section labels, so a kind
  // with no points takes no room. Points are grouped by sentiment, the kind the
  // most-made point has first; asked to order them so, the model mislabelled
  // points to fit the groups. A point joins once its sentiment (written after
  // it) arrives, straight into its group, so none moves once shown.
  // A cached one draws at once; only a streamed one fades in and rises row by row.
  const mountMediaSummary = (animate = true) => {
    const verdict = el('div', `${p}-verdict ${p}-text`);
    const list = el('ul', `${p}-points`);
    const texts = new Map<number, HTMLElement>();
    const kinds: string[] = [];
    let started = false;
    return (data: any) => {
      const value = String(data?.verdict ?? '').trim();
      const points: any[] = Array.isArray(data?.points) ? data.points : [];
      if (!value && !points.length) return;
      // The progress note gives way to the first words.
      if (!started) {
        body.replaceChildren(verdict, list);
        body.style.display = 'block';
        if (animate) fadeIn(body);
        started = true;
      }
      writeMarkdown(verdict, value, renderMarkdownInline);
      points.forEach((point, i) => {
        const mark = MEDIA_MARKS[point?.sentiment];
        if (!mark) return;
        if (!texts.has(i)) {
          if (!kinds.includes(point.sentiment)) kinds.push(point.sentiment);
          const li = el('li', `${p}-point`);
          li.dataset.sentiment = point.sentiment;
          const m = li.appendChild(el('span', `${p}-mark`));
          m.setAttribute('role', 'img');
          m.setAttribute('aria-label', mark.label);
          m.title = mark.label;
          m.innerHTML = `<svg viewBox="0 0 8 8" width="8" height="8" fill="currentColor" aria-hidden="true">${mark.shape}</svg>`;
          texts.set(i, li.appendChild(el('span', `${p}-text`)));
          const kind = kinds.indexOf(point.sentiment);
          list.insertBefore(li, [...list.children].find((c) => kinds.indexOf((c as HTMLElement).dataset.sentiment!) > kind) ?? null);
          if (animate) enter(li, '1');
        }
        // Only some providers write the sentiment last; with it first, the text is still coming.
        writeMarkdown(texts.get(i)!, String(point.text ?? '').trim(), renderMarkdownInline);
      });
    };
  };
  const renderMediaSummary = (data: any) => mountMediaSummary(false)(data);

  const renderAnswer = (text: string, searches: AskSearch[] = []) => {
    mountAskView(body, `${p}-text`, searchAsk?.open)({ searches, text, done: true });
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
      // Each point shows as it's written, flowing in a frame at a time: the
      // partials come in bursts, a few at once after a stall of up to ~300ms.
      const draw = mountMediaSummary();
      const drafts = smoothDrafts<any>(draw, (shown, target, grow) => ({
        verdict: grow(shown?.verdict, String(target?.verdict ?? '')),
        points: (Array.isArray(target?.points) ? target.points : []).map((point: any, i: number) => ({ ...point, text: grow(shown?.points?.[i]?.text, String(point?.text ?? '')) })),
      }));
      const data = await llmSummarize(texts, typeof summaryPrompt === 'string' ? summaryPrompt : summaryPrompt(texts), MEDIA_SUMMARY_SCHEMA, drafts.push)
        .finally(drafts.stop);
      bumpRateLimit();
      if (summaryCacheKey) cacheSet(summaryCacheKey, data);
      draw(data);
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
        renderAnswer(item.a, item.searches);
        showingSummary = false;
        syncBtn();
      });
      qaRow.append(chip);
    }
  };

  const runAsk = async (question: string) => {
    if (!ask) return;
    try {
      await askReviews({
        question, search: searchAsk?.search, qaKey: ask.qaCacheKey, limited: true,
        live: () => body.isConnected,
        transport: async (canSearch) => {
          btn.disabled = true;
          note(`${p}-progress`, '⏳ Reading reviews…');
          const texts = await fetchReviews();
          if (!texts.length) throw new Error('No written reviews found yet.');
          return askTransport(ask.questionPrompt, texts, canSearch);
        },
        mount: (reads) => {
          body.style.display = 'block';
          return mountAskView(body, `${p}-text`, searchAsk?.open, reads);
        },
      });
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

  // A summary cached in an older shape is left to be written again.
  const cached = summaryCacheKey ? cacheGet(summaryCacheKey, summaryTtl) : null;
  if (cached?.points) {
    renderMediaSummary(cached);
    showingSummary = true;
  }
  renderQA();
  syncBtn();

  return section;
};
