import { test, expect, describe } from 'bun:test';
import { firstOf } from './maps-minter';

// Attempts that settle when the test says so, each recording whether it was stopped.
const attempts = () => {
  const runs: Array<{ settle: (ok: boolean) => void; stopped: boolean }> = [];
  const attempt = () => new Promise<{ n: number; stop: () => void }>((resolve, reject) => {
    const n = runs.length;
    const run = { stopped: false, settle: (ok: boolean) => (ok ? resolve({ n, stop: () => { run.stopped = true; } }) : reject(new Error('capped'))) };
    runs.push(run);
  });
  return { runs, attempt };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('firstOf', () => {
  test('replaces a failed attempt at once, without waiting on the others', async () => {
    const { runs, attempt } = attempts();
    const won = firstOf(attempt, 3, 6);
    expect(runs).toHaveLength(3);
    runs[0]!.settle(false);
    await tick();
    expect(runs).toHaveLength(4); // while the other two still run
    runs[3]!.settle(true);
    expect((await won)?.n).toBe(3);
  });

  test('keeps the first success, stops any that land after it, and starts no more', async () => {
    const { runs, attempt } = attempts();
    const won = firstOf(attempt, 3, 6);
    runs[1]!.settle(true);
    runs[0]!.settle(true);
    runs[2]!.settle(false);
    expect((await won)?.n).toBe(1);
    await tick();
    expect(runs.map((r) => r.stopped)).toEqual([true, false, false]);
    expect(runs).toHaveLength(3);
  });

  test('gives up with null once every attempt has failed', async () => {
    const { runs, attempt } = attempts();
    const won = firstOf(attempt, 3, 6);
    for (let i = 0; i < 6; i++) {
      runs[i]!.settle(false);
      await tick();
    }
    expect(await won).toBeNull();
    expect(runs).toHaveLength(6);
  });
});
