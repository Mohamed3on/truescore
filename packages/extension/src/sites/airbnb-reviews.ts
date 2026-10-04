const REVIEWS_HASH = 'cfdc3ffbe997a618795fc5a8f9a9b484054ce9be68c8788cd2ffda999934c5ae';
const PAGE_SIZE = 50; // Airbnb caps a reviews query at 50, even when asked for 100.
const MAX_REVIEW_CHARS = 1500;

type Review = {
  id?: string;
  rating?: number;
  comments?: string | null;
  localizedReview?: { comments?: string | null } | null;
  localizedCommentV2?: { comments?: string | null } | null;
};
type ReviewPage = { reviews: Review[]; metadata?: { reviewsCount?: number } };
export type AirbnbReviewSample = { texts: string[]; sampled: number; lowRated: number; total: number };

const reviewText = (html: string): string => {
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n');
  const plain = new DOMParser().parseFromString(withBreaks, 'text/html').body.textContent || '';
  return plain.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]*/g, '\n').trim().slice(0, MAX_REVIEW_CHARS);
};

export const selectAirbnbReviewSample = (lowest: Review[], relevant: Review[], total: number): AirbnbReviewSample => {
  const seen = new Set<string>();
  const texts: string[] = [];
  let lowRated = 0;
  for (const review of [...lowest, ...relevant]) {
    if (!review.id || seen.has(review.id)) continue;
    seen.add(review.id);
    const text = reviewText(review.localizedReview?.comments || review.localizedCommentV2?.comments || review.comments || '');
    if (!text || !review.rating) continue;
    if (review.rating < 5) lowRated++;
    texts.push(`${review.rating}★ ${text}`);
  }
  return { texts, sampled: texts.length, lowRated, total: Math.max(total, texts.length) };
};

const getApiKey = (): string | null => {
  try {
    return JSON.parse(document.getElementById('data-initializer-bootstrap')?.textContent || '{}')['layout-init']?.api_config?.key || null;
  } catch { return null; }
};

const reviewPage = async (id: string, apiKey: string, sort: 'RATING_ASC' | 'BEST_QUALITY'): Promise<ReviewPage> => {
  const url = new URL(`/api/v3/StaysPdpReviewsQuery/${REVIEWS_HASH}`, location.origin);
  url.searchParams.set('operationName', 'StaysPdpReviewsQuery');
  url.searchParams.set('locale', document.documentElement.lang || 'en');
  url.searchParams.set('variables', JSON.stringify({
    id: btoa(`StayListing:${id}`),
    pdpReviewsRequest: { fieldSelector: 'for_p3_translation_only', forPreview: false, showingTranslationButton: false, limit: PAGE_SIZE, offset: '0', first: PAGE_SIZE, sortingPreference: sort },
  }));
  url.searchParams.set('extensions', JSON.stringify({ persistedQuery: { version: 1, sha256Hash: REVIEWS_HASH } }));
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'X-Airbnb-API-Key': apiKey, 'X-CSRF-Without-Token': '1' },
  });
  if (!response.ok) throw new Error('Airbnb reviews could not be loaded.');
  const page = (await response.json())?.data?.presentation?.stayProductDetailPage?.reviews as ReviewPage | undefined;
  if (!Array.isArray(page?.reviews)) throw new Error('Airbnb reviews could not be read.');
  return page;
};

export const fetchAirbnbReviewSample = async (id: string): Promise<AirbnbReviewSample> => {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Airbnb review access is unavailable on this page.');
  const [lowest, relevant] = await Promise.all([
    reviewPage(id, apiKey, 'RATING_ASC'),
    reviewPage(id, apiKey, 'BEST_QUALITY'),
  ]);
  return selectAirbnbReviewSample(lowest.reviews, relevant.reviews, lowest.metadata?.reviewsCount || relevant.metadata?.reviewsCount || 0);
};
