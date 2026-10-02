import { test, expect, describe, mock } from 'bun:test';
import type { Stance } from '@truescore/gmaps-shared';

// Jev's read, stubbed: what the next search's matches say, or null — Jev unread,
// the star share it always showed.
let nextStances: ((texts: string[]) => Stance[]) | null = null;
const jev = await import('./jev');
await mock.module('./jev', () => ({ ...jev, readStances: async (_q: string, texts: string[]) => nextStances?.(texts) ?? null }));
const { buildSearchSection, buildReviewCard, localSearchAsk, queryTerms } = await import('./review-search');

type R = { rating: number; title: string; body: string };
const review = (rating: number, title: string, body = ''): R => ({ rating, title, body });

const mount = (opts: Partial<Parameters<typeof buildSearchSection<R>>[0]> & { reviews: R[] }) =>
  buildSearchSection<R>({
    fields: (r) => ({ rating: r.rating, title: r.title, body: r.body }),
    toText: (r) => `${r.title}. ${r.body}`,
    summaryPrompt: 'summarize',
    exampleQuery: 'battery',
    ...opts,
  });

// The section renders asynchronously (findMatches is awaited even locally), and
// input is debounced — drive render() by dispatching and letting the timer run.
// The header's read waits for the query to stand (STANCE_SETTLE_MS), so a test
// of it waits longer.
const SETTLED = 1200;
const search = async (section: HTMLElement, query: string, ms = 400) => {
  const input = section.querySelector('.ars-search-input') as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, ms));
};

describe('queryTerms', () => {
  test('splits on a case-insensitive OR and lowercases', () => {
    expect(queryTerms('Battery or Strap')).toEqual(['battery', 'strap']);
    expect(queryTerms('battery')).toEqual(['battery']);
  });
});

describe('buildSearchSection', () => {
  test('a match count is quoted against the whole corpus, not just the hits', () => {
    const section = mount({ reviews: [review(5, 'great battery'), review(1, 'awful strap')] });
    const input = section.querySelector('.ars-search-input') as HTMLInputElement;
    expect(input.placeholder).toContain('2 reviews');
  });

  test('caps the rendered results and says so', async () => {
    const reviews = Array.from({ length: 120 }, (_, i) => review(5, `battery note ${i}`));
    const section = mount({ reviews });
    await search(section, 'battery');

    expect(section.querySelectorAll('.ars-search-review').length).toBe(50);
    const notice = section.querySelector('.ars-search-truncated');
    expect(notice?.textContent).toContain('Showing first 50');
  });

  test('counts every match while rendering only the first page of them', async () => {
    const reviews = Array.from({ length: 120 }, (_, i) => review(5, `battery note ${i}`));
    const section = mount({ reviews });
    await search(section, 'battery');
    expect(section.querySelector('.ars-search-count')?.textContent).toBe('120');
    expect(section.querySelector('.ars-search-summary')?.textContent).toContain('of 120 reviews');
  });

  test('an OR query unions its terms', async () => {
    const section = mount({ reviews: [review(5, 'great battery'), review(1, 'awful strap'), review(3, 'nothing relevant')] });
    await search(section, 'battery OR strap');
    expect(section.querySelectorAll('.ars-search-review').length).toBe(2);
  });

  test('a remote search reports its own total, not the page it handed back', async () => {
    const section = mount({
      reviews: [],
      total: 9000,
      search: async () => ({ matches: [review(5, 'battery good')], total: 412 }),
    });
    await search(section, 'battery');
    expect(section.querySelector('.ars-search-count')?.textContent).toBe('412');
    expect(section.querySelector('.ars-search-summary')?.textContent).toContain('of 9,000 reviews');
  });

  test('mountSummarize replaces the built-in button and gets the matched texts', async () => {
    let got: { query: string; texts: string[] } | null = null;
    const section = mount({
      reviews: [review(5, 'battery lasts'), review(1, 'strap frays')],
      mountSummarize: (host, query, texts) => { got = { query, texts }; host.textContent = 'widget'; },
    });
    expect((section.querySelector('.ars-search-sum-btn') as HTMLElement).style.display).toBe('none');

    await search(section, 'battery');
    expect(got!.query).toBe('battery');
    expect(got!.texts).toEqual(['battery lasts. ']);
  });

  test('a query-aware prompt is built per search', async () => {
    const seen: string[] = [];
    const section = mount({
      reviews: [review(5, 'battery lasts')],
      summaryPrompt: (q) => { seen.push(q); return `about ${q}`; },
      mountSummarize: () => {},
    });
    await search(section, 'battery');
    // The prompt fn is only called when a summary is actually requested; the
    // section holds the function rather than a baked string.
    expect(seen).toEqual([]);
    expect(section.querySelectorAll('.ars-search-review').length).toBe(1);
  });

  test('unrated reviews count as matches but stay out of the %-positive chip', async () => {
    const section = mount({ reviews: [review(5, 'battery a'), review(5, 'battery b'), review(1, 'battery c'), review(0, 'battery d')] });
    await search(section, 'battery', SETTLED);
    expect(section.querySelector('.ars-search-count')?.textContent).toBe('4');
    // (2 loved − 1 hated) / 3 rated, not / 4 matches.
    expect(section.querySelector('.ars-search-score')?.textContent).toBe('33%');
  });

  test('a match set with no ratings shows no chip', async () => {
    const section = mount({ reviews: [review(0, 'battery a')] });
    await search(section, 'battery', SETTLED);
    expect(section.querySelector('.ars-search-score')?.textContent).toBe('');
  });

  test('holds the score\'s place while the matches are read, then fills it once', async () => {
    const section = mount({ reviews: [review(5, 'battery a'), review(1, 'battery b')] });
    await search(section, 'battery');
    expect(section.querySelector('.ars-search-score')?.textContent).toBe('…');
    await new Promise((r) => setTimeout(r, SETTLED - 400));
    expect(section.querySelector('.ars-search-score')?.textContent).toBe('0%');
  });

  test('read by Jev, the header shows what the matches say, and its counts filter the list', async () => {
    // A 5★ review that complains about the battery counts as a complaint.
    nextStances = (texts) => texts.map((t) => (t.includes('dies') ? 'complain' : t.includes('lasts') ? 'praise' : 'mixed'));
    const section = mount({ reviews: [review(5, 'battery lasts'), review(5, 'battery dies fast'), review(4, 'battery lasts long'), review(3, 'battery is a battery')] });
    await search(section, 'battery', SETTLED);
    nextStances = null;
    const score = section.querySelector<HTMLElement>('.ars-search-score')!;
    expect(score.querySelector('.ts-op-share')?.textContent).toBe('67%');
    expect(score.title).toBe('2 praise · 1 complain · 1 mixed or neutral');
    const [up, down] = [...section.querySelectorAll<HTMLButtonElement>('.ars-search-summary .ts-op-filter')];
    expect([up!.textContent, down!.textContent]).toEqual(['▲2', '▼1']);
    down!.click();
    expect(down!.getAttribute('aria-pressed')).toBe('true');
    expect([...section.querySelectorAll('.ars-search-title')].map((t) => t.textContent)).toEqual(['battery dies fast']);
    down!.click();
    expect(section.querySelectorAll('.ars-search-review').length).toBe(4);
  });

  test('clearing the box hides the results', async () => {
    const section = mount({ reviews: [review(5, 'battery lasts')] });
    await search(section, 'battery');
    expect((section.querySelector('.ars-search-list') as HTMLElement).style.display).toBe('');
    await search(section, '');
    expect((section.querySelector('.ars-search-list') as HTMLElement).style.display).toBe('none');
  });
});

