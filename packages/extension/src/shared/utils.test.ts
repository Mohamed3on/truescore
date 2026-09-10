import { test, expect, describe } from 'bun:test';
import { npsStats } from './utils';

describe('npsStats', () => {
  test('a product with more 1★ than 5★ scores negative', () => {
    expect(npsStats(10, 90, 200)).toEqual({ score: -32, nps: -40 });
    expect(npsStats(90, 10, 200)).toEqual({ score: 32, nps: 40 });
  });
});
