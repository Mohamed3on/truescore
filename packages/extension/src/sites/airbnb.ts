import { addCommas } from '../shared/utils';

let hasRun = false;

const getNumberOfReviews = (ratingsDescription: Element | null): number => {
  if (!ratingsDescription) return 0;
  const match = ratingsDescription.textContent?.match(/(\d+) reviews/);
  return match ? parseInt(match[1], 10) : 0;
};

const getScore = (ratingElements: NodeListOf<Element>) => {
  const ratingDetails = Array.from(ratingElements).map(el => parseInt((el as HTMLElement).style.width, 10));
  const ratio = (ratingDetails[0] - ratingDetails[4]) / 100;
  const ratingsDescription = document.querySelector('h2.hpipapi[elementtiming="LCP-target"] > span');
  const numberOfReviews = getNumberOfReviews(ratingsDescription);
  const score = Math.round(numberOfReviews * ratio * ratio);
  const newDiv = document.createElement('div');
  newDiv.textContent = `${addCommas(score)} (${Math.round(ratio * 100)}%)`;
  const h1 = document.querySelector('h1');
  if (h1) h1.parentNode!.insertBefore(newDiv, h1.nextSibling);
};

new MutationObserver(function () {
  const ratingElements = document.querySelectorAll('div.i5cdxym');
  if (ratingElements.length && !hasRun) {
    getScore(ratingElements);
    hasRun = true;
  }
}).observe(document.body, { childList: true, subtree: true });