describe('localSearchAsk', () => {
  const fields = (r: R) => ({ rating: r.rating, title: r.title, body: r.body });

  test("an Ask's Search matches every review in hand, scored over its rated matches", async () => {
    const reviews = [review(5, 'great battery'), review(1, 'battery died'), review(5, 'nice strap'), review(0, 'battery ok')];
    const ask = localSearchAsk(Promise.resolve(reviews), fields, (r) => r.title, document.body);
    // (1 loved − 1 hated) / 2 rated; the unrated match still counts as found.
    expect(await ask.search('Battery OR zip', () => {})).toEqual({
      texts: ['great battery', 'battery died', 'battery ok'],
      scorePct: 0,
      trustedReviews: 2,
    });
  });

  test("a Search's row opens its query in the island's search box", () => {
    const island = document.createElement('div');
    const section = mount({ reviews: [review(5, 'battery lasts')] });
    island.appendChild(section);
    localSearchAsk(Promise.resolve([]), fields, (r) => r.title, island).open!('strap OR battery');
    expect((section.querySelector('.ars-search-input') as HTMLInputElement).value).toBe('strap OR battery');
  });
});

describe('buildReviewCard', () => {
  test('highlights every occurrence of any term', () => {
    const card = buildReviewCard({ rating: 5, title: 'battery and strap', body: 'the battery again' }, ['battery', 'strap']);
    expect([...card.querySelectorAll('.ars-search-hl')].map((n) => n.textContent)).toEqual(['battery', 'strap', 'battery']);
  });

  test('overlapping terms do not double-wrap', () => {
    const card = buildReviewCard({ rating: 5, title: 'waterproofing', body: '' }, ['water', 'waterproof']);
    expect([...card.querySelectorAll('.ars-search-hl')].map((n) => n.textContent)).toEqual(['waterproof']);
  });
});
