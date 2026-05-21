import { addCommas, el, npsColor } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { buildSummarizeWidget, geminiSummarize, renderFreeFormAnswer } from '../shared/review-summary';

const STAMPED_API_KEY = '8a204db0-ec09-48cf-baed-db3ca2ef99e6';
const STAMPED_STORE = 'bjj-fanatics.myshopify.com';
const REVIEWS_CACHE_MS = 14 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

interface ProductInfo {
  id: string;
  sku: string;
  name: string;
}

interface StampedReview {
  id?: number;
  reviewRating: number;
  reviewTitle?: string;
  reviewMessage?: string;
  reviewOptionsList?: { message?: string; value?: string }[];
}

interface ReviewBundle { total: number; reviews: StampedReview[] }

const getProductInfo = (): ProductInfo | null => {
  const widget = document.getElementById('stamped-main-widget') as HTMLElement | null;
  const id = widget?.dataset.productId || widget?.getAttribute('data-product-id');
  const sku = widget?.dataset.productSku || widget?.getAttribute('data-product-sku');
  const name = widget?.dataset.name || widget?.getAttribute('data-name');
  if (!id || !sku || !name) return null;
  return { id, sku, name };
};

// minRating=1 disables Stamped's silent default filter that hides non-5★ reviews
// from the public widget — without it, total + reviews are missing the 4★/3★/2★ ones.
const stampedUrl = (page: number, info: ProductInfo) =>
  `https://stamped.io/api/widget/reviews?productId=${encodeURIComponent(info.id)}` +
  `&productSKU=${encodeURIComponent(info.sku)}` +
  `&productName=${encodeURIComponent(info.name)}` +
  `&apiKey=${STAMPED_API_KEY}&storeUrl=${STAMPED_STORE}` +
  `&take=${PAGE_SIZE}&page=${page}&sort=recent&minRating=1`;

const fetchPage = async (page: number, info: ProductInfo) => {
  const res = await fetch(stampedUrl(page, info));
  if (!res.ok) return null;
  return res.json() as Promise<{ total?: number; data?: StampedReview[] }>;
};

