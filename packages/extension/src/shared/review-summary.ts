import { getActiveLLM } from './config';
import { el, renderMarkdown, renderMarkdownInline } from './utils';
import { cacheGet, cacheSet } from './cache';
import { summarize } from './llm';
import { findQA, loadQAs, removeQA, saveQA } from './qa-history';
import { askReviews, mountAskView, type SearchAsk } from './review-ask';
import { bySupport, parseOrQuery, type AskSearch, type SearchReviews } from '@truescore/gmaps-shared';
import type { JSONSchema7 } from 'ai';
import { readAnswers, readSupport, receiptButton } from './jev';

// Rivals checked per summary, at a search and a Jev read each.
const MAX_RIVALS = 3;

// The betterAlternative rule every structured summary prompt shares (retail,
// BJJ courses, hotels), so the "Better alternative" section means the same thing
// on every site: a rival reviewers endorse over this one, never one they merely
// mention or compare. `rival` names what a rival is on that site. The model's
// own pick shows only when Jev can't check its `rivals` (see preferredRival).
export const betterAlternativeRule = (rival: string) => `betterAlternative: only if 2+ reviewers say a specific ${rival} is better than this one — they prefer it, switched to it, or recommend it instead — give its name and why they prefer it, nothing else. Merely being mentioned or compared is not enough: leave out ones reviewers call equal, only marginally different, or worse, and ones reviewers disagree about. If none clears that bar, return an empty string for this field. Never write a sentence explaining that there's no alternative; absence must be silent.

rivals: every specific ${rival} that even one of these reviews says is better than this one in that sense, most-preferred first, at most ${MAX_RIVALS} — including ones betterAlternative leaves out for too few reviewers or for disagreement, since every review naming each is read before it shows. name: its name, spelled out as reviewers who write it in full do, never starred out ("Acme Pro"); aliases: every other way reviewers write it, exactly as written ("Acme", "AcmePro"), as each is searched; why: in one line, what they say it does better ("lasts twice as long") — never who or how many say so, as the count shows beside it. An empty list if no review prefers one.`;

// Shared default summary prompt for retail product pages (Amazon, Decathlon, dm…).
// Domain-specific pages (hotels, films, BJJ courses) keep their own prompts.
export const PRODUCT_SUMMARY_PROMPT = `Analyze these product reviews. Ignore shipping, delivery, packaging, or seller issues — focus ONLY on the product itself. Skip generic praise like "great product".

Cover the recurring themes mentioned by 2+ reviewers, ranked by how often they come up. Each bullet is one concrete, specific point with enough detail to be useful — e.g. "Adhesive lifts at the edges after a few hours", not just "doesn't stick". When reviewers disagree on a point, say so. Give the 4–6 strongest points for praised and for complaints; don't pad with weak or one-off mentions.

${betterAlternativeRule('competing product')}

conclusion: 2–4 sentences — the overall verdict: what owners consistently say, who it suits best or the main thing to watch out for, and whether it's good value when reviewers mention price. Don't just restate the bullets, and don't mention what reviewers didn't say.`;

// Free-form prompt for summarizing a searched subset of product reviews
// (the review-search section's "Summarize <query>" pass).
export const FILTERED_PRODUCT_SUMMARY_PROMPT = `These are reviews of the product on this page, filtered to the ones that mention the searched term. Summarize what they say about this product where that term comes up. The product is always the subject: if the term is a competing product or brand, describe how reviewers compare this product to it instead of reviewing the competitor. Lead with the bottom line. Ignore shipping, delivery, packaging, or seller issues — focus only on the product itself. Be punchy and decisive, no hedging. A few short paragraphs or bullets are fine.`;

// The structured counterpart, for the full summarize widget under a search's
// matches (see summarizeMatches). The searched term is only a lens: without this
// framing a brand-name search ("Durex") on a competitor page came back as a
// review of Durex.
export const keywordSummaryPrompt = (kw: string) =>
  `These are reviews of the product on this page that mention "${kw}". This product is always the subject, never ${kw}: do not review, rate, or give a verdict on ${kw} itself. Cover what reviewers praise and complain about regarding this product where ${kw} comes up, most-mentioned first; include a point only if 2+ reviewers make it. If ${kw} is a competing product or brand, frame each point as how reviewers say this product compares to it. Ignore shipping, delivery, packaging, and seller issues. If reviewers disagree, surface the tension. End with a short verdict on this product in relation to ${kw}.`;

// A product's Summary and Ask read every review up to the newest this many: more
// would put hundreds of thousands of tokens into each one. An Ask on an item with
// more reaches the rest by Searching.
export const SAMPLE_MAX = 3000;

