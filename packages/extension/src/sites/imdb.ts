import { netScore } from '@truescore/gmaps-shared';
import { cacheGetMaybe, cacheSetMaybe } from '../shared/cache';
import { setupScoreGrid } from '../shared/score-grid';
import { addCommas, npsStats } from '../shared/utils';

// Exact vote counts per rating (index 0 = 1★ … 9 = 10★) from IMDb's Next.js page
// data. The ratings chart itself only carries rounded labels ("1.8M Ratings"), and
// the old per-bar test ids are gone. Null when the page doesn't ship a histogram.
const histogramFrom = (doc: Document): number[] | null => {
  try {
    const values = JSON.parse(doc.querySelector('#__NEXT_DATA__')?.textContent || '')
      ?.props?.pageProps?.contentData?.histogramData?.histogramValues;
    if (!Array.isArray(values)) return null;
    const counts: number[] = Array(10).fill(0);
    for (const { rating, voteCount } of values) if (rating >= 1 && rating <= 10) counts[rating - 1] = voteCount || 0;
    return counts;
  } catch {
    return null;
  }
};

async function calculateRatings() {
  const id = window.location.pathname.match(/\/title\/(tt\d+)\/(?:ratings\/?)?$/)?.[1];
  if (!id) return;

  // The title page has no histogram in its data; its ratings page does.
  const ratings = histogramFrom(document)
    ?? histogramFrom(new DOMParser().parseFromString(await (await fetch(`/title/${id}/ratings/`)).text(), 'text/html'));
  const totalRatings = ratings?.reduce((sum, c) => sum + c, 0) ?? 0;
  if (!ratings || totalRatings === 0) return;

  const absoluteScore = ratings[9] + ratings[8] - ratings[0] - ratings[1];
  const ratio = absoluteScore / totalRatings;
  const calculatedScore = netScore(absoluteScore, totalRatings);

  const scoreElement = document.createElement('div');
  scoreElement.textContent = `${addCommas(calculatedScore)} (${Math.round(ratio * 100)}%)`;
  scoreElement.style.fontWeight = 'bold';
  scoreElement.style.fontSize = '1.2rem';
  scoreElement.style.color = '#f5c518';

  const headline = document.querySelector('h1');
  if (headline) headline.parentNode!.insertBefore(scoreElement, headline.nextSibling);
}

calculateRatings().catch(() => {});

// --- "More like this" -------------------------------------------------------
// Badge each recommended title with its score and re-rank the strip by it.
// IMDb's GraphQL answers a whole list of ids in one query, so the cards that ask
// in the same tick share one background call rather than one each.
const CARD_CACHE_TTL = 24 * 60 * 60 * 1000;
let batch: { id: string; resolve: (counts: number[] | null) => void }[] = [];
const flush = async () => {
  const waiting = batch;
  batch = [];
  const histograms: Record<string, number[]> | null = await chrome.runtime
    .sendMessage({ type: 'imdbHistograms', ids: [...new Set(waiting.map((w) => w.id))] })
    .catch(() => null);
  for (const { id, resolve } of waiting) resolve(histograms?.[id] ?? null);
};
const histogram = (id: string) =>
  new Promise<number[] | null>((resolve) => {
    if (!batch.length) setTimeout(flush);
    batch.push({ id, resolve });
  });

const idOf = (card: Element) =>
  card.querySelector('a[href*="/title/tt"]')?.getAttribute('href')?.match(/\/title\/(tt\d+)/)?.[1];

setupScoreGrid({
  cardSelector: '[data-testid="MoreLikeThis"] .ipc-poster-card',
  idOf,
  scoreForCard: async (card) => {
    const id = idOf(card);
    if (!id) return null;
    const key = `nps_imdb_${id}`;
    const cached = cacheGetMaybe(key, CARD_CACHE_TTL);
    if (cached) return cached.value;
    const counts = await histogram(id);
    if (!counts) return null; // transport failure: left uncached so the grid's retry asks again
    const total = counts.reduce((sum, c) => sum + c, 0);
    const score = total ? npsStats(counts[8] + counts[9], counts[0] + counts[1], total) : null;
    cacheSetMaybe(key, score);
    return score;
  },
  // The star row is `nowrap` and overflows on narrow cards, so the badge takes
  // its own line under it, aligned to the row's 8px gutter.
  placeBadge: (card, badge) => {
    badge.style.margin = '0 8px 4px';
    badge.style.alignSelf = 'flex-start';
    card.querySelector('.ipc-poster-card__rating-star-group')?.after(badge);
  },
});
