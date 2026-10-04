import { addCommas, el } from '../shared/utils';
import { airbnbStats, type AirbnbStats } from '../shared/airbnb-stats';
import { getActiveLLM } from '../shared/config';
import { betterAlternativeRule, buildSummarizeWidget } from '../shared/review-summary';
import { createIslandShell } from '../shared/score-island';
import { fetchAirbnbReviewSample } from './airbnb-reviews';

// The listing score sits in a distinct panel near Airbnb's own rating. Its
// working opens on hover or keyboard focus.
const STYLES = `
  .ts-air-score { position: relative; display: inline-grid; grid-template-columns: auto auto; align-items: center; column-gap: 24px; row-gap: 2px; max-width: 100%; box-sizing: border-box; padding: 13px 16px; border: 1px solid #cce5d2; border-left: 4px solid #247a43; border-radius: 12px; background: #f3faf5; color: #173e2b; font-variant-numeric: tabular-nums; cursor: default; }
  .ts-air-label { font-size: 11px; line-height: 15px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .ts-air-value { grid-column: 2; grid-row: 1 / 3; font-size: 32px; line-height: 1; font-weight: 750; }
  .ts-air-meta { font-size: 14px; line-height: 19px; color: #42624c; }
  .ts-air-score[data-tone="negative"] { border-color: #f0cece; border-left-color: #b44444; background: #fff6f6; color: #742727; }
  .ts-air-score[data-tone="negative"] .ts-air-meta { color: #815353; }
  .ts-air-score:focus-visible { outline: 3px solid #247a43; outline-offset: 3px; }
  .ts-air-caption { margin-top: 12px; }
  .ts-air-card {
    position: absolute;
    top: calc(100% + 10px);
    left: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: max-content;
    max-width: 280px;
    padding: 12px 16px;
    background: #fff;
    border-radius: 12px;
    text-align: left;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .04), 0 6px 20px rgba(0, 0, 0, .14);
    opacity: 0;
    transform: translateY(-4px) scale(.97);
    transform-origin: top left;
    pointer-events: none;
    transition: opacity 100ms ease-out, transform 100ms ease-out;
  }
  .ts-air-score:is(:hover, :focus-visible) .ts-air-card {
    opacity: 1;
    transform: none;
    transition: opacity 160ms cubic-bezier(.23, 1, .32, 1) 80ms, transform 160ms cubic-bezier(.23, 1, .32, 1) 80ms;
  }
  .ts-air-card-head { font-size: 16px; line-height: 20px; font-weight: 600; color: #222; }
  .ts-air-card-work { font-size: 14px; line-height: 18px; font-weight: 400; color: #6a6a6a; text-wrap: balance; }
  .ts-air-reviews { box-sizing: border-box; width: 100%; margin: 18px 0 0; }
  .ts-air-reviews-note { color: #78716c; font-size: 12px; line-height: 1.5; }
  .ts-air-reviews .ars-receipt-quotes { box-sizing: border-box; width: min(100%, 72ch); max-height: 26rem; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .ts-air-reviews .ars-receipt-quote { overflow-wrap: anywhere; }
  @media (max-width: 520px) { .ts-air-reviews .ars-question-row { flex-wrap: wrap; } .ts-air-reviews .ars-question-input { flex-basis: 100%; } }
  @media (prefers-reduced-motion: reduce) { .ts-air-card { transform: none !important; } }
`;

const SUMMARY_PROMPT = `Analyze this Airbnb listing's guest reviews. The sample deliberately includes the lowest-rated reviews and Airbnb's most relevant reviews; each review begins with its star rating.

Focus especially on recurring complaints in the low-rated reviews. Identify specific problems with the room, cleanliness, sleep, noise, amenities, host, check-in, location, or value. Include a complaint only when at least two independent guests describe it; distinguish a repeated pattern from a single bad stay. If guests disagree, say so. Rank complaints by how often and how seriously they affect a stay.

Also cover the concrete positives that guests repeatedly describe, drawing from the whole sample. Avoid generic praise. Do not let the larger number of five-star reviews drown out substantiated complaints. Do not claim this sample represents every review or infer a percentage from it.

${betterAlternativeRule('nearby Airbnb stay')}

Conclusion: 2–4 sentences on who this stay suits, its strongest recurring qualities, and the main repeated issue to check before booking. If few low-rated reviews have written comments, say that the evidence for complaints is limited.`;

