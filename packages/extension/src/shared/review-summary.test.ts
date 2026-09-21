import { test, expect, mock } from 'bun:test';

const PARSED = { praised: ['Lasts long'], complaints: [], conclusion: 'Good.', betterAlternative: '' };
mock.module('./llm', () => ({ summarize: async () => PARSED }));

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