// Summary points need the support of this many reviews to be shown — the
// prompt's own "2+ reviewers" rule, enforced instead of trusted.
const MIN_SUPPORT = 2;
// Reviews a summary's points are checked against: the longest, as the summary
// reads them first. Past this a point's count says how many it covers.
const RECEIPT_REVIEWS = 200;
const QUOTES_MAX = 20;
type Receipt = { n: number; quotes: string[] };

type Rival = { name: string; aliases: string[]; why: string };

// The better alternative, settled by every review naming a rival — all of the
// page's when it can search them, else the ones in hand — not by the model,
// whose sample may hold too few of them to settle it (Amazon's newest 100 held
// 3 of a syrup's 8 reviews naming More): the rival most reviewers would rather
// have, when 2+ would and more would than wouldn't, as its line and receipt.
// Null when none would; undefined when Jev couldn't read them.
const preferredRival = async (rivals: Rival[], reviews: string[], search?: SearchReviews) => {
  const reads = await Promise.all(rivals.filter((r) => r?.name?.trim()).slice(0, MAX_RIVALS).map(async ({ name, aliases, why }) => {
    const query = [name, ...(aliases ?? [])].join(' OR ');
    const names = parseOrQuery(query);
    const texts = (search && (await search(query, () => {}))?.texts) || reviews.filter((t) => names.some((n) => t.toLowerCase().includes(n.toLowerCase())));
    // Asked "Is it better than what this review is about?", Jev read reviews
    // preferring More as no, and one ranking this syrup above a rival as yes.
    const answers = texts.length ? await readAnswers(`Does this reviewer prefer ${name} to the one they're reviewing?`, texts) : [];
    if (!answers) return null;
    const yes = texts.filter((_, i) => answers[i] === 'yes');
    return { line: why ? `**${name}** — ${why}` : `**${name}**`, yes, no: answers.filter((a) => a === 'no').length };
  }));
  const read = reads.filter((r) => r !== null);
  if (read.length < reads.length) return undefined;
  const [best] = read.filter((r) => r.yes.length >= MIN_SUPPORT && r.yes.length > r.no).sort((a, b) => b.yes.length - a.yes.length);
  return best ? { line: best.line, receipt: { n: best.yes.length, quotes: best.yes.slice(0, QUOTES_MAX) } } : null;
};

// The structured summary with its receipts, read by Jev on the server: each
// praise and complaint keeps how many reviews make it and the first of them; one
// fewer than MIN_SUPPORT make is dropped before it's ever shown, and the better
// alternative is preferredRival's. Unchanged when Jev can't read them.
export const withReceipts = async (parsed: any, reviews: string[], search?: SearchReviews) => {
  const texts = reviews.slice(0, RECEIPT_REVIEWS);
  const points: string[] = [...(parsed.praised ?? []), ...(parsed.complaints ?? [])];
  const [support, rival] = await Promise.all([points.length ? readSupport(points, texts) : null, preferredRival(parsed.rivals ?? [], reviews, search)]);
  if (!support) return parsed;
  const receipts: Record<string, Receipt> = Object.fromEntries(points.map((p, i) => [p, { n: support[i]!.length, quotes: support[i]!.slice(0, QUOTES_MAX).map((j) => texts[j]!) }]));
  if (rival) receipts[rival.line] = rival.receipt;
  const made = (p: string) => receipts[p]!.n >= MIN_SUPPORT;
  return {
    ...parsed,
    praised: (parsed.praised ?? []).filter(made),
    complaints: (parsed.complaints ?? []).filter(made),
    betterAlternative: rival === undefined ? parsed.betterAlternative : rival?.line ?? '',
    receipts,
    ...(reviews.length > texts.length ? { receiptsOf: reviews.length } : {}),
  };
};

type RenderQuote = (text: string) => HTMLElement | null;

const receiptFor = (item: HTMLElement, { n, quotes }: Receipt, checkedOf: number | undefined, renderQuote?: RenderQuote) =>
  receiptButton(item, n, quotes, checkedOf ? `Of the ${RECEIPT_REVIEWS} longest of ${checkedOf} reviews — show the ones that say this` : undefined, renderQuote);

// Where a summary on screen stands: being written (each bullet shows as it
// streams in), written and being checked against the reviews, or checked.
type SummaryPhase = 'writing' | 'checking' | 'checked';

// The daylight skin's ease (DESIGN.md), for the moves the check makes.
const EASE = 'cubic-bezier(0.25, 1, 0.5, 1)';
const animates = (node: HTMLElement) => typeof node.animate === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

