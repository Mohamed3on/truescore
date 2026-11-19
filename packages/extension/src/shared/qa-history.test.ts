import { test, expect, beforeEach } from 'bun:test';
import { findQA, loadQAs, removeQA, saveQA } from './qa-history';

beforeEach(() => chrome.storage.local.clear());

test('a question asked again, however it is typed, finds its Answer', async () => {
  await saveQA('place', { q: 'Dogs allowed?', a: 'Yes.', ts: 1 });
  expect((await findQA('place', '  dogs ALLOWED '))?.a).toBe('Yes.');
  expect(await findQA('other', 'Dogs allowed?')).toBeUndefined();
});

test('re-asking replaces the old Answer at the front; the newest ten are kept', async () => {
  for (let i = 0; i < 12; i++) await saveQA('place', { q: `q${i}`, a: `a${i}`, ts: i });
  await saveQA('place', { q: 'Q3?', a: 'fresh', ts: 99 });
  const qs = await loadQAs('place');
  expect(qs).toHaveLength(10);
  expect(qs[0]).toEqual({ q: 'Q3?', a: 'fresh', ts: 99 });
  expect(qs.filter((e) => e.a.startsWith('a3'))).toHaveLength(0);
  await removeQA('place', 'Q3?');
  expect(await findQA('place', 'q3')).toBeUndefined();
});
