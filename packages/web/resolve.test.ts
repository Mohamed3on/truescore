import { test, expect, afterEach, afterAll, spyOn } from 'bun:test';
import { resolvePlace } from './resolve';

const origFetch = globalThis.fetch;
const sleepSpy = spyOn(Bun, 'sleep').mockImplementation(() => Promise.resolve());

afterEach(() => { globalThis.fetch = origFetch; });

afterAll(() => sleepSpy.mockRestore());

const shared = 'https://maps.app.goo.gl/71M8xCv3vTbPHZHP8?g_st=com.apple.shortcuts.Run-Workflow.(null)';

test("a just-shared link's first seconds of 404s wait it out rather than fail", async () => {
  // Google's shortener 404s about half of new links for ~3.3s, and a share's lookup lands inside that.
  let heads = 0;
  // SAFETY: resolvePlace only calls fetch, never fetch.preconnect.
  globalThis.fetch = (async (_input: string) => ++heads <= 7
    ? new Response(null, { status: 404 })
    : new Response(null, { status: 302, headers: { location: 'https://maps.google.com/?q=Kinder+Kiez+Club,+Triftstra%C3%9Fe+52,+13353+Berlin&ftid=0x47a851ed5127e1fb:0x6aef160de6545e5b&entry=gps' } })) as typeof fetch;
  expect((await resolvePlace(shared)).featureId).toBe('0x47a851ed5127e1fb:0x6aef160de6545e5b');
});

test('a link that never resolves still fails', async () => {
  // SAFETY: resolvePlace only calls fetch, never fetch.preconnect.
  globalThis.fetch = (async (_input: string) => new Response(null, { status: 404 })) as typeof fetch;
  await expect(resolvePlace(shared)).rejects.toThrow('no place id in URL');
});
