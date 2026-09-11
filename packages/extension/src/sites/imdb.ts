import { netScore } from '@truescore/gmaps-shared';
import { addCommas } from '../shared/utils';

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
