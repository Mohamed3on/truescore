import { test, expect } from 'bun:test';
import { createInflight } from './inflight';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('run coalesces concurrent callers by key — fn runs once', async () => {
  const flight = createInflight<number>();
  const d = deferred<number>();
  let calls = 0;
  const fn = () => { calls++; return d.promise; };
  const a = flight.run('k', fn);
  const b = flight.run('k', fn);
  expect(a).toBe(b);
  expect(calls).toBe(1);
  d.resolve(42);
  expect(await a).toBe(42);
  expect(await b).toBe(42);
});

test('distinct keys do not coalesce', () => {
  const flight = createInflight<number>();
  let calls = 0;
  const fn = () => { calls++; return new Promise<number>(() => {}); };
  flight.run('a', fn);
  flight.run('b', fn);
  expect(calls).toBe(2);
});

test('entry clears once settled — next run re-invokes fn', async () => {
  const flight = createInflight<number>();
  let calls = 0;
  const run = () => flight.run('k', () => { calls++; return Promise.resolve(calls); });
  expect(await run()).toBe(1);
  expect(await run()).toBe(2);
});

test('peek exposes the in-flight promise, undefined otherwise', async () => {
  const flight = createInflight<number>();
  const d = deferred<number>();
  expect(flight.peek('k')).toBeUndefined();
  const p = flight.run('k', () => d.promise);
  expect(flight.peek('k')).toBe(p);
  d.resolve(1);
  await p;
  expect(flight.peek('k')).toBeUndefined();
});

test('rejection propagates and clears so the next run retries', async () => {
  const flight = createInflight<number>();
  let calls = 0;
  const run = () => flight.run('k', () => { calls++; return Promise.reject(new Error('boom')); });
  await expect(run()).rejects.toThrow('boom');
  await expect(run()).rejects.toThrow('boom');
  expect(calls).toBe(2);
});
