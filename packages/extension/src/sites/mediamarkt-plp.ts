import { afterHydration } from '../shared/utils';
import { setupScoreGrid } from '../shared/score-grid';
import { cardScores, MEDIAMARKT, SATURN } from '../shared/bazaarvoice';

// Search and category pages show one of two cards (Saturn the older), each linking
// its product by id. A card without stars has no reviews to fetch.
const CARD = 'article[data-test="mms-cofr-product-card"], article[data-test="mms-product-card"]';
const RATING = '[data-test="mms-customer-rating-container"]';
const idOf = (card: Element) => card.querySelector('a[href*="/product/"]')?.getAttribute('href')?.match(/-(\d+)\.html/)?.[1];
const scoreOf = cardScores(location.hostname.endsWith('saturn.de') ? SATURN : MEDIAMARKT);

afterHydration().then(() => setupScoreGrid({
  cardSelector: CARD,
  idOf,
  scoreForCard: (card) => {
    const id = card.querySelector(RATING) && idOf(card);

    return id ? scoreOf(id) : Promise.resolve(null);
  },
  // On the stars and review count's line.
  placeBadge: (card, badge) => card.querySelector(RATING)?.append(badge),
}));
