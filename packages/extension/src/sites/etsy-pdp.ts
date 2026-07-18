import { addCommas, el, npsColor } from '../shared/utils';
import { cacheGet, cacheSet } from '../shared/cache';
import { createThrottledFetcher } from '../shared/throttled-fetch';
import { renderVariationCard, tallyVariationDims } from '../shared/variation-table';
import { appendStat, buildGauge, buildRecentGauge, createIslandShell, recentPositiveRatio, trendingScore } from '../shared/score-island';
import { setupSpaInjector } from '../shared/spa-injector';
import { buildSummarizeWidget, PRODUCT_SUMMARY_PROMPT } from '../shared/review-summary';
import { buildReviewCard } from '../shared/review-search';
import {
  fetchItemScore,
  fetchRecentReviews,
  fetchTopicReviews,
  fetchVariations,
  listingMeta,
  type EtsyReview,
  type ListingMeta,
  type Topic,
} from '../shared/etsy';

const REVIEWS_TTL = 7 * 24 * 60 * 60 * 1000;
const RECENT_PAGES = 13; // 104 reviews — the newest ones, where variants still exist
const VARIATION_BATCH = 20;

// Postage stops being incidental once it takes a quarter of what the item costs.
// A flat threshold can't say that: €19 on a €200 rug is fine, €4 on a €5 sticker
// is not.
const POSTAGE_WARN_RATIO = 0.25;

const throttledFetch = createThrottledFetcher(8);

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const recentReviews = async (meta: ListingMeta): Promise<EtsyReview[]> => {
  const key = `etsy_reviews_${meta.listingId}`;
  const cached = cacheGet(key, REVIEWS_TTL);
  if (cached) return cached;

  const pages = await Promise.all(
    Array.from({ length: RECENT_PAGES }, (_, i) =>
      fetchRecentReviews(throttledFetch, meta, i + 1).catch((): EtsyReview[] => [])
    )
  );
  const reviews = pages.flat();
  if (reviews.length) cacheSet(key, reviews);
  return reviews;
};

const variationsFor = async (meta: ListingMeta, reviews: EtsyReview[]) => {
  const batches = chunk(reviews.map((r) => r.transactionId), VARIATION_BATCH);
  const maps = await Promise.all(
    batches.map((ids) =>
      fetchVariations(throttledFetch, meta, ids).catch(() => new Map<number, [string, string][]>())
    )
  );
  return new Map(maps.flatMap((m) => [...m]));
};

// One tab per variation dimension (Colour, Size, …), each ranking that
// dimension's values by net sentiment. Etsy keys a review's variations by its
// transaction id.
const buildDims = (reviews: EtsyReview[], variations: Map<number, [string, string][]>) =>
  tallyVariationDims(reviews, {
    variationsOf: (r) => variations.get(r.transactionId) ?? [],
    ratingOf: (r) => r.rating,
  });

const productLd = (): any => {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent ?? '');
      if (parsed?.['@type'] === 'Product') return parsed;
    } catch {}
  }
  return null;
};

// "19,20" and "1,234.56" mean the same shape with the separators swapped: only a
// two-digit tail is a decimal, anything else is a thousands group.
const parseAmount = (raw: string) => {
  const digits = raw.replace(/[^\d.,]/g, '');
  const cut = Math.max(digits.lastIndexOf(','), digits.lastIndexOf('.'));
  if (cut === -1) return Number(digits);
  const fraction = digits.slice(cut + 1);
  if (fraction.length !== 2) return Number(digits.replace(/[.,]/g, ''));
  return Number(`${digits.slice(0, cut).replace(/[.,]/g, '')}.${fraction}`);
};

// Free postage is the only case Etsy states as data — JSON-LD carries a
// shippingRate of 0 and omits the field entirely when postage is charged. The
// charged amount exists only as rendered text, down in the delivery section.
const readPostage = (): { amount: number; text: string } | null => {
  const rate = productLd()?.offers?.shippingDetails?.shippingRate;
  if (rate && Number(rate.value) === 0) return { amount: 0, text: 'Free' };

  const strong = [...document.querySelectorAll('#shipping-and-returns-div strong')].find((s) =>
    s.querySelector('.currency-value')
  );
  if (!strong) return null;

  const amount = parseAmount(strong.querySelector('.currency-value')!.textContent ?? '');
  return Number.isFinite(amount) ? { amount, text: strong.textContent!.replace(/\s+/g, '') } : null;
};

// Free is green; the tone slides through amber and lands on red at the warn
// ratio, reusing the same hue ramp the scores are graded on.
const postageTone = (ratio: number) => npsColor(100 - (ratio / POSTAGE_WARN_RATIO) * 50);