// A bullet the check drops folds shut, so what follows closes up instead of
// jumping. A list it reorders fades out and back in, sorted: bullets sliding
// past each other cross their text, and folding the moved ones shut and open
// again pumps the panel.
const fold = async (node: HTMLElement) => {
  if (animates(node)) {
    node.style.overflow = 'hidden';
    await node.animate([{ height: `${node.offsetHeight}px` }, { height: '0px', opacity: 0, marginTop: '0px', marginBottom: '0px' }], { duration: 200, easing: EASE })
      .finished.catch(() => {});
  }
  node.remove();
};
const fadeOut = (node: HTMLElement) =>
  animates(node) ? node.animate([{ opacity: 0 }], { duration: 120, easing: EASE, fill: 'forwards' }).finished.catch(() => {}) : undefined;
const fadeIn = (node: HTMLElement) => {
  if (!animates(node)) return;
  for (const a of node.getAnimations()) a.cancel();
  node.animate([{ opacity: 0 }, {}], { duration: 220, easing: EASE });
};

// A bullet's text, rewritten only when it changed (a receipt rides along after it).
const write = (node: HTMLElement, text: string) => {
  if (node.dataset.md === text) return;
  node.dataset.md = text;
  renderMarkdownInline(node, text);
};

type Bullets = { section: HTMLElement; items: HTMLElement[] };
const bulletsOf = (type: string, title: string): Bullets => {
  const section = el('div', `ars-section ars-section--${type}`);
  section.appendChild(el('div', 'ars-section-title', title));
  return { section, items: [] };
};

