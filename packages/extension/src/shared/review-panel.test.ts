import { test, expect, describe, mock } from 'bun:test';
import * as realLlm from './llm';

// The model, stubbed: each Ask records the Sample it reads and whether it may
// Search, then stops.
let asked: { sample: string[]; canSearch: boolean } | undefined;

mock.module('./llm', () => ({
  ...realLlm,
  askTransport: async (_prompt: string, sample: string[], canSearch: boolean) => {
    asked = { sample, canSearch };
    throw new Error('stop');
  },
}));

const { buildReviewPanel } = await import('./review-panel');
const { SAMPLE_MAX } = await import('./review-summary');
const { el } = await import('./utils');

type R = { rating: number; title: string; body: string };

const review = (rating: number, title: string, body = ''): R => ({ rating, title, body });

let keys = 0;

const panel = (opts: Partial<Parameters<typeof buildReviewPanel<R>>[1]> & Pick<Parameters<typeof buildReviewPanel<R>>[1], 'all'>) => {
  const host = document.createElement('div');

  const built = buildReviewPanel<R>(host, {
    key: `panel-test-${keys++}`,
    total: Array.isArray(opts.all) ? opts.all.length : 0,
    text: (r) => [r.title, r.body].filter(Boolean).join(': '),
    card: (r) => ({ rating: r.rating, title: r.title, body: r.body }),
    exampleQuery: 'battery',
    ...opts,
  });

  return { host, ...built };
};

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// The `kind` of element under `selector`; anything else fails the test here.
const elementAt = <E extends Element>(root: ParentNode, selector: string, kind: new () => E): E => {
  const found = root.querySelector(selector);

  if (!(found instanceof kind)) throw new Error(`no ${kind.name} at ${selector}`);

  return found;
};

const ask = async (host: HTMLElement) => {
  asked = undefined;
  const input = elementAt(host, '.ars-question-input', HTMLInputElement);
  input.value = 'does it last?';
  input.dispatchEvent(new Event('input'));
  elementAt(host, '.ars-question-row .ars-summarize-btn', HTMLButtonElement).click();
  await settle();

  return asked!;
};

describe('the Sample', () => {
  test('is the newest reviews up to SAMPLE_MAX, each text once, none empty', async () => {
    const all = [review(5, 'same'), review(4, 'same'), review(3, ''), ...Array.from({ length: SAMPLE_MAX }, (_, i) => review(5, `review ${i}`))];
    const { host } = panel({ all });
    const { sample } = await ask(host);
    expect(sample.length).toBe(SAMPLE_MAX - 2);
    expect(sample.filter((t) => t === 'same').length).toBe(1);
    expect(sample).not.toContain('');
    expect(sample).not.toContain(`review ${SAMPLE_MAX - 1}`);
  });
});

describe('an Ask', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => review(5, `review ${i}`));

  test('may Search only when the Item has more reviews than the Sample', async () => {
    expect((await ask(panel({ all: many(SAMPLE_MAX) }).host)).canSearch).toBe(false);
    expect((await ask(panel({ all: many(SAMPLE_MAX + 1) }).host)).canSearch).toBe(true);
  });

  test("may Search past a smaller Sample, through the site's own search", async () => {
    const searchTerm = async () => ({ reviews: [], total: 0 });
    expect((await ask(panel({ all: many(100), allMax: 100, total: 100, searchTerm }).host)).canSearch).toBe(false);
    expect((await ask(panel({ all: many(100), allMax: 100, total: 101, searchTerm }).host)).canSearch).toBe(true);
  });

  test('may not Search when every review a Search reaches is in the Sample', async () => {
    // Reviews in hand only, more reported than downloaded.
    expect((await ask(panel({ all: many(100), allMax: 100, total: 5000 }).host)).canSearch).toBe(false);
  });
});

