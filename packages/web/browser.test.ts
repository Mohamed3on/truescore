import { test, expect, describe, afterEach } from 'bun:test';
import { assertGoogleHost } from './browser';

describe('fetchPlacePreview', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  test("replays a place's preview URL, reading its page again only when a replay fails", async () => {
    // A fresh instance: highlights.test.ts mocks this export, and bun's module
    // mocks outlive their file.
    const { fetchPlacePreview, setGoogleCookieOverride } = await import(`./browser?${Math.random()}`) as typeof import('./browser');
    setGoogleCookieOverride('SID=test'); // no jar to bake
    const place = 'https://www.google.com/maps?q=&ftid=0x1:0x2';
    let pages = 0;
    const gone = new Set<string>();
    // Each read of the page embeds a new preview URL; a preview answers with its own URL.
    globalThis.fetch = (async (input: string) => {
      if (input === place) return new Response(`<link href="/maps/preview/place?pb=!1s${++pages}&amp;authuser=0" rel="preload">`);
      const pb = new URL(input).searchParams.get('pb')!;
      return gone.has(pb) ? new Response('gone', { status: 400 }) : new Response(`)]}'\n${JSON.stringify([pb, input])}`);
    }) as unknown as typeof fetch;

    const [pb, url] = await fetchPlacePreview(place);
    expect([pb, pages]).toEqual(['!1s1', 1]);
    expect(url).toContain('hl=en');
    expect(url).toContain('gl=us');
    expect((await fetchPlacePreview(place))[0]).toBe('!1s1');
    expect(pages).toBe(1); // replayed, not read again

    gone.add('!1s1');
    expect((await fetchPlacePreview(place))[0]).toBe('!1s2');
    expect(pages).toBe(2); // the failed replay read the page for a fresh URL
    expect((await fetchPlacePreview(place))[0]).toBe('!1s2');
    expect(pages).toBe(2);
  });
});

describe('assertGoogleHost', () => {
  test('allows google.com and its subdomains', () => {
    expect(() => assertGoogleHost('https://www.google.com/maps/rpc/listugcposts?x=1')).not.toThrow();
    expect(() => assertGoogleHost('https://google.com/maps?q=&ftid=0x1:0x2')).not.toThrow();
    expect(() => assertGoogleHost('https://maps.google.com/anything')).not.toThrow();
  });

  test('rejects non-Google hosts', () => {
    expect(() => assertGoogleHost('http://attacker.example/x?ftid=0x1:0x2')).toThrow();
    expect(() => assertGoogleHost('http://localhost:3000/')).toThrow();
    expect(() => assertGoogleHost('http://169.254.169.254/latest/meta-data/')).toThrow();
  });

  test('rejects look-alike hosts that only contain "google.com" as a substring', () => {
    expect(() => assertGoogleHost('https://google.com.attacker.example/x')).toThrow();
    expect(() => assertGoogleHost('https://notgoogle.com/x')).toThrow();
    expect(() => assertGoogleHost('https://evilgoogle.com/x')).toThrow();
  });

  test('rejects a malformed URL', () => {
    expect(() => assertGoogleHost('not a url')).toThrow();
  });
});
