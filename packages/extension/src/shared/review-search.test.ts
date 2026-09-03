import { test, expect, describe } from 'bun:test';
import { buildSearchSection, buildReviewCard, queryTerms } from './review-search';

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

  test('clearing the box hides the results', async () => {
    const section = mount({ reviews: [review(5, 'battery lasts')] });
    await search(section, 'battery');
    expect((section.querySelector('.ars-search-list') as HTMLElement).style.display).toBe('');
    await search(section, '');
    expect((section.querySelector('.ars-search-list') as HTMLElement).style.display).toBe('none');
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