const attachPostage = (stats: HTMLElement) => {
  const price = Number(productLd()?.offers?.price);

  const add = () => {
    const postage = readPostage();
    if (!postage) return false;

    const stat = el('div', 'ars-stat');
    const value = el('span', 'ars-stat-val', postage.text);
    if (price > 0) {
      const ratio = postage.amount / price;
      value.style.color = postageTone(ratio);
      stat.title = `${postage.text} postage — ${Math.round(ratio * 100)}% of the item price`;
    }
    stat.append(value, el('span', 'ars-stat-lbl', 'postage'));
    if (stats.children.length) stats.append(el('div', 'ars-stat-div'));
    stats.append(stat);
    return true;
  };

  // The delivery section is rendered per destination, so it can land after us.
  if (add()) return;
  const observer = new MutationObserver(() => { if (add()) observer.disconnect(); });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 15000);
};

// In the buy box, under the price and above the variant pickers — the score is
// worth reading while deciding, not a scroll away. Etsy's own rating block is
// the fallback for layouts that ship no buy box (sold-out, digital downloads).
const panelAnchor = (): [Element, InsertPosition] | null => {
  const buyBox = document.querySelector('[data-buy-box]');
  if (buyBox) return [buyBox, 'beforebegin'];
  const header = document.querySelector('.reviews-header');
  return header ? [header, 'afterend'] : null;
};

// Etsy tags every review against a fixed aspect vocabulary and pre-tallies the
// sentiment, so this breakdown is free — it arrives with the score. Show the
// most-discussed aspects, ordered best → worst so weak spots settle at the
// bottom where the complaint count flags them.
const TOPIC_MIN_MENTIONS = 8; // below this an aspect is too thin to trust
const TOPIC_MAX_ROWS = 7; // keep the panel scannable

const TOPIC_SUMMARY_PAGES = 10; // ~80 recent aspect reviews — enough to summarize

const topicNps = (t: Topic) => (t.total ? ((t.pos - t.neg) / t.total) * 100 : 0);

const topicSummaryPrompt = (topic: string) =>
  `These are Etsy reviews that mention ${topic} for this product. Focus ONLY on what buyers say about ${topic} — ignore unrelated praise or issues. List what they praise and what they complain about regarding ${topic}, most-common first; include a point only if 2+ reviewers make it. If reviewers disagree, surface the tension. End with a one-line verdict on ${topic}.`;

const topicReviewTexts = async (meta: ListingMeta, tag: string): Promise<string[]> => {
  const pages = await Promise.all(
    Array.from({ length: TOPIC_SUMMARY_PAGES }, (_, i) =>
      fetchTopicReviews(throttledFetch, meta, tag, i + 1).catch((): EtsyReview[] => [])
    )
  );
  return [...new Set(pages.flat().map((r) => r.text).filter(Boolean))];
};

// Lazy: build a topic's detail only when its row is first opened. A scoped
// summarize widget leads — for a mostly-positive item the raw reviews below are
// still mostly 5★ (Etsy's "complaints" are negative sentiment inside otherwise
// glowing reviews), so the summary is what actually extracts them. Then the two
// most-recent pages as raw reviews, no "load more" control.
const fillTopicDetail = (detail: HTMLElement, meta: ListingMeta, t: Topic) => {
  const summaryHost = el('div', 'ars-topic-summary');
  buildSummarizeWidget({
    wrapper: summaryHost,
    cacheKey: `etsy-topic-${meta.listingId}-${t.tag.toLowerCase().replace(/\s+/g, '-')}`,
    summaryPrompt: topicSummaryPrompt(t.name),
    fetchReviews: () => topicReviewTexts(meta, t.tag),
    questionPlaceholder: `Ask about ${t.name.toLowerCase()}…`,
  });

  const list = el('div', 'ars-search-list');
  list.appendChild(el('div', 'ars-topic-loading', 'Loading reviews…'));
  detail.append(summaryHost, list);

  Promise.all([1, 2].map((p) => fetchTopicReviews(throttledFetch, meta, t.tag, p).catch((): EtsyReview[] => [])))
    .then((pages) => {
      const reviews = pages.flat().filter((r) => r.text);
      list.replaceChildren();
      if (!reviews.length) return list.appendChild(el('div', 'ars-search-empty', 'No reviews to show'));
      for (const r of reviews) list.appendChild(buildReviewCard({ rating: r.rating, body: r.text, meta: r.date }, []));
    })
    .catch(() => list.replaceChildren(el('div', 'ars-search-empty', 'Could not load reviews')));
};