const buildScore = ({ count, five, one, score }: AirbnbStats) => {
  const card = el('span', 'ts-air-card');
  card.append(
    el('span', 'ts-air-card-head', `TrueScore ${addCommas(score)}`),
    el('span', 'ts-air-card-work', `Net loved: 5★ minus 1★, over all ${addCommas(count)} reviews`),
    el('span', 'ts-air-card-work', `(${addCommas(five)} − ${addCommas(one)})² ÷ ${addCommas(count)} reviews = ${addCommas(score)}`),
  );
  const item = el('div', 'ts-air-score');
  item.dataset.tone = five < one ? 'negative' : 'positive';
  item.setAttribute('role', 'group');
  item.tabIndex = 0;
  item.append(
    el('span', 'ts-air-label', 'TrueScore'),
    el('strong', 'ts-air-value', addCommas(score)),
    el('span', 'ts-air-meta', `${Math.round(((five - one) / count) * 100)}% net loved · ${addCommas(count)} reviews`),
    card,
  );
  return item;
};

// Keep the score beside the overview rather than tucked into the host rating line.
const place = (item: HTMLElement): boolean => {
  const banner = document.querySelector('[data-section-id="GUEST_FAVORITE_BANNER"]');
  if (banner?.textContent?.trim()) {
    const caption = el('div', 'ts-air-caption');
    caption.append(item);
    banner.append(caption);
    return true;
  }
  const overview = document.querySelector('[data-section-id="OVERVIEW_DEFAULT_V2"]');
  if (overview) {
    const caption = el('div', 'ts-air-caption');
    caption.append(item);
    overview.append(caption);
    return true;
  }
  return false;
};

const style = document.createElement('style');
style.textContent = STYLES;
document.head.append(style);

const stats = airbnbStats(document.getElementById('data-deferred-state-0')?.textContent || 'null');
if (stats) {
  const item = buildScore(stats);
  if (!place(item)) {
    const observer = new MutationObserver(() => { if (place(item)) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

const listingId = location.pathname.match(/^\/rooms\/(\d+)/)?.[1];
if (listingId) {
  const wrapper = createIslandShell();
  wrapper.classList.add('ts-air-reviews');
  const note = el('div', 'ts-air-reviews-note', 'Loading up to 100 guest reviews, including the lowest rated…');
  wrapper.append(note);
  let pendingReviews: ReturnType<typeof fetchAirbnbReviewSample> | null = null;
  const loadReviewSample = () => {
    pendingReviews ??= fetchAirbnbReviewSample(listingId).then((sample) => {
      note.textContent = `Read ${sample.sampled} written reviews, including ${sample.lowRated} below five stars, from ${addCommas(sample.total)} total reviews.`;
      return sample;
    }).catch((error) => {
      pendingReviews = null;
      note.textContent = 'Reviews could not be loaded. Summarize will retry.';
      throw error;
    });
    return pendingReviews;
  };
  buildSummarizeWidget({
    wrapper,
    cacheKey: `airbnb-summary-v2-${listingId}`,
    summaryPrompt: SUMMARY_PROMPT,
    questionPlaceholder: 'Ask about this stay…',
    questionPrompt: 'Answer using only these Airbnb guest reviews. Give concrete details, pay attention to low-rated reviews, and note when guests disagree.',
    fetchReviews: async () => {
      if (!(await getActiveLLM()).key) throw new Error('Set an AI key in the TrueScore popup to summarize reviews.');
      const sample = await loadReviewSample();
      return sample.texts;
    },
  });
  const mountReviews = (): boolean => {
    const section = document.querySelector('[data-section-id="REVIEWS_DEFAULT"]');
    if (!section) return false;
    section.before(wrapper);
    return true;
  };
  if (!mountReviews()) {
    const observer = new MutationObserver(() => { if (mountReviews()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  void loadReviewSample().catch(() => {});
}