// A summary drawn into `container` and redrawn in place: a streamed partial
// only rewrites the bullet that grew, each showing dim until it's checked. The
// check then folds away the bullets too few reviews make, puts the rest
// most-backed first and lights them up with their counts. Drawing a checked
// summary straight away (a cached one) builds it at once, with nothing moving.
const mountStructuredSummary = (container: HTMLElement, renderQuote?: RenderQuote) => {
  container.textContent = '';
  const conclusion = el('div', 'ars-conclusion');
  const lists = { praised: bulletsOf('praised', '\u25B3 Universally praised'), complaints: bulletsOf('complaints', '\u25BD Common complaints') };
  let alt: HTMLElement | undefined;
  let streamed = false;

  // Each block in its place, whatever order the model writes them in.
  const show = (node: HTMLElement) => {
    if (node.isConnected) return;
    const blocks = [conclusion, lists.praised.section, lists.complaints.section, alt];
    container.insertBefore(node, blocks.slice(blocks.indexOf(node) + 1).find((b) => b?.isConnected) ?? null);
  };

  const drawConclusion = (text: string | undefined, phase: SummaryPhase) => {
    if (text) {
      conclusion.classList.remove('ars-conclusion-wait');
      if (conclusion.dataset.md !== text) {
        conclusion.dataset.md = text;
        renderMarkdown(conclusion, text);
      }
      show(conclusion);
    } else if (phase === 'writing') {
      // The verdict is written last but leads the panel: hold its place.
      if (!conclusion.classList.contains('ars-conclusion-wait')) {
        conclusion.classList.add('ars-conclusion-wait');
        conclusion.replaceChildren(el('span'), el('span'), el('span'));
      }
      show(conclusion);
    } else conclusion.remove();
  };

  const drawWritten = (b: Bullets, texts: string[]) => {
    for (const [i, text] of texts.entries()) {
      b.items[i] ??= b.section.appendChild(el('div', 'ars-section-item ars-pending'));
      write(b.items[i]!, text);
    }
    for (const gone of b.items.splice(texts.length)) gone.remove();
    if (texts.length) show(b.section);
  };

  return async (summary: any, phase: SummaryPhase = 'checked') => {
    const texts = (list: unknown) => (Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string' && !!t) : []);
    container.setAttribute('aria-busy', String(phase !== 'checked'));
    drawConclusion(summary.conclusion, phase);
    if (phase !== 'checked') {
      streamed = true;
      drawWritten(lists.praised, texts(summary.praised));
      drawWritten(lists.complaints, texts(summary.complaints));
      return;
    }
    const { receipts, receiptsOf, betterAlternative } = summary;
    const plans = ([[lists.praised, summary.praised], [lists.complaints, summary.complaints]] as const).map(([b, list]) => {
      const written = texts(list);
      // Most-backed first once checked.
      const ordered = receipts ? bySupport(written.map((text) => ({ text, support: receipts[text]?.n }))).map((x) => x.text) : written;
      const byText = new Map(b.items.map((item) => [item.dataset.md, item]));
      const items = ordered.map((text) => byText.get(text) ?? el('div', 'ars-section-item'));
      const kept = b.items.filter((item) => items.includes(item));
      return { b, ordered, items, dropped: b.items.filter((item) => !items.includes(item)), sorted: kept.some((item, i) => item !== items[i]) };
    });
    // A cached summary (nothing streamed, nothing leaving) draws at once.
    const leaving = plans.flatMap((p) => [...p.dropped.map(fold), ...(p.sorted ? p.items.map(fadeOut) : [])]);
    if (leaving.length) await Promise.all(leaving);
    for (const { b, ordered, items, sorted } of plans) {
      b.items = items;
      b.section.append(...items);
      for (const [i, item] of items.entries()) {
        write(item, ordered[i]!);
        item.classList.remove('ars-pending');
        const receipt = receipts?.[ordered[i]!];
        if (receipt && !item.querySelector(':scope > .ars-receipt')) {
          const button = item.appendChild(receiptFor(item, receipt, receiptsOf, renderQuote));
          if (streamed) button.classList.add('ars-arrive');
        }
        if (sorted) fadeIn(item);
      }
      if (items.length) show(b.section);
      else void fold(b.section);
    }
    if (betterAlternative) {
      alt = bulletsOf('alt', '\u21C4 Better alternative').section;
      const item = alt.appendChild(el('div', 'ars-section-item'));
      renderMarkdownInline(item, betterAlternative);
      // Its count spans every review naming it, not the longest RECEIPT_REVIEWS.
      if (receipts?.[betterAlternative]) item.appendChild(receiptFor(item, receipts[betterAlternative], undefined, renderQuote));
      if (streamed) alt.classList.add('ars-arrive');
      show(alt);
    }
  };
};

export const renderStructuredSummary = (container: HTMLElement, summary: any, renderQuote?: RenderQuote) =>
  void mountStructuredSummary(container, renderQuote)(summary);

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
  // point's receipts; without it they show as the plain text.
  renderQuote?: RenderQuote;
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
    const hit = findQA(cacheKey, question);
    if (hit) {
      showAnswer(hit.a, hit.searches);
      syncControls();
      return;
    }
    btn.disabled = true;
    btn.textContent = '\u23F3 Fetching reviews\u2026';
    try {
      const reviews = await loadReviews();
      btn.textContent = '\u23F3 Asking\u2026';
      let answer: string, searches: AskSearch[] | undefined;
      if (searchAsk) {
        summaryPanel.style.display = 'block';
        panelMode = 'answer';
        ({ text: answer, searches } = await askReviews(summaryPanel, 'ars-answer', searchAsk, reviews, withContext(questionPrompt, context), question));
      } else {
        answer = await llmSummarize(reviews, `${withContext(questionPrompt, context)}\n\nQuestion: ${question}`, null);
        showAnswer(answer);
      }
      bumpRateLimit();
      saveQA(cacheKey, { q: question, a: answer, ts: Date.now(), searches });
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
// under `cacheKey`.
export const summarizeMatches = (cacheKey: string, opts: Pick<SummarizeWidgetOpts, 'context' | 'searchAsk'> = {}) =>
  (wrapper: HTMLElement, query: string, texts: string[]) => buildSummarizeWidget({
    wrapper,
    cacheKey: `${cacheKey}-kw-${query.toLowerCase()}`,
    summaryPrompt: keywordSummaryPrompt(query),
    fetchReviews: async () => texts,
    questionPlaceholder: `Ask about “${query}” reviews…`,
    ...opts,
  });

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
  // As on buildSummarizeWidget: lets the Ask Search every review first.
  searchAsk?: SearchAsk;
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
        renderAnswer(item.a, item.searches);
        showingSummary = false;
        syncBtn();
      });
      qaRow.append(chip);
    }
  };

  const runAsk = async (question: string) => {
    if (!ask) return;
    const hit = ask.qaCacheKey ? findQA(ask.qaCacheKey, question) : undefined;
    if (hit) { renderAnswer(hit.a, hit.searches); showingSummary = false; syncBtn(); return; }
    btn.disabled = true;
    note(`${p}-progress`, '⏳ Reading reviews…');
    try {
      const texts = await fetchReviews();
      if (!texts.length) throw new Error('No written reviews found yet.');
      let answer: string, searches: AskSearch[] | undefined;
      if (searchAsk) ({ text: answer, searches } = await askReviews(body, `${p}-text`, searchAsk, texts, ask.questionPrompt, question));
      else {
        note(`${p}-progress`, '⏳ Asking…');
        answer = (await llmSummarize(texts, `${ask.questionPrompt}\n\nQuestion: ${question}`, null)) as string;
        renderAnswer(answer);
      }
      bumpRateLimit();
      if (ask.qaCacheKey) saveQA(ask.qaCacheKey, { q: question, a: answer, ts: Date.now(), searches });
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
