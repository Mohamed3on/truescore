import { addCommas } from '../shared/utils';

function calculateRatings() {
  if (!window.location.pathname.match(/\/title\/tt\d+\/(maindetails\/?|ratings\/?)?/)) return;

  const ratings: number[] = [];
  for (let i = 1; i <= 10; i++) {
    const bar = document.querySelector(`[data-testid="rating-histogram-bar-${i}"]`);
    const count = parseInt(bar?.getAttribute('aria-label')?.match(/^(\d+)/)?.[1] || '0', 10);
    ratings.push(count);
  }

  const totalRatings = ratings.reduce((sum, c) => sum + c, 0);
  if (totalRatings === 0) return;

  const absoluteScore = ratings[9] + ratings[8] - ratings[0] - ratings[1];
  const ratio = absoluteScore / totalRatings;
  const calculatedScore = Math.round(absoluteScore * ratio);

  const scoreElement = document.createElement('div');
  scoreElement.textContent = `${addCommas(calculatedScore)} (${Math.round(ratio * 100)}%)`;
  scoreElement.style.fontWeight = 'bold';
  scoreElement.style.fontSize = '1.2rem';
  scoreElement.style.color = '#f5c518';

  const headline = document.querySelector('h1');
  if (headline) headline.parentNode!.insertBefore(scoreElement, headline.nextSibling);
}

calculateRatings();
