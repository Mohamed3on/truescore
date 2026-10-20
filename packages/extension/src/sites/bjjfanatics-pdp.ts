import { addCommas, el, npsColor } from '../shared/utils';
import { courseContext, SUMMARY_PROMPT } from './bjjfanatics-prompt';
import { buildReviewPanel } from '../shared/review-panel';
import { createIslandShell } from '../shared/score-island';
import { BJJ_FANATICS, computeScore, getProductInfo, loadReviews, reviewToText, type ProductInfo, type ReviewBundle, type StampedReview } from '../shared/stamped';

// A reviewer's answers as a card's meta line reads them: "Blue belt · age 26-32 · 1-3 yrs training".
const optionText = ({ message = '', value = '' }: { message?: string; value?: string }) =>
  /rank|belt/i.test(message) ? `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()} belt`
  : /years/i.test(message) ? `${value} yrs training`
  : /old|age/i.test(message) ? `age ${value}`
  : value;

const cardFields = (r: StampedReview) => ({
  rating: r.reviewRating,
  title: r.reviewTitle,
  body: r.reviewMessage,
  meta: (r.reviewOptionsList || []).filter(o => o.value).map(optionText).join(' · '),
});

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
  autoSummarize: boolean | Promise<boolean>,
) => {
  const wrapper = createIslandShell();

  renderScoreCard(wrapper, scored.score, scored.nps, scored.total);

  // Stamped's sample is all a Search reaches. A receipt's reviews show as the
  // search's cards, not the model's "[Ranking: …] Title: body" text.
  buildReviewPanel(wrapper, {
    key: `bjj-summary-${info.id}`,
    total: bundle.reviews.length,
    all: bundle.reviews,
    text: reviewToText,
    card: cardFields,
    exampleQuery: 'guard OR mount',
    summaryPrompt: SUMMARY_PROMPT,
    context: courseContent ? courseContext(courseContent) : undefined,
    autoSummarize,
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

  loadReviews(BJJ_FANATICS, info, (bundle, autoSummarize) => {
    const scored = computeScore(bundle);
    if (!scored || scored.total < 5) return;
    document.querySelector('.ars-wrapper')?.remove();
    anchor.after(buildPanel(info, bundle, scored, courseContent, autoSummarize));
  });
})();