const dedupeById = (reviews: StampedReview[]): StampedReview[] => {
  const seen = new Set<number | string>();
  const out: StampedReview[] = [];
  for (const r of reviews) {
    const key = r.id ?? `${r.reviewTitle ?? ''}|${r.reviewMessage ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
};

const fetchAllReviews = async (info: ProductInfo): Promise<ReviewBundle> => {
  const cacheKey = `bjj-reviews-${info.id}`;
  const cached = cacheGet(cacheKey, REVIEWS_CACHE_MS) as ReviewBundle | null;

  // Always probe page 1 — gives current `total` plus the newest reviews,
  // so we can detect new reviews and incrementally refresh the cache.
  const first = await fetchPage(1, info);
  if (!first) {
    if (cached) return cached;
    throw new Error('Stamped API unavailable');
  }
  const total = first.total ?? 0;
  const firstData = first.data || [];

  if (cached && cached.total === total && cached.reviews.length) return cached;

  const merged: StampedReview[] = [...firstData];

  // Incremental: a small bump means new reviews fit in page 1 — merge with cache.
  if (cached && total > cached.total && total - cached.total <= PAGE_SIZE) {
    merged.push(...cached.reviews);
    const deduped = dedupeById(merged);
    const bundle = { total, reviews: deduped };
    cacheSet(cacheKey, bundle);
    return bundle;
  }

  // Otherwise refetch the rest in parallel.
  const remaining = Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE)) - 1;
  if (remaining > 0) {
    const rest = await Promise.all(
      Array.from({ length: remaining }, (_, i) => fetchPage(i + 2, info).catch(() => null))
    );
    for (const r of rest) if (r?.data) merged.push(...r.data);
  }

  const deduped = dedupeById(merged);
  const bundle = { total, reviews: deduped };
  if (deduped.length) cacheSet(cacheKey, bundle);
  return bundle;
};

const computeScore = ({ total, reviews }: ReviewBundle) => {
  let five = 0, one = 0;
  for (const r of reviews) {
    if (r.reviewRating === 5) five++;
    else if (r.reviewRating === 1) one++;
  }
  const denom = total || reviews.length;
  if (!denom) return null;
  const ratio = (five - one) / denom;
  const nps = ratio * 100;
  const score = Math.round((five - one) * ratio);
  return { score, ratio, nps, total: denom };
};

const MIN_REVIEW_CHARS = 20;

const reviewToText = (r: StampedReview): string => {
  const head = [r.reviewTitle, r.reviewMessage].filter(Boolean).join(': ').trim();
  if (head.length < MIN_REVIEW_CHARS) return '';
  const meta = (r.reviewOptionsList || [])
    .map(o => o.message && o.value ? `${o.message}: ${o.value}` : '')
    .filter(Boolean)
    .join(' | ');
  return [meta && `[${meta}]`, head].filter(Boolean).join(' ').trim();
};

const reviewHaystack = (r: StampedReview) =>
  [r.reviewTitle, r.reviewMessage, ...(r.reviewOptionsList || []).map(o => o.value)]
    .filter(Boolean).join(' ').toLowerCase();

const appendHighlighted = (parent: HTMLElement, text: string, query: string) => {
  if (!query) { parent.appendChild(document.createTextNode(text)); return; }
  const needle = query.toLowerCase();
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) { parent.appendChild(document.createTextNode(text.slice(i))); return; }
    if (idx > i) parent.appendChild(document.createTextNode(text.slice(i, idx)));
    parent.appendChild(el('mark', 'ars-search-hl', text.slice(idx, idx + needle.length)));
    i = idx + needle.length;
  }
};

const MAX_RENDERED_RESULTS = 50;
const SEARCH_DEBOUNCE_MS = 120;

const buildReviewCard = (r: StampedReview, query: string) => {
  const card = el('div', 'ars-search-review');
  const head = el('div', 'ars-search-review-head');
  const rating = Math.max(0, Math.min(5, Math.round(r.reviewRating || 0)));
  head.appendChild(el('span', 'ars-search-stars', '★'.repeat(rating) + '☆'.repeat(5 - rating)));
  const meta = (r.reviewOptionsList || []).map(o => o.value).filter(Boolean).join(' · ');
  if (meta) head.appendChild(el('span', 'ars-search-meta', meta));
  card.appendChild(head);
  if (r.reviewTitle) {
    const title = el('div', 'ars-search-title');
    appendHighlighted(title, r.reviewTitle, query);
    card.appendChild(title);
  }
  if (r.reviewMessage) {
    const body = el('div', 'ars-search-body');
    appendHighlighted(body, r.reviewMessage, query);
    card.appendChild(body);
  }
  return card;
};

const buildSearchSection = (wrapper: HTMLElement, bundle: ReviewBundle) => {
  const section = el('div', 'ars-search-section');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ars-search-input';
  input.placeholder = `Search ${addCommas(bundle.reviews.length)} reviews… (e.g. "guard")`;
  section.appendChild(input);

  const header = el('div', 'ars-search-header');
  header.style.display = 'none';
  const scoreChip = el('span', 'ars-search-score');
  const summary = el('span', 'ars-search-summary');
  const sumBtn = el('button', 'ars-summarize-btn ars-search-sum-btn', '✦ Summarize') as HTMLButtonElement;
  sumBtn.type = 'button';
  header.append(scoreChip, summary, sumBtn);
  section.appendChild(header);

  const sumPanel = el('div', 'ars-summary-panel ars-search-sum-panel');
  sumPanel.style.display = 'none';
  section.appendChild(sumPanel);

  const list = el('div', 'ars-search-list');
  list.style.display = 'none';
  section.appendChild(list);

  const summaryCache = new Map<string, string>();
  let timer: number | null = null;
  let currentQuery = '';

  const hideSummary = () => {
    sumPanel.style.display = 'none';
    sumPanel.textContent = '';
    sumBtn.disabled = false;
    sumBtn.textContent = '✦ Summarize';
  };

  const renderCached = (query: string, text: string) => {
    sumPanel.style.display = 'block';
    renderFreeFormAnswer(sumPanel, text);
    sumBtn.disabled = false;
    sumBtn.textContent = `Re-summarize "${query}"`;
  };

  sumBtn.addEventListener('click', async () => {
    const query = currentQuery;
    if (!query) return;
    const matches = bundle.reviews.filter(r => reviewHaystack(r).includes(query.toLowerCase()));
    const texts = matches.map(reviewToText).filter(Boolean);
    if (!texts.length) {
      sumPanel.style.display = 'block';
      sumPanel.textContent = 'No review text to summarize';
      return;
    }
    sumBtn.disabled = true;
    sumBtn.textContent = '⏳ Summarizing…';
    sumPanel.style.display = 'block';
    sumPanel.textContent = 'Summarizing…';
    try {
      const text = await geminiSummarize(texts, FILTERED_SUMMARY_PROMPT, null);
      summaryCache.set(query.toLowerCase(), text);
      if (currentQuery !== query) return;
      renderCached(query, text);
    } catch (e: any) {
      sumPanel.textContent = `Error: ${e.message || 'Summarization failed'}`;
      sumBtn.disabled = false;
      sumBtn.textContent = `Retry "${query}"`;
    }
  });

  const render = () => {
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    currentQuery = raw;
    if (!q) {
      header.style.display = 'none';
      list.style.display = 'none';
      hideSummary();
      return;
    }
    const matches = bundle.reviews.filter(r => reviewHaystack(r).includes(q));

    header.style.display = '';
    list.style.display = '';
    summary.textContent = '';
    summary.append(
      el('span', 'ars-search-count', addCommas(matches.length)),
      document.createTextNode(` of ${addCommas(bundle.reviews.length)} reviews mention "${raw}"`),
    );

    const scored = matches.length ? computeScore({ total: matches.length, reviews: matches }) : null;
    if (scored) {
      const pct = Math.round(scored.nps);
      scoreChip.textContent = `${pct}%`;
      scoreChip.style.color = npsColor(scored.nps);
      scoreChip.style.display = '';
    } else {
      scoreChip.style.display = 'none';
    }

    sumBtn.disabled = matches.length === 0;
    const cached = summaryCache.get(q);
    if (cached) renderCached(raw, cached);
    else hideSummary();
    if (matches.length) sumBtn.textContent = cached ? `Re-summarize "${raw}"` : `✦ Summarize "${raw}"`;

    list.textContent = '';
    if (!matches.length) {
      list.appendChild(el('div', 'ars-search-empty', 'No matching reviews'));
      return;
    }
    const shown = matches.slice(0, MAX_RENDERED_RESULTS);
    for (const r of shown) list.appendChild(buildReviewCard(r, raw));
    if (matches.length > shown.length) {
      list.appendChild(el('div', 'ars-search-truncated',
        `Showing first ${shown.length} — refine the search to see more.`));
    }
  };

  input.addEventListener('input', () => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(render, SEARCH_DEBOUNCE_MS) as unknown as number;
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      e.stopPropagation();
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input.focus();
      input.select();
    }
  }, true);

  wrapper.appendChild(section);
};

const SUMMARY_PROMPT = `Analyze these reviews of a BJJ instructional course. Ignore shipping, delivery, packaging, or seller issues — focus ONLY on the course content and instruction.

ONLY include points mentioned by 3+ reviewers. Rank by frequency (most mentioned first). Each bullet should start with the count, e.g. "(12) Volume 3 (back attacks chapter) — most actionable".

BE AS SPECIFIC AS POSSIBLE. Cite concrete volumes, parts, chapters, sections, positions, techniques, sweeps, submissions, or drills by name when reviewers mention them. Generic praise like "great instruction" or generic complaints like "too long" are useless — skip them. Aim for: which volume/part is most valuable, which specific techniques reviewers say worked for them in rolling, which chapters reviewers say to skip or revisit, and which positions get the deepest coverage.

Surface the actual takeaways — what reviewers say they learned, what mental models or principles changed how they roll, what details unlocked a position, what technique they immediately added to their game. The single most important thing reviewers say a viewer should walk away with belongs in the conclusion.

Each review may be prefixed with [Ranking: BLUE | How old are you?: 33-40 | How many years have you been training BJJ?: 1-3]. Use this to note which skill levels found which sections useful.

If 2+ reviewers mention a specific better alternative course or instructor by name, note it and explain how reviewers compare.

The conclusion is the most important field — write it like a buying verdict, not an essay. Lead with the bottom line: buy or skip, and for whom. Then the single most important takeaway reviewers walked away with, what to watch first, and what this course doesn't deliver so the reader knows when to pass. Be punchy and decisive, cite specific techniques and volumes by name, no hedging like "many reviewers say". Format however reads best — a few short paragraphs, bolded leads, or short bullets are all fine.`;

const FILTERED_SUMMARY_PROMPT = `Summarize these BJJ instructional course reviews. Lead with the bottom line — what most reviewers walk away with. Cite specific volumes, parts, chapters, techniques, sweeps, or positions by name when reviewers mention them. Ignore shipping, delivery, packaging, and seller issues — focus only on the course content. Be punchy and decisive, no hedging. A few short paragraphs or bullets are fine.`;

const renderScoreCard = (wrapper: HTMLElement, score: number, nps: number, total: number) => {
  const card = document.createElement('a');
  card.className = 'ars-gauge';
  card.href = '#stamped-main-widget';

  const color = npsColor(nps);
  const pct = Math.round(nps);

  const label = el('div', 'ars-gauge-label');
  const pctEl = el('span', 'ars-gauge-pct', `${pct}%`);
  pctEl.style.color = color;
  label.append(pctEl, document.createTextNode(' positive sentiment'));
  card.appendChild(label);

  const track = el('div', 'ars-gauge-track');
  const fill = el('div', 'ars-gauge-fill');
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, nps / 100))})`;
  fill.style.background = color;
  track.appendChild(fill);
  card.appendChild(track);

  const stats = el('div', 'ars-stats');
  const scoreStat = el('div', 'ars-stat');
  scoreStat.append(el('span', 'ars-stat-val', addCommas(score)), el('span', 'ars-stat-lbl', 'truescore'));
  const reviewsStat = el('div', 'ars-stat');
  reviewsStat.append(el('span', 'ars-stat-val', addCommas(total)), el('span', 'ars-stat-lbl', 'reviews'));
  stats.append(scoreStat, el('div', 'ars-stat-div'), reviewsStat);

  wrapper.append(card, stats);
};

const buildPanel = (
  info: ProductInfo,
  bundle: ReviewBundle,
  scored: { score: number; nps: number; total: number },
  courseContent: string,
) => {
  const wrapper = el('div', 'ars-wrapper');

  const header = el('div', 'ars-header');
  const accent = el('span', 'ars-header-accent');
  accent.textContent = '◈';
  header.append(accent, document.createTextNode(' Review Intelligence'));
  wrapper.appendChild(header);

  renderScoreCard(wrapper, scored.score, scored.nps, scored.total);

  buildSearchSection(wrapper, bundle);

  buildSummarizeWidget({
    wrapper,
    cacheKey: `bjj-summary-${info.id}`,
    summaryPrompt: courseContent
      ? `${SUMMARY_PROMPT}\n\nCOURSE CONTENTS — the official volume/chapter breakdown with timestamps. Use it to translate vague reviewer references ("the leg lock part", "volume 3") into specific named chapters, and to judge which advertised sections reviewers actually praise or skip:\n\n${courseContent}`
      : SUMMARY_PROMPT,
    fetchReviews: async () => bundle.reviews.map(reviewToText).filter(Boolean),
    skipSuspicious: true,
    autoSummarize: true,
  });

  return wrapper;
};

const findAnchor = (): Element | null =>
  document.querySelector('.product-title__wrapper') ||
  document.querySelector('h1.product-title')?.parentElement ||
  document.getElementById('stamped-main-widget');

// BJJ Fanatics ships the per-volume chapter/timestamp tables collapsed behind
// accordions. Force every one open by replicating the site's own open-state class.
const openCourseAccordions = () => {
  for (const title of document.querySelectorAll('.product__course-title')) {
    title.classList.add('product__course-title--opened');
  }
};

// Flatten the per-volume chapter/timestamp tables into plain text so the
// summarizer can map vague reviewer mentions to specific volumes and chapters.
const getCourseContent = (): string => {
  const root = document.getElementById('contents');
  if (!root) return '';
  const blocks: string[] = [];
  for (const title of root.querySelectorAll('.product__course-title')) {
    const rows = Array.from(title.nextElementSibling?.querySelectorAll('table tr') || [])
      .map((tr) =>
        Array.from(tr.querySelectorAll('td'))
          .map((td) => td.textContent?.trim().replace(/\s+/g, ' '))
          .filter(Boolean)
          .join('  —  '))
      .filter(Boolean);
    if (rows.length) blocks.push(`${title.textContent?.trim()}\n${rows.join('\n')}`);
  }
  return blocks.join('\n\n');
};

openCourseAccordions();

(async function main() {
  if (document.querySelector('.ars-wrapper')) return;
  const info = getProductInfo();
  if (!info) return;

  const anchor = findAnchor();
  if (!anchor) return;

  const courseContent = getCourseContent();

  const render = (bundle: ReviewBundle) => {
    const scored = computeScore(bundle);
    if (!scored || scored.total < 5) return;
    document.querySelector('.ars-wrapper')?.remove();
    anchor.after(buildPanel(info, bundle, scored, courseContent));
  };

  // Paint instantly from cache; the Stamped API is cold-start slow (~9s first
  // hit), so blocking the panel on it makes the widget feel absent.
  const cached = cacheGet(`bjj-reviews-${info.id}`, REVIEWS_CACHE_MS) as ReviewBundle | null;
  if (cached?.reviews.length) render(cached);

  // Then confirm against the API in the background, re-rendering only if the
  // review count actually moved since the cached snapshot.
  try {
    const fresh = await fetchAllReviews(info);
    if (!cached || fresh.total !== cached.total) render(fresh);
  } catch {}
})();