describe('the Search box', () => {
  const search = async (host: HTMLElement, query: string) => {
    const input = elementAt(host, '.ars-search-input', HTMLInputElement);
    input.value = query;
    input.dispatchEvent(new Event('input'));
    await settle(450);
  };

  const titles = (host: HTMLElement) => [...host.querySelectorAll('.ars-search-title')].map((t) => t.textContent);

  test('searches the reviews in hand, above the Summary', async () => {
    const { host } = panel({ all: [review(5, 'battery lasts'), review(1, 'strap frays'), review(3, 'battery ok'), review(4, 'zip'), review(4, 'fit')] });
    await settle();
    const input = elementAt(host, '.ars-search-input', HTMLInputElement);
    expect(input.placeholder).toContain('Search 5 reviews');
    expect(input.compareDocumentPosition(host.querySelector('.ars-question-row')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await search(host, 'battery');
    expect(titles(host)).toEqual(['battery lasts', 'battery ok']);
  });

  test("past what the site downloads, searches every review through the site's own search", async () => {
    const terms: string[] = [];

    const searchTerm = async (term: string) => {
      terms.push(term);

      return { reviews: [review(5, `old ${term}`)], total: 40 };
    };

    // Without waiting for the reviews in hand.
    const { host } = panel({ all: new Promise<R[]>(() => {}), allMax: 1, total: 900, searchTerm });
    await settle();
    expect(elementAt(host, '.ars-search-input', HTMLInputElement).placeholder).toContain('Search 900 reviews');
    await search(host, 'battery');
    expect(terms).toEqual(['battery']);
    expect(titles(host)).toEqual(['old battery']);
    expect(host.querySelector('.ars-search-count')?.textContent).toBe('40');
  });

  test('none below five reviews', async () => {
    const { host } = panel({ all: [review(5, 'a'), review(5, 'b'), review(5, 'c'), review(5, 'd')] });
    await settle();
    expect(host.querySelector('.ars-search-input')).toBeNull();
    expect(host.querySelector('.ars-question-row')).toBeNull();
  });
});

describe('the recent gauge', () => {
  const five = [review(5, 'a'), review(5, 'b'), review(5, 'c'), review(1, 'd'), review(3, 'e')];
  const stats = (host: HTMLElement) => [...host.querySelectorAll('.ars-stat')].map((s) => s.textContent);

  test('reads the newest reviews, and damps the score by them', async () => {
    // (3 loved − 1 hated) / 5 = 40% recent positive.
    const { host } = panel({ all: five, recent: Promise.resolve(five), score: 1000 });
    await settle();
    expect(host.querySelector('.ars-gauge-pct')?.textContent).toBe('40%');
    expect(stats(host)).toEqual(['400adjusted', '5analyzed']);
  });

  test("joins the site's own stats, and leads the panel", async () => {
    const { host, stats: row } = panel({ all: five, recent: Promise.resolve(five) });
    row!.append(el('div', 'ars-stat', '12reviews'));
    await settle();
    expect(stats(host)).toEqual(['12reviews', '5analyzed']);
    expect(host.firstElementChild?.className).toBe('ars-gauge');
  });

  test('is gone when none of the newest reviews are rated', async () => {
    const { host } = panel({ all: five, recent: Promise.resolve([]), score: 1000 });
    await settle();
    expect(host.querySelector('.ars-gauge')).toBeNull();
    expect(stats(host)).toEqual([]);
  });
});

test("a Summary point's reviews show as the site's cards", async () => {
  const all = [review(5, 'Lasts', 'a full year'), review(4, 'b'), review(4, 'c'), review(4, 'd'), review(4, 'e')];
  const key = 'panel-test-receipts';
  const parsed = { praised: ['Lasts long'], complaints: [], conclusion: 'Good.', betterAlternative: '', receipts: { 'Lasts long': { n: 2, quotes: ['Lasts: a full year'] } } };
  localStorage.setItem(key, JSON.stringify({ parsed, ts: 1 }));
  const { host } = panel({ all, key });
  elementAt(host, '.ars-receipt', HTMLButtonElement).click();
  await settle();
  const quote = host.querySelector('.ars-receipt-quotes .ars-search-review');
  expect(quote?.querySelector('.ars-search-title')?.textContent).toBe('Lasts');
  expect(quote?.querySelector('.ars-search-stars')?.textContent).toBe('★★★★★');
});

test("past what the site downloads, its reviews are fetched only once the Summary or an Ask needs them", async () => {
  let fetched = 0;
  const all = async () => (fetched++, [review(5, 'battery lasts')]);
  const { host } = panel({ all, allMax: 1, total: 900, searchTerm: async () => ({ reviews: [], total: 0 }) });
  await settle();
  expect(fetched).toBe(0);
  expect((await ask(host)).sample).toEqual(['battery lasts']);
  expect(fetched).toBe(1);
});
