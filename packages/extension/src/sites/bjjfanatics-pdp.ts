import { addCommas, el, npsColor, npsStats } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { buildSummarizeWidget } from '../shared/review-summary';
import { buildSearchSection } from '../shared/review-search';
import { createIslandShell } from '../shared/score-island';

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
  return { ...npsStats(five, one, denom), total: denom };
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

const cardFields = (r: StampedReview) => ({
  rating: r.reviewRating,
  title: r.reviewTitle,
  body: r.reviewMessage,
  meta: (r.reviewOptionsList || []).map(o => o.value).filter(Boolean).join(' · '),
});

const SUMMARY_PROMPT = `Analyze these reviews of a BJJ instructional course. Ignore shipping, delivery, packaging, or seller issues — focus ONLY on the course content and instruction.

ONLY include points mentioned by 3+ reviewers. Rank by frequency (most mentioned first). Each bullet should be one concrete point, e.g. "Volume 3 (back attacks chapter) — most actionable".

BE AS SPECIFIC AS POSSIBLE. Cite concrete volumes, parts, chapters, sections, positions, techniques, sweeps, submissions, or drills by name when reviewers mention them. Generic praise like "great instruction" or generic complaints like "too long" are useless — skip them. Aim for: which volume/part is most valuable, which specific techniques reviewers say worked for them in rolling, which chapters reviewers say to skip or revisit, and which positions get the deepest coverage.

Surface the actual takeaways — what reviewers say they learned, what mental models or principles changed how they roll, what details unlocked a position, what technique they immediately added to their game. The single most important thing reviewers say a viewer should walk away with belongs in the conclusion.

Each review may be prefixed with [Ranking: BLUE | How old are you?: 33-40 | How many years have you been training BJJ?: 1-3]. Use this to note which skill levels found which sections useful.

If 2+ reviewers mention a specific better alternative course or instructor by name, note it and explain how reviewers compare.

The conclusion is the most important field — write it like a buying verdict, not an essay. Lead with the bottom line: buy or skip, and for whom. Then the single most important takeaway reviewers walked away with, what to watch first, and what this course doesn't deliver so the reader knows when to pass. Be punchy and decisive, cite specific techniques and volumes by name, no hedging like "many reviewers say". Make the most important takeaway concrete — name the specific technique, sweep, grip, or detail a reviewer actually credited (a sweep someone hit, the cue that unlocked a position), not a generic "systematic approach". The verdict may spotlight one such vivid, named detail even if only one or two reviewers mention it, as long as you attribute it honestly — the 3+ threshold governs the ranked bullets, not the verdict's specifics. Use the course contents only to turn a vague reviewer reference ("the darce part") into its real named chapter; never rank or recommend sections reviewers didn't single out, invent chapter contents, or claim the course omits something reviewers didn't say it omits. Format however reads best — a few short paragraphs or short bullets. Use **bold** only on concrete specifics, never on connecting phrases.`;

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
  const wrapper = createIslandShell();

  renderScoreCard(wrapper, scored.score, scored.nps, scored.total);

  buildSearchSection({
    wrapper,
    reviews: bundle.reviews,
    fields: cardFields,
    toText: reviewToText,
    summaryPrompt: FILTERED_SUMMARY_PROMPT,
    exampleQuery: 'guard OR mount',
  });

  buildSummarizeWidget({
    wrapper,
    cacheKey: `bjj-summary-${info.id}`,
    summaryPrompt: SUMMARY_PROMPT,
    context: courseContent
      ? `COURSE CONTENTS — the official volume/part/chapter breakdown. Use it to translate vague reviewer references ("the leg lock part", "volume 3") into specific named chapters, and to judge which advertised sections reviewers actually praise or skip:\n\n${courseContent}`
      : undefined,
    fetchReviews: async () => bundle.reviews.map(reviewToText).filter(Boolean),
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

// Pull the "What Exactly Is On This Series?" breakdown out of the product
// description: each <ul> is a part's technique list, labelled by the "Part N:"
// paragraph right before it. Skips the marketing copy, images, and pricing.
// Used as a fallback for products without the per-volume timestamp tables.
const getDescriptionContents = (): string => {
  const desc = document.querySelector('.product__description');
  if (!desc) return '';
  const blocks: string[] = [];
  for (const ul of desc.querySelectorAll('ul')) {
    const items = Array.from(ul.querySelectorAll('li'))
      .map((li) => li.textContent?.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    if (!items.length) continue;
    const label = ul.previousElementSibling?.textContent?.trim().replace(/\s+/g, ' ') || '';
    blocks.push((label ? `${label}\n` : '') + items.map((i) => `- ${i}`).join('\n'));
  }
  return blocks.join('\n\n');
};

// Flatten the per-volume chapter/timestamp tables into plain text so the
// summarizer can map vague reviewer mentions to specific volumes and chapters.
// Products without those tables (e.g. seated open guard) fall back to the
// "Part N:" breakdown carried in the description.
const getCourseContent = (): string => {
  const root = document.getElementById('contents');
  const blocks: string[] = [];
  for (const title of root?.querySelectorAll('.product__course-title') || []) {
    const rows = Array.from(title.nextElementSibling?.querySelectorAll('table tr') || [])
      .map((tr) =>
        Array.from(tr.querySelectorAll('td'))
          .map((td) => td.textContent?.trim().replace(/\s+/g, ' '))
          .filter(Boolean)
          .join('  —  '))
      .filter(Boolean);
    if (rows.length) blocks.push(`${title.textContent?.trim()}\n${rows.join('\n')}`);
  }
  return blocks.length ? blocks.join('\n\n') : getDescriptionContents();
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
