import { test, expect, describe } from 'bun:test';
import { beginPlace, currentPlace, endPlace } from './place-session';

describe('place epoch', () => {
  test('the newest place is the live one; the one it replaced is not', () => {
    const a = beginPlace('0x1:0x1');
    expect(a.alive).toBe(true);
    const b = beginPlace('0x2:0x2');
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(true);
    expect(currentPlace()).toBe(b);
  });

  test('re-looking-up the same place still supersedes the previous epoch', () => {
    const first = beginPlace('0x1:0x1');
    const second = beginPlace('0x1:0x1');
    expect(first.alive).toBe(false);
    expect(second.alive).toBe(true);
  });

  test('run skips a continuation belonging to a superseded place', () => {
    const a = beginPlace('0x1:0x1');
    let painted = '';
    expect(a.run(() => (painted = 'A'))).toBe('A');
    beginPlace('0x2:0x2');
    // This is the contamination: place A's summary landing after place B was
    // pasted used to paint into B's panel.
    expect(a.run(() => (painted = 'A again'))).toBeUndefined();
    expect(painted).toBe('A');
  });

  test('once single-flights per place, so B never adopts A request', async () => {
    const a = beginPlace('0x1:0x1');
    let aRuns = 0;
    const p1 = a.once('reviews', async () => { aRuns++; await Promise.resolve(); });
    const p2 = a.once('reviews', async () => { aRuns++; });
    expect(p1).toBe(p2);
    await p1;
    expect(aRuns).toBe(1);

    const b = beginPlace('0x2:0x2');
    let bRuns = 0;
    await b.once('reviews', async () => { bRuns++; });
    expect(bRuns).toBe(1);
  });

  test('a settled key can run again for the same place', async () => {
    const a = beginPlace('0x1:0x1');
    let runs = 0;
    await a.once('reviews', async () => { runs++; });
    await a.once('reviews', async () => { runs++; });
    expect(runs).toBe(2);
  });

  test('endPlace leaves nothing live', () => {
    const a = beginPlace('0x1:0x1');
    endPlace();
    expect(a.alive).toBe(false);
    expect(currentPlace()).toBeNull();
  });
});
