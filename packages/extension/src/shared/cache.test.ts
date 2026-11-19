import { test, expect, beforeEach } from 'bun:test';
import { isLegacyHostKey } from './cache-keys';
import { cacheEdit, cacheEntries, cacheGet, cacheGetMaybe, cacheSet, cacheSetMaybe, storeGet, storeSet } from './cache';

const KEY = 'nps_test_key';
const TTL = 30 * 24 * 60 * 60 * 1000;

beforeEach(() => chrome.storage.local.clear());

test('a cached hit round-trips through the maybe pair', async () => {
  await cacheSetMaybe(KEY, { score: 42 });
  expect(await cacheGetMaybe(KEY, TTL)).toEqual({ value: { score: 42 } });
});

test('a cached miss serves null while the tombstone is fresh', async () => {
  await cacheSetMaybe(KEY, null);
  expect(await cacheGetMaybe(KEY, TTL)).toEqual({ value: null });
});

test('an aged tombstone falls back to a refetch even inside the positive TTL', async () => {
  const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
  await storeSet(KEY, { data: { __none: true }, ts: sevenHoursAgo });
  expect(await cacheGetMaybe(KEY, TTL)).toBeNull();
});

test('nothing cached means refetch', async () => {
  expect(await cacheGetMaybe(KEY, TTL)).toBeNull();
});

test('an expired entry reads as nothing and is dropped', async () => {
  await storeSet(KEY, { data: 1, ts: Date.now() - TTL - 1 });
  expect(await cacheGet(KEY, TTL)).toBeNull();
  await new Promise((r) => setTimeout(r, 0));
  expect(await storeGet(KEY)).toBeNull();
});

test("every key is filed under the page's host, so two sites never share one", async () => {
  await cacheSet(KEY, 1);
  expect(await chrome.storage.local.getKeys()).toEqual([`${location.host}|${KEY}`]);
});

test('edits under a prefix keep their write time; null drops, undefined leaves', async () => {
  await storeSet('p_a', { data: 1, ts: 5 });
  await storeSet('p_b', { data: 2, ts: 6 });
  await storeSet('p_summary', { parsed: {}, ts: 7 });
  await cacheEdit('p_', (data: number, key) => (key === 'p_a' ? data + 10 : null));
  expect(await storeGet('p_a')).toEqual({ data: 11, ts: 5 });
  expect(await storeGet('p_b')).toBeNull();
  expect(await cacheEntries('p_')).toEqual([['p_a', 11]]);
  expect(await storeGet('p_summary')).toEqual({ parsed: {}, ts: 7 });
});

test("the move out of page storage takes TrueScore's keys and never the site's own", () => {
  for (const ours of ['rc_summary_0x1:0x2', 'review-summary-B0ABC', 'nps_ikea_123', 'bk-summary-9-x-qa', 'dm_reviews_v8_1', 'ts_jev_stance_abc']) expect(isLegacyHostKey(ours)).toBe(true);

  for (const theirs of ['sb_wiz.zpc.g', 'etsy-cart', 'ikea_session', 'review-draft', 'rcaptcha']) expect(isLegacyHostKey(theirs)).toBe(false);
});
