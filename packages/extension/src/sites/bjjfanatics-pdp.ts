import { addCommas, el, npsColor } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { buildSummarizeWidget } from '../shared/review-summary';

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

const reviewToText = (r: StampedReview): string => {
  const meta = (r.reviewOptionsList || [])
    .map(o => o.message && o.value ? `${o.message}: ${o.value}` : '')
    .filter(Boolean)
    .join(' | ');
  const head = [r.reviewTitle, r.reviewMessage].filter(Boolean).join(': ').trim();
  return [meta && `[${meta}]`, head].filter(Boolean).join(' ').trim();
};

const SUMMARY_PROMPT = `Analyze these reviews of a BJJ instructional course. Ignore shipping, delivery, packaging, or seller issues — focus ONLY on the course content and instruction.

ONLY include points mentioned by 3+ reviewers. Rank by frequency (most mentioned first). Each bullet should start with the count, e.g. "(12) Volume 3 (back attacks chapter) — most actionable".

BE AS SPECIFIC AS POSSIBLE. Cite concrete volumes, parts, chapters, sections, positions, techniques, sweeps, submissions, or drills by name when reviewers mention them. Generic praise like "great instruction" or generic complaints like "too long" are useless — skip them. Aim for: which volume/part is most valuable, which specific techniques reviewers say worked for them in rolling, which chapters reviewers say to skip or revisit, and which positions get the deepest coverage.

Each review may be prefixed with [Ranking: BLUE | How old are you?: 33-40 | How many years have you been training BJJ?: 1-3]. Use this to note which skill levels found which sections useful.

If 2+ reviewers mention a specific better alternative course or instructor by name, note it and explain how reviewers compare.

End with a short summary: who this course is best for (skill level, goals), which volumes/parts to prioritize first, weak spots, and whether it's worth the price.`;

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

const buildPanel = (info: ProductInfo, bundle: ReviewBundle, scored: { score: number; nps: number; total: number }) => {
  const wrapper = el('div', 'ars-wrapper');

  const header = el('div', 'ars-header');
  const accent = el('span', 'ars-header-accent');
  accent.textContent = '◈';
  header.append(accent, document.createTextNode(' Review Intelligence'));
  wrapper.appendChild(header);

  renderScoreCard(wrapper, scored.score, scored.nps, scored.total);

  buildSummarizeWidget({
    wrapper,
    cacheKey: `bjj-summary-${info.id}`,
    summaryPrompt: SUMMARY_PROMPT,
    fetchReviews: async () => bundle.reviews.map(reviewToText).filter(Boolean),
    skipSuspicious: true,
  });

  return wrapper;
};

const findAnchor = (): Element | null =>
  document.querySelector('.product-title__wrapper') ||
  document.querySelector('h1.product-title')?.parentElement ||
  document.getElementById('stamped-main-widget');

(async function main() {
  if (document.querySelector('.ars-wrapper')) return;
  const info = getProductInfo();
  if (!info) return;

  const anchor = findAnchor();
  if (!anchor) return;

  let bundle: ReviewBundle;
  try {
    bundle = await fetchAllReviews(info);
  } catch {
    return;
  }
  const scored = computeScore(bundle);
  if (!scored || scored.total < 5) return;

  const panel = buildPanel(info, bundle, scored);
  anchor.after(panel);
})();
