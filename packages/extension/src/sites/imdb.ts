import { cacheGet, cacheSet } from '../shared/cache';
import { setupScoreGrid } from '../shared/score-grid';
import { addCommas, el, npsColor, npsStats } from '../shared/utils';

// The "More like this" strip as the page renders it, from its Next.js data. The
// API's own list for a title differs (a signed-in page gets a filtered strip),
// and the picks panel has to judge the titles the user can see.
type Similar = { id: string; name: string; type: string; year: number | null; poster: string | null; rating: number | null };
const similarFromPage = (): Similar[] => {
  try {
    const edges = JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || '')
      ?.props?.pageProps?.mainColumnData?.moreLikeThisTitles?.edges;
    if (!Array.isArray(edges)) return [];
    return edges
      .map(({ node }: any) => ({
        id: node?.id,
        name: node?.titleText?.text ?? node?.id,
        type: node?.titleType?.text ?? '',
        year: node?.releaseYear?.year ?? null,
        poster: node?.primaryImage?.url ?? null,
        rating: node?.ratingsSummary?.aggregateRating ?? null,
      }))
      .filter((s: Similar) => typeof s.id === 'string');
  } catch {
    return [];
  }
};

// Per-rating vote counts for a set of titles: one background request for
// whatever the day's cache lacks (ratings drift slowly, and neighbouring
// titles share most of their strips). A title the request didn't answer is
// left out, so a failed fetch stays uncached and a reload asks again.
const CACHE_TTL = 24 * 60 * 60 * 1000;
const histograms = async (ids: string[]): Promise<Record<string, number[]>> => {
  const found: Record<string, number[]> = {};
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const cached = cacheGet(`nps_imdb_h_${id}`, CACHE_TTL);
    if (cached) found[id] = cached;
    else missing.push(id);
  }
  if (missing.length) {
    const fetched: Record<string, number[]> | null =
      await chrome.runtime.sendMessage({ type: 'imdbHistograms', ids: missing }).catch(() => null);
    for (const id of missing) {
      if (!fetched?.[id]) continue;
      found[id] = fetched[id];
      cacheSet(`nps_imdb_h_${id}`, fetched[id]);
    }
  }
  return found;
};

// 9★ and 10★ against 1★ and 2★, over every rating. Null with none.
const scoreOf = (histogram: number[] | undefined) => {
  const total = histogram?.reduce((sum, c) => sum + c, 0) ?? 0;
  return total ? { ...npsStats(histogram![8] + histogram![9], histogram![0] + histogram![1], total), total } : null;
};
type Score = NonNullable<ReturnType<typeof scoreOf>>;
const scoreText = ({ score, nps }: Score) => `${addCommas(score)} (${Math.round(nps)}%)`;

const idOf = (card: Element) =>
  card.querySelector('a[href*="/title/tt"]')?.getAttribute('href')?.match(/\/title\/(tt\d+)/)?.[1];
const CARD = '[data-testid="MoreLikeThis"] .ipc-poster-card';

// The title page puts the score in its rating bar, and a page without that bar puts it
// under the name; only the title page has a strip. One request covers the title and
// every card.
const id = window.location.pathname.match(/\/title\/(tt\d+)\/(?:ratings\/?)?$/)?.[1];
const similar = id ? similarFromPage() : [];
const scores: Promise<Record<string, Score | null>> = id
  ? histograms([id, ...similar.map((s) => s.id), ...[...document.querySelectorAll(CARD)].flatMap((c) => idOf(c) ?? [])])
      .then((all) => Object.fromEntries(Object.entries(all).map(([tt, h]) => [tt, scoreOf(h)])))
  : Promise.resolve({});

// --- similar picks -----------------------------------------------------------
// Is there something similar that scores as well? A pick has to match this
// title on both the Score and its ratio, each with the slack a few hundred
// ratings can't resolve: the Score may trail by SCORE_SLACK of this one's, the
// ratio by RATIO_SLACK points. Best Score first.
const SCORE_SLACK = 0.05;
const RATIO_SLACK = 2;
const posterThumb = (url: string) => url.replace(/_V1_[^.]*\./, '_V1_QL75_UX56_.');

