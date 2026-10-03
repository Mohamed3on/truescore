import { test, expect, mock } from 'bun:test';
import * as realLlm from './llm';

const PARSED = { praised: ['Lasts long'], complaints: [], conclusion: 'Good.', betterAlternative: '' };
// Keep the rest of the module intact: module mocks are process-wide, and a bare
// factory blanked salvageObject for llm.test.ts whenever it ran after this file.
mock.module('./llm', () => ({ ...realLlm, summarize: async () => PARSED, askTransport: async () => { throw new Error('unused'); } }));

test('Re-summarize gets its label back once the new summary is on screen', async () => {
  const { buildSummarizeWidget } = await import('./review-summary');
  const cacheKey = 'review-summary-test-kw-durex';
  localStorage.setItem(cacheKey, JSON.stringify({ parsed: PARSED, ts: 1 }));
  const wrapper = document.createElement('div');
  buildSummarizeWidget({ wrapper, cacheKey, summaryPrompt: 'p', fetchReviews: async () => ['a review long enough to count'] });

  const reBtn = wrapper.querySelector('.ars-resummarize-btn') as HTMLButtonElement;
  expect(reBtn.textContent).toBe('↻ Re-summarize');
  reBtn.click();
  expect(reBtn.disabled).toBe(true);
  expect(reBtn.textContent).toBe('⏳ Fetching reviews…');
  await new Promise((r) => setTimeout(r, 20));

  expect(reBtn.disabled).toBe(false);
  expect(reBtn.textContent).toBe('↻ Re-summarize');
  expect(wrapper.querySelector('.ars-summary-panel')?.textContent).toContain('Lasts long');
});

test('a promised auto-summarize waits for its answer, and a no spends no call', async () => {
  const { buildSummarizeWidget } = await import('./review-summary');
  // A key for getActiveLLM, so only the promise decides.
  (globalThis as any).chrome = { storage: { sync: { get: async (name: string) => ({ [name]: 'key' }) } } };
  try {
    const land = async (go: boolean) => {
      const wrapper = document.createElement('div');
      let decide!: (go: boolean) => void;
      buildSummarizeWidget({
        wrapper,
        cacheKey: `auto-summary-test-${go}`,
        summaryPrompt: 'p',
        fetchReviews: async () => ['a review long enough to count'],
        autoSummarize: new Promise<boolean>((resolve) => { decide = resolve; }),
      });
      const panel = () => wrapper.querySelector('.ars-summary-panel')?.textContent ?? '';
      await new Promise((r) => setTimeout(r, 20));
      expect(panel()).not.toContain('Lasts long');
      decide(go);
      await new Promise((r) => setTimeout(r, 20));
      return panel();
    };
    expect(await land(false)).not.toContain('Lasts long');
    expect(await land(true)).toContain('Lasts long');
  } finally {
    delete (globalThis as any).chrome;
  }
});

test("a receipt's reviews show as the site's cards, and as text when it has none", async () => {
  const { buildSummarizeWidget } = await import('./review-summary');
  const cacheKey = 'review-summary-test-receipt-cards';
  const quotes = ['[Ranking: BLUE] Great: Very detailed', 'an unmatched review text'];
  localStorage.setItem(cacheKey, JSON.stringify({ parsed: { ...PARSED, receipts: { 'Lasts long': { n: 2, quotes } } }, ts: 1 }));
  const wrapper = document.createElement('div');
  buildSummarizeWidget({
    wrapper,
    cacheKey,
    summaryPrompt: 'p',
    fetchReviews: async () => quotes,
    renderQuote: (text) => (text === quotes[0] ? Object.assign(document.createElement('div'), { className: 'card', textContent: 'Great' }) : null),
  });

  (wrapper.querySelector('.ars-receipt') as HTMLButtonElement).click();
  const box = wrapper.querySelector('.ars-receipt-quotes')!;
  expect([...box.children].map((c) => c.className)).toEqual(['card', 'ars-receipt-quote']);
  expect(box.textContent).not.toContain('[Ranking');
});
