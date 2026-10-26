import { addCommas, el, isComputed } from './utils';
import { appendStat, buildRecentGauge, fillRecentGauge } from './score-island';
import { adjust, RECENT_REVIEWS, recentRatio } from './recency';
import { buildSummarizeWidget, keywordSummaryPrompt, PRODUCT_SUMMARY_PROMPT, SAMPLE_MAX, summarizeMatches } from './review-summary';
import { buildSearchSection, localSearchAsk, orSearch, quoteCards, runSearch, SEARCH_MAX, searchWith, type SearchReviewFields } from './review-search';
import type { SearchAsk } from './review-ask';

// One description of an Item's reviews, as a retail product page hands it to the
// review panel.
export interface ItemReviews<T> {
  // Where the Summary and Recent questions are kept; each search's sit under it.
  key: string;
  // How many reviews the Item has — or, where a Search reaches only the
  // reviews in hand, how many those are.
  total: number;
  // Every review the site downloads, newest first, up to `allMax` (default
  // SEARCH_MAX) — or how to download them, once a Summary, Ask or receipt
  // needs them (at once where the Search box searches them).
  all: T[] | Promise<T[]> | (() => Promise<T[]>);
  allMax?: number;
  // The newest reviews, landing before `all`, for the recent gauge — left out
  // where the site draws its own — and the Item's score they damp.
  recent?: Promise<T[]>;
  score?: number | null;
  // A review as the model reads it ('' = none to read), and as a card.
  text: (r: T) => string;
  card: (r: T) => SearchReviewFields;
  // The site's own search for one term over every review, for an Item with more
  // than `all` holds; `date` orders an OR query's union, newest first.
  searchTerm?: (term: string) => Promise<{ reviews: T[]; total: number }>;
  date?: (r: T) => string;
  exampleQuery: string;
  summaryPrompt?: string;
  context?: string;
  autoSummarize?: boolean | Promise<boolean>;
}

// Fewer reviews than this make no Search box or Summary.
const MIN_REVIEWS = 5;

// A retail product page's review panel, appended to `host`: the Search box, then
// the Summary and Ask over the Sample — the newest SAMPLE_MAX reviews, each text
// once. A Search runs through the site's own search past `allMax`, else among the
// reviews in hand; an Ask may Search only where that reaches reviews the Sample
// lacks.
export const buildReviewPanel = <T,>(host: HTMLElement, reviews: ItemReviews<T>) => {
  const { key, total, allMax = SEARCH_MAX, recent, score, text, card, searchTerm, date = () => '', summaryPrompt = PRODUCT_SUMMARY_PROMPT, context, autoSummarize } = reviews;
  let loaded: Promise<T[]> | undefined;
  const all = () => (loaded ??= Promise.resolve(isComputed(reviews.all) ? reviews.all() : reviews.all));
  const sample = () => all().then((rs) => [...new Set(rs.slice(0, SAMPLE_MAX).map(text).filter(Boolean))]);

  const remote = searchTerm && total > allMax ? orSearch(searchTerm, { text, date }) : null;
  const reach = remote ? total : Math.min(total, allMax);

  const searchAsk: SearchAsk | undefined = reach <= Math.min(allMax, SAMPLE_MAX) ? undefined
    : remote ? {
      search: searchWith((terms) => remote(terms).then((hit) => hit.matches), text, (r) => card(r).rating),
      open: (query) => runSearch(host, query),
    }
    : localSearchAsk(all(), card, text, host);

  // The newest reviews' share as a gauge, and the score they damp beside the
  // site's own stats.
  let stats: HTMLElement | undefined;

  if (recent) {
    const gauge = buildRecentGauge();
    stats = el('div', 'ars-stats');
    host.append(gauge, stats);
    recent
      .then((rs) => {
        const newest = rs.slice(0, RECENT_REVIEWS);
        const ratio = recentRatio(newest.map((r) => card(r).rating));
        fillRecentGauge(gauge, ratio);

        if (ratio == null) return;

        if (score != null) appendStat(stats!, addCommas(adjust(score, ratio)), 'adjusted');
        appendStat(stats!, String(newest.length), 'analyzed');
      })
      .catch(() => fillRecentGauge(gauge, null));
  }

  if (total < MIN_REVIEWS) return { stats };

  // Between whatever leads the panel and the Summary: at once through the site's
  // own search, else once the reviews in hand land.
  const searchSlot = el('div');
  host.append(searchSlot);

  const mountSearch = (inHand: T[]) => searchSlot.append(buildSearchSection({
    reviews: inHand,
    total: remote ? total : undefined,
    search: remote ?? undefined,
    fields: card,
    toText: text,
    summaryPrompt: keywordSummaryPrompt,
    exampleQuery: reviews.exampleQuery,
    mountSummarize: summarizeMatches(key, { context, searchAsk }),
  }));

  if (remote) mountSearch([]);
  else void all().then((rs) => { if (rs.length) mountSearch(rs); });

  buildSummarizeWidget({
    wrapper: host,
    cacheKey: key,
    summaryPrompt,
    context,
    autoSummarize,
    fetchReviews: sample,
    searchAsk,
    renderQuote: quoteCards(all, text, card),
  });

  return { stats };
};
