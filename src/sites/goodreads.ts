import { addCommas } from '../shared/utils';

const getNextData = () => {
  const script = document.querySelector('#__NEXT_DATA__');
  if (!script) return null;
  try { return JSON.parse(script.textContent!); } catch { return null; }
};

const getWorkId = (nextData: any) => {
  const apolloState = nextData?.props?.pageProps?.apolloState;
  if (!apolloState) return null;
  const workKey = Object.keys(apolloState).find(k => k.startsWith('Work:kca://work/'));
  return workKey ? workKey.replace('Work:', '') : null;
};

const getJwtToken = (nextData: any) => nextData?.props?.pageProps?.jwtToken;

const fetchRecentRatings = async (workId: string, jwtToken: string) => {
  const response = await fetch(
    'https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: jwtToken },
      body: JSON.stringify({
        operationName: 'getReviews',
        variables: {
          filters: { resourceType: 'WORK', resourceId: workId, sort: 'NEWEST' },
          pagination: { limit: 100 },
        },
        query: `query getReviews($filters: BookReviewsFilterInput!, $pagination: PaginationInput) {
          getReviews(filters: $filters, pagination: $pagination) {
            edges { node { rating createdAt } }
          }
        }`,
      }),
    }
  );
  const data = await response.json();
  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  return (
    data?.data?.getReviews?.edges
      ?.map((e: any) => e.node)
      .filter((n: any) => n.rating && n.createdAt >= oneYearAgo)
      .map((n: any) => n.rating) || []
  );
};

const calculateRecentScore = (ratings: number[]) => {
  if (!ratings.length) return null;
  let scoreAbsolute = 0;
  for (const r of ratings) {
    if (r === 5) scoreAbsolute++;
    if (r === 1) scoreAbsolute--;
  }
  const ratio = scoreAbsolute / ratings.length;
  const score = Math.round(scoreAbsolute * ratio);
  return { score, ratio };
};

const getScoreData = () => {
  const fiveStarRatings = parseInt(
    document.querySelector('[data-testid="labelTotal-5"]')!.textContent!.match(/^[^\(]+/)![0].replace(/,|\s/g, ''), 10
  );
  const oneStarRatings = parseInt(
    document.querySelector('[data-testid="labelTotal-1"]')!.textContent!.match(/^[^\(]+/)![0].replace(/,|\s/g, ''), 10
  );
  const totalRatings = parseInt(
    document.querySelector('[data-testid="ratingsCount"]')!.textContent!.match(/^(\d+|\d{1,3}(,\d{3})*)(\.\d+)?(?=\s+ratings)/)![0].replace(/,/g, ''), 10
  );
  const scoreAbsolute = fiveStarRatings - oneStarRatings;
  const ratio = scoreAbsolute / totalRatings;
  const score = Math.round(scoreAbsolute * ratio);
  return { score, ratio };
};

const appendScore = async (bookTitle: Element) => {
  const { score, ratio } = getScoreData();
  const scoreElement = document.createElement('h1');
  scoreElement.textContent = `${addCommas(score)} (${Math.round(ratio * 100)}%)`;
  bookTitle.parentNode!.insertBefore(scoreElement, bookTitle.nextSibling);

  const nextData = getNextData();
  const workId = getWorkId(nextData);
  const jwtToken = getJwtToken(nextData);

  if (workId && jwtToken) {
    const recentElement = document.createElement('div');
    recentElement.style.cssText = 'font-size: 16px; margin-top: 4px; color: #666;';
    recentElement.textContent = 'Recent: loading...';
    scoreElement.parentNode!.insertBefore(recentElement, scoreElement.nextSibling);

    try {
      const ratings = await fetchRecentRatings(workId, jwtToken);
      const recentScore = calculateRecentScore(ratings);
      recentElement.textContent = recentScore ? `Recent: ${Math.round(recentScore.ratio * 100)}%` : 'Recent: N/A';
    } catch (err) {
      recentElement.textContent = 'Recent: failed to load';
      console.error('Failed to fetch recent ratings:', err);
    }
  }
};

const init = () => {
  const bookTitle = document.querySelector('[data-testid="bookTitle"]');
  const labelTotal5 = document.querySelector('[data-testid="labelTotal-5"]');

  if (bookTitle && labelTotal5) { appendScore(bookTitle); return; }

  const observer = new MutationObserver(() => {
    const bookTitle = document.querySelector('[data-testid="bookTitle"]');
    const labelTotal5 = document.querySelector('[data-testid="labelTotal-5"]');
    if (bookTitle && labelTotal5) { appendScore(bookTitle); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
};

init();