const renderSimilar = (current: Score, all: Record<string, Score | null>, anchor: Element) => {
  const picks = similar
    .flatMap((s) => { const score = all[s.id]; return score ? [{ ...s, ...score }] : []; })
    .filter((s) => s.score >= current.score - Math.abs(current.score) * SCORE_SLACK && s.nps >= current.nps - RATIO_SLACK)
    .sort((a, b) => b.score - a.score);
  const panel = el('div', 'ts-similar');
  if (!picks.length) {
    panel.append(el('div', 'ts-similar-winner', '★ Nothing similar scores as well.'));
  } else {
    panel.append(el('div', 'ts-similar-header', picks.length === 1 ? '1 similar title scores as well or better' : `${picks.length} similar titles score as well or better`));
    for (const pick of picks) {
      const row = el('a', 'ts-similar-row') as HTMLAnchorElement;
      row.href = `/title/${pick.id}/`;
      const poster = el('img', 'ts-similar-poster') as HTMLImageElement;
      if (pick.poster) poster.src = posterThumb(pick.poster);
      poster.alt = '';
      const name = el('span', 'ts-similar-name', pick.name);
      name.append(el('span', 'ts-similar-meta', [pick.year, pick.type, pick.rating != null && `★ ${pick.rating}`].filter(Boolean).join(' · ')));
      const score = el('span', 'ts-similar-score', scoreText(pick));
      score.style.color = npsColor(pick.nps);
      row.append(poster, name, score);
      panel.append(row);
    }
  }
  anchor.after(panel);
};

// A fourth block in IMDb's own rating bar, after "IMDb RATING"; the working opens in a card.
const scoreBlock = ({ score, nps, total }: Score) => {
  const card = el('span', 'ts-card');
  card.append(
    el('span', 'ts-card-head', `TrueScore ${addCommas(score)}`),
    el('span', undefined, `Net loved: 9–10★ minus 1–2★, over all ${addCommas(total)} ratings`),
  );
  const value = el('span', 'ts-bar-value');
  value.append(el('span', 'ts-bar-fig', addCommas(score)), el('span', 'ts-bar-sub', `${Math.round(nps)}% net loved`), card);
  const block = el('div', 'ts-bar');
  block.append(el('span', 'ts-bar-label', 'TrueScore'), value);
  return block;
};

// The strip can render after the scores land; its heading is where the verdict on it goes.
const whenPresent = (selector: string) => new Promise<Element>((resolve) => {
  const find = () => {
    const found = document.querySelector(selector);
    if (found) { observer.disconnect(); resolve(found); }
  };
  const observer = new MutationObserver(find);
  observer.observe(document.body, { childList: true, subtree: true });
  find();
});

scores.then(async (all) => {
  const current = id && all[id];
  if (!current) return;
  const bar = document.querySelector('[data-testid="hero-parent"] [data-testid="hero-rating-bar__aggregate-rating"]');
  const headline = document.querySelector('h1');
  if (bar) bar.after(scoreBlock(current));
  else headline?.after(el('div', 'ts-score', scoreText(current)));
  if (similar.length) renderSimilar(current, all, await whenPresent('[data-testid="MoreLikeThis"] .ipc-title'));
}).catch(() => {});

// --- the "More like this" strip ----------------------------------------------
// Badge each card with its title's score and re-rank the strip by it.
setupScoreGrid({
  cardSelector: CARD,
  idOf,
  scoreForCard: async (card) => (await scores)[idOf(card) ?? ''] ?? null,
  // The star row is `nowrap` and overflows on narrow cards, so the badge takes
  // its own line under it, aligned to the row's 8px gutter.
  placeBadge: (card, badge) => {
    badge.style.margin = '0 8px 4px';
    badge.style.alignSelf = 'flex-start';
    card.querySelector('.ipc-poster-card__rating-star-group')?.after(badge);
  },
});
