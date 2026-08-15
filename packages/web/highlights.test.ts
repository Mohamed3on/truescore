import { test, expect, describe, mock, spyOn, beforeEach, afterAll } from 'bun:test';
import * as realBrowser from './browser';

// The harvest's whole job is telling "Google says this place has no topic chips"
// apart from "we never got a usable answer" — a distinction the cache turns into
// a six-hour blank highlights row. Drive it through a stubbed preview fetch.
const shots: Array<() => Promise<unknown>> = [];
let calls = 0;
const fetchPlacePreview = mock(() => {
  const next = shots[Math.min(calls++, shots.length - 1)];
  return next ? next() : Promise.resolve(preview([]));
});

// Keep the rest of the module intact — gmaps/maps-creds import googleFetch and
// friends off it, and a bare factory would blank those out.
await mock.module('./browser', () => ({ ...realBrowser, fetchPlacePreview }));
// Skip the 2.5s inter-round spacing; the timing is politeness, not behaviour.
const sleepSpy = spyOn(Bun, 'sleep').mockImplementation(() => Promise.resolve());

const { harvestQuick, harvestTokens } = await import('./highlights');

// Minimal shape of the preview RPC payload: chips live at [6][153][0].
const preview = (chips: Array<[string, string]>) => {
  const six: any[] = [];
  six[153] = [chips.map(([token, label]) => [[token], label, null, [null, null, null, null, 7]])];
  return [null, null, null, null, null, null, six];
};

const ok = (chips: Array<[string, string]>) => () => Promise.resolve(preview(chips));
const boom = (msg = 'googleFetch 429') => () => Promise.reject(new Error(msg));

beforeEach(() => {
  shots.length = 0;
  calls = 0;
  fetchPlacePreview.mockClear();
});
afterAll(() => sleepSpy.mockRestore());

describe('harvestQuick', () => {
  test('returns the first populated shot', async () => {
    shots.push(ok([]), ok([]), ok([['tok-a', 'pho']]), ok([]), ok([]));
    expect(await harvestQuick('https://www.google.com/maps?q=&ftid=0x1:0x2')).toEqual({
      chips: [{ token: 'tok-a', label: 'pho', count: 7 }],
      ok: true,
    });
  });

  test('an empty-but-answered round is ok — the place has no topics', async () => {
    shots.push(ok([]));
    expect(await harvestQuick('u')).toEqual({ chips: [], ok: true });
  });

  test('a round where every shot threw is NOT ok — nothing was learned', async () => {
    shots.push(boom());
    expect(await harvestQuick('u')).toEqual({ chips: [], ok: false });
  });

  test('one surviving shot is enough to trust the empty', async () => {
    shots.push(boom(), boom(), boom(), boom(), ok([]));
    expect(await harvestQuick('u')).toEqual({ chips: [], ok: true });
  });
});

describe('harvestTokens', () => {
  test('stops as soon as a round lands chips', async () => {
    shots.push(ok([]), ok([]), ok([['tok-b', 'elevator']]), ok([]));
    const { chips, ok: clean } = await harvestTokens('u');
    expect(chips).toEqual([{ token: 'tok-b', label: 'elevator', count: 7 }]);
    expect(clean).toBe(true);
    expect(fetchPlacePreview.mock.calls.length).toBe(3); // one round, not the full budget
  });

  test('gives up early — and reports !ok — when every shot keeps failing', async () => {
    shots.push(boom());
    const { chips, ok: clean } = await harvestTokens('u');
    expect(chips).toEqual([]);
    expect(clean).toBe(false);
    expect(fetchPlacePreview.mock.calls.length).toBe(9); // 3 dead rounds × 3 shots, not 15 rounds
  });

  test('a dead round resets once a later round answers, and the empty is trusted', async () => {
    // dead, dead, then answered-but-empty for the rest of the budget.
    shots.push(boom(), boom(), boom(), boom(), boom(), boom(), ok([]));
    const { chips, ok: clean } = await harvestTokens('u');
    expect(chips).toEqual([]);
    expect(clean).toBe(true); // a real answer arrived, so "no topics" is Google's verdict
    expect(fetchPlacePreview.mock.calls.length).toBe(45); // ran the full 15 × 3 budget
  });
});
