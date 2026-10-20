import { textReviewsFor, type LlmOverrides, type RemovedReviews, type Review, type Summary, type SummaryDraft } from '@truescore/gmaps-shared';
import { cache, type CacheEntry, type SearchResult } from './cache';
import { hasReceipts, jevAvailable, quotingReviews, withReceipts } from './jev';
import { aliasesFor, summarize } from './llm';
import { resolveSubject, type Subject } from './summary-subject';

// A Place's checked Summary, or a Chip's or a Search's (CONTEXT.md: Summary,
// Receipt), for the three summary routes, which keep only body parsing and
// JSON-vs-stream. One rule for them all: a kept Summary is served unless
// forced, a fresh one is written (drafts to `onDraft`), checked and kept in
// its own slot, so a Chip's or a Search's never lands in the Place's.

// What is summarized beyond the Place: a Chip, a Search (kept only when its
// results are), or a filter, never kept.
export type SummaryOf =
  | { chip: { token: string; label: string; reviews?: Review[] } }
  | { search: SearchResult; keep: boolean }
  | { filter: string };

export type SummaryRequest = {
  featureId: string;
  entry: CacheEntry | undefined;
  of?: SummaryOf;
  // What the caller sent of the Place: the extension's own scrape of one this
  // server may never have looked up.
  sent?: { name?: string; reviewTexts?: string[]; removedReviews?: RemovedReviews | null };
  force?: boolean;
  llm?: LlmOverrides;
  onDraft?: (draft: SummaryDraft) => void;
};

// `later` carries a Place's aliases when they land after its Summary.
export type CheckedSummary = { summary: Summary; cached: boolean; later?: Promise<Summary['aliases']> };

// Chips and summaries cached before Jev read them are read now, once, and kept.
export async function summaryWithReceipts(summary: Summary, subject: Subject | null, keep?: (s: Summary) => Promise<void>): Promise<Summary> {
  if (hasReceipts(summary) || !subject || !jevAvailable()) return summary;
  const checked = await withReceipts(summary, subject);
  if (hasReceipts(checked)) await keep?.(checked);
  return checked;
}
export const cachedSubject = (entry: CacheEntry, reviews = entry.score?.reviews): Subject | null =>
  reviews?.length ? { placeName: entry.name, reviewTexts: textReviewsFor(reviews), removedReviews: entry.meta?.removedReviews } : null;

const LOOK_UP = 'look up the place first or pass reviewTexts in the body';

// Where a Summary is kept and read from. Only a Place's own has aliases, and
// only a Place's quotes the reviews it holds (quotingReviews).
type Slot = { topic?: string; reviews?: Review[]; kept?: Summary; keep?: (s: Summary) => Promise<void>; quote?: Review[]; aliases?: boolean; hint: string };
const slotOf = ({ featureId, entry, of }: SummaryRequest): Slot => {
  const place = { reviews: entry?.score?.reviews, quote: entry?.score?.reviews, hint: LOOK_UP };
  if (!of) return { ...place, kept: entry?.summary, keep: entry && ((s: Summary) => cache.putSummary(featureId, s)), aliases: true };
  if ('filter' in of) return { ...place, topic: of.filter };
  if ('chip' in of) {
    const { token, label, reviews } = of.chip;
    return { topic: label, reviews, kept: entry?.highlightSummaries?.[token], keep: entry && ((s: Summary) => cache.putHighlightSummary(featureId, token, s)), hint: 'pass reviewTexts in the body or run highlights first' };
  }
  const { search, keep } = of;
  return { topic: search.query, reviews: search.reviews, kept: search.summary, keep: keep ? (s: Summary) => cache.putSearch(featureId, search.query, { ...search, summary: s }) : undefined, hint: 'search first' };
};

export async function checkedSummary(req: SummaryRequest): Promise<CheckedSummary> {
  const { entry, sent, force, llm = {}, onDraft } = req;
  const { topic, reviews, kept, keep, hint, quote, aliases } = slotOf(req);
  if (kept && !force) {
    const summary = await summaryWithReceipts(kept, entry ? cachedSubject(entry, reviews) : null, keep);
    return { summary: quotingReviews(summary, quote), cached: true };
  }
  const subject = resolveSubject({ entry, name: sent?.name, reviewTexts: sent?.reviewTexts, reviews, removedReviews: sent?.removedReviews, hint });
  // Its receipts are read before it's final: streamed, its bullets show dim
  // until then, and the ones too few reviews make go. A Place's aliases come
  // from a call run beside them: in the Summary when they land first, else
  // sent after it (`later`), never waited on.
  const drafted = await summarize(subject, topic, llm.provider, llm.reasoningEffort, onDraft);
  const writing = aliases ? aliasesFor(subject, drafted.items, llm.provider) : undefined;
  const checked = await withReceipts(drafted, subject);
  const landed = writing && Bun.peek(writing);
  const summary = landed && !(landed instanceof Promise) ? { ...checked, aliases: landed } : checked;
  await keep?.(summary);
  const later = landed instanceof Promise ? landed.then(async (a) => {
    if (a) await keep?.({ ...summary, aliases: a });
    return a;
  }) : undefined;
  return { summary: quotingReviews(summary, quote), cached: false, later };
}
