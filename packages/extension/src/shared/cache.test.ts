import { test, expect, beforeEach } from 'bun:test';
import { cacheGetMaybe, cacheSetMaybe } from './cache';

const KEY = 'nps_test_key';
const TTL = 30 * 24 * 60 * 60 * 1000;

beforeEach(() => localStorage.clear());

test('a cached hit round-trips through the maybe pair', () => {
  cacheSetMaybe(KEY, { score: 42 });
  expect(cacheGetMaybe(KEY, TTL)).toEqual({ value: { score: 42 } });
});

test('a cached miss serves null while the tombstone is fresh', () => {
  cacheSetMaybe(KEY, null);
  expect(cacheGetMaybe(KEY, TTL)).toEqual({ value: null });
});

test('an aged tombstone falls back to a refetch even inside the positive TTL', () => {
  const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
  localStorage.setItem(KEY, JSON.stringify({ data: { __none: true }, ts: sevenHoursAgo }));
  expect(cacheGetMaybe(KEY, TTL)).toBeNull();
});

test('nothing cached means refetch', () => {
  expect(cacheGetMaybe(KEY, TTL)).toBeNull();
});
