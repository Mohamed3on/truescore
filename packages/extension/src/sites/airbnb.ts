import { netScore } from '@truescore/gmaps-shared';
import { addCommas, el } from '../shared/utils';

// The score rides Airbnb's own "★ 4.0 · 3 reviews" line as one more item; its working opens
// in a card on hover.
const STYLES = `
  .ts-air-line { display: inline-flex; }
  .ts-air-dot { margin: 0 4px 0 0; }
  .ts-air-score { position: relative; display: inline-flex; align-items: baseline; gap: 5px; color: #6a6a6a; font-weight: 400; font-variant-numeric: tabular-nums; cursor: default; }
  .ts-air-score > b { font-weight: 600; color: #222; text-decoration: underline dotted rgba(34, 34, 34, .35); text-underline-offset: 3px; }
  .ts-air-caption { margin-top: 12px; font-size: 14px; line-height: 18px; }
  .ts-air-card {
    position: absolute;
    top: calc(100% + 10px);
    left: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: max-content;
    max-width: 280px;
    padding: 12px 16px;
    background: #fff;
    border-radius: 12px;
    text-align: left;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .04), 0 6px 20px rgba(0, 0, 0, .14);
    opacity: 0;
    transform: translateY(-4px) scale(.97);
    transform-origin: top left;
    pointer-events: none;
    transition: opacity 100ms ease-out, transform 100ms ease-out;
  }
  .ts-air-score:hover .ts-air-card {
    opacity: 1;
    transform: none;
    transition: opacity 160ms cubic-bezier(.23, 1, .32, 1) 80ms, transform 160ms cubic-bezier(.23, 1, .32, 1) 80ms;
  }
  .ts-air-card-head { font-size: 16px; line-height: 20px; font-weight: 600; color: #222; }
  .ts-air-card-work { font-size: 14px; line-height: 18px; font-weight: 400; color: #6a6a6a; text-wrap: balance; }
  @media (prefers-reduced-motion: reduce) { .ts-air-card { transform: none !important; } }
`;

type Quality = {
  ratingDistribution?: { label: string; percentage: number }[];
  listingRatingStats?: { overallRatingStats?: { ratingCount?: string } };
};

// The page data's quality object holds this listing's own stats: the per-star shares behind
// its "Overall rating" bars and its review count. (hostRatingCount beside them is the host's
// total across every listing.) Reading data, not Airbnb's generated class names, is what keeps
// the count from silently reading 0 when those names change.
const findQuality = (o: any): Quality | null => {
  if (!o || typeof o !== 'object') return null;
  if (o.ratingDistribution && o.listingRatingStats) return o;
  for (const v of Object.values(o)) {
    const q = findQuality(v);
    if (q) return q;
  }
  return null;
};

const getStats = () => {
  let quality: Quality | null = null;
  try { quality = findQuality(JSON.parse(document.getElementById('data-deferred-state-0')?.textContent || 'null')); } catch {}
  const count = Number(quality?.listingRatingStats?.overallRatingStats?.ratingCount);
  if (!count) return null;
  const stars = (label: string) => Math.round((quality!.ratingDistribution!.find((d) => d.label === label)?.percentage ?? 0) * count);
  const five = stars('5');
  const one = stars('1');
  return { count, five, one, score: netScore(five - one, count) };
};

const buildScore = ({ count, five, one, score }: NonNullable<ReturnType<typeof getStats>>) => {
  const card = el('span', 'ts-air-card');
  card.append(
    el('span', 'ts-air-card-head', `TrueScore ${addCommas(score)}`),
    el('span', 'ts-air-card-work', `Net loved: 5★ minus 1★, over all ${addCommas(count)} reviews`),
    el('span', 'ts-air-card-work', `(${addCommas(five)} − ${addCommas(one)})² ÷ ${addCommas(count)} reviews = ${addCommas(score)}`),
  );
  const item = el('span', 'ts-air-score', 'TrueScore ');
  item.append(el('b', undefined, addCommas(score)), el('span', undefined, `· ${Math.round(((five - one) / count) * 100)}% net loved`), card);
  return item;
};

// Standard listings show "★ 4.0 · 3 reviews" under the title; guest favourites show a box
// instead (the overview then has no reviews link), so the score captions that box.
const place = (item: HTMLElement): boolean => {
  const line = document.querySelector('[data-section-id="OVERVIEW_DEFAULT_V2"] a[href*="/reviews"]')?.parentElement;
  if (line) {
    const wrap = el('span', 'ts-air-line');
    wrap.append(el('span', 'ts-air-dot', '·'), item);
    line.append(wrap);
    return true;
  }
  const banner = document.querySelector('[data-section-id="GUEST_FAVORITE_BANNER"]');
  if (banner?.textContent?.trim()) {
    const caption = el('div', 'ts-air-caption');
    caption.append(item);
    banner.append(caption);
    return true;
  }
  return false;
};

const stats = getStats();
if (stats) {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.append(style);
  const item = buildScore(stats);
  if (!place(item)) {
    const observer = new MutationObserver(() => { if (place(item)) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}