const renderTopics = (topics: Topic[], meta: ListingMeta): HTMLElement | null => {
  const shown = topics
    .filter((t) => t.total >= TOPIC_MIN_MENTIONS)
    .sort((a, b) => b.total - a.total)
    .slice(0, TOPIC_MAX_ROWS)
    .sort((a, b) => topicNps(b) - topicNps(a));
  if (shown.length < 2) return null; // a single aspect isn't a breakdown

  const box = el('div', 'ars-topics');
  box.appendChild(el('div', 'ars-topics-title', 'What people mention'));

  let open: HTMLElement | null = null; // one expanded row at a time
  for (const t of shown) {
    const nps = topicNps(t);
    const tone = npsColor(nps);

    const row = el('div', 'ars-topic');
    const btn = el('button', 'ars-topic-btn') as HTMLButtonElement;
    btn.type = 'button';

    const name = el('span', 'ars-topic-name');
    name.appendChild(el('span', 'ars-topic-label', t.name));
    const sub = el('span', 'ars-topic-sub', `${addCommas(t.total)} mentions`);
    if (t.neg >= 5 && t.neg / t.total >= 0.1) {
      sub.appendChild(el('span', 'ars-topic-warn', ` · ${addCommas(t.neg)} complaints`));
    }
    name.append(sub);

    const track = el('span', 'ars-topic-track');
    const fill = el('i', 'ars-topic-fill');
    fill.style.cssText = `width:${Math.max(0, nps)}%;background:${tone}`;
    track.appendChild(fill);

    const pct = el('span', 'ars-topic-pct', `${Math.round(nps)}%`);
    pct.style.color = tone;

    btn.append(name, track, pct);
    row.appendChild(btn);

    const detail = el('div', 'ars-topic-reviews');
    detail.style.display = 'none';
    row.appendChild(detail);

    let loaded = false;
    btn.addEventListener('click', () => {
      const isOpen = detail.style.display !== 'none';
      if (open && open !== detail) {
        open.style.display = 'none';
        (open.previousElementSibling as HTMLElement)?.classList.remove('is-open');
      }
      open = isOpen ? null : detail;
      detail.style.display = isOpen ? 'none' : '';
      btn.classList.toggle('is-open', !isOpen);
      if (!isOpen && !loaded) {
        loaded = true;
        fillTopicDetail(detail, meta, t);
      }
    });

    box.appendChild(row);
  }
  return box;
};

const buildIsland = async (meta: ListingMeta): Promise<HTMLElement | null> => {
  const [score, reviews] = await Promise.all([
    fetchItemScore(throttledFetch, meta.listingId, meta.shopId).catch(() => null),
    recentReviews(meta),
  ]);
  if (!score && !reviews.length) return null;

  const wrapper = createIslandShell();

  // Overall gauge, then the Amazon-style recent-positive one — `reviews` are the
  // newest ~104, so their ratings are the trend the histogram can't show.
  const ratio = recentPositiveRatio(reviews.map((r) => r.rating));
  if (score) {
    const [gauge, gaugeStats] = buildGauge(score);
    wrapper.append(gauge);
    if (ratio != null) wrapper.append(buildRecentGauge(ratio));
    wrapper.append(gaugeStats);
  } else if (ratio != null) {
    wrapper.append(buildRecentGauge(ratio));
  }

  // Postage rides in the stats row: it belongs to the buying decision the panel
  // is already answering, and the row exists even when there is no score.
  let stats = wrapper.querySelector<HTMLElement>('.ars-stats');
  if (!stats) wrapper.appendChild((stats = el('div', 'ars-stats') as HTMLElement));
  if (ratio != null && score) appendStat(stats, addCommas(trendingScore(score.score, ratio)), 'trending');
  attachPostage(stats);

  // Aspect breakdown sits under the headline number: score first, then what
  // people actually say about it, then which variant, then the AI summary.
  if (score?.topics?.length) {
    const topics = renderTopics(score.topics, meta);
    if (topics) wrapper.appendChild(topics);
  }

  // Variations resolve a beat after the reviews they annotate; hold their place
  // so the summariser below doesn't end up above them.
  const variationSlot = document.createElement('div');
  wrapper.appendChild(variationSlot);

  const texts = [...new Set(reviews.map((r) => r.text).filter(Boolean))];
  if (texts.length >= 5) {
    buildSummarizeWidget({
      wrapper,
      cacheKey: `etsy-summary-${meta.listingId}`,
      summaryPrompt: PRODUCT_SUMMARY_PROMPT,
      fetchReviews: async () => texts,
    });
  }
  // Variations resolve a beat after the panel is built; fill the slot once they
  // land, by which point the injector has the island on screen.
  if (reviews.length) {
    variationsFor(meta, reviews)
      .then((variations) => {
        const dims = buildDims(reviews, variations);
        if (!dims.length) return;
        const card = renderVariationCard(dims, { animate: true });
        card.style.maxWidth = '100%';
        card.style.margin = '2px 0 0';
        variationSlot.appendChild(card);
      })
      .catch(() => {});
  }

  return wrapper;
};

// Etsy hydrates the buy box after `document_end`, so the anchor arrives late; the
// injector re-inserts the island once it appears.
setupSpaInjector<HTMLElement>({
  match: () => listingMeta(),
  load: async () => {
    const meta = listingMeta();
    return meta ? buildIsland(meta) : null;
  },
  inject: (wrapper) => {
    const anchor = panelAnchor();
    if (anchor && !document.body.contains(wrapper)) anchor[0].insertAdjacentElement(anchor[1], wrapper);
  },
  cleanup: () => document.querySelectorAll('.ars-wrapper').forEach((node) => node.remove()),
});
