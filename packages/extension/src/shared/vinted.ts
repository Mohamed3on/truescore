import { netScore } from '@truescore/gmaps-shared';
import * as z from 'zod/mini';

// Vinted's catalog page names each item's seller only in its embedded Next.js
// RSC payload (JSON inside JS strings, so quotes come escaped); the seller's
// record and the viewer's postage come from Vinted's own JSON API.

export interface Seller {
  country: string;
  positive: number;
  negative: number;
  total: number;
  // Average rating as a 0–1 fraction of five stars.
  rating: number;
}

export interface Postage {
  amount: number;
  currency: string;
}

// Item id → seller id, for every product card in a catalog page.
export const parseItemSellers = (html: string): Map<string, string> => {
  const map = new Map<string, string>();

  for (const chunk of html.replace(/\\"/g, '"').split('"productItem":{"id":').slice(1)) {
    const item = chunk.match(/^\d+/)?.[0];
    const seller = chunk.match(/"user":\{"id":(\d+)/)?.[1];

    if (item && seller) map.set(item, seller);
  }

  return map;
};

// GET /api/v2/users/{id}
export const USER = z.object({
  user: z.object({
    country_iso_code: z.string(),
    positive_feedback_count: z.number(),
    negative_feedback_count: z.number(),
    feedback_count: z.number(),
    feedback_reputation: z.number(),
  }),
});

export const sellerFromApi = ({ user: u }: z.infer<typeof USER>): Seller => ({ country: u.country_iso_code, positive: u.positive_feedback_count, negative: u.negative_feedback_count, total: u.feedback_count, rating: u.feedback_reputation });

// GET /api/v2/items/{id}/shipping_details: the viewer's postage.
export const SHIPPING = z.object({
  shipping_details: z.object({
    pickup_only: z.boolean(),
    price: z.nullable(z.object({ amount: z.number(), currency_code: z.string() })),
  }),
});

// null for a pickup-only item, which can't be posted at all.
export const postageFromApi = ({ shipping_details: { pickup_only, price } }: z.infer<typeof SHIPPING>): Postage | null => pickup_only || !price ? null : { amount: price.amount, currency: price.currency_code };

// 0: has sold before and buyers were happy (a 4★ average or better).
// 1: no reviews yet, an unknown. 2: reviewed and found wanting, worse than unknown.
export const sellerTier = (s: Seller) => (s.total === 0 ? 1 : s.rating >= 0.8 ? 0 : 2);

export const sellerScore = (s: Seller) => netScore(s.positive - s.negative, s.total);

// Vinted's relevance order still matters most: one unit of postage is worth
// only this many places in it.
const PLACES_PER_UNIT = 3;

// Lexicographic: seller tier, then a cost — postage, less one unit per 10× of
// seller TrueScore, plus the card's place in Vinted's relevance order — then
// likes as the tiebreak. `place` is the card's 0-based index in Vinted's order.
// Missing data (not fetched yet, unreadable, pickup-only) costs Infinity, so
// those cards wait at the end of their tier; a seller not yet read waits at the
// end of the good tier.
export const rankKey = (seller: Seller | null | undefined, postage: Postage | null | undefined, likes: number, place: number): number[] => {
  if (!seller) return [0, Infinity, -likes];
  const cost = postage ? postage.amount - Math.log10(Math.max(sellerScore(seller), 0) + 1) + place / PLACES_PER_UNIT : Infinity;

  return [sellerTier(seller), cost, -likes];
};

export const compareKeys = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];

  return 0;
};
