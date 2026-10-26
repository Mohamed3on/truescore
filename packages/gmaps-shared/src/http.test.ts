import { test, expect, describe, afterEach } from 'bun:test';
import { readNdjson, streamNdjson, streamSummary } from './http';
import type { SummaryEvent } from './wire';

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
};

// A fetch that answers every request with `respond()`.
const fakeFetch = (respond: () => Response): typeof fetch => Object.assign(async () => respond(), { preconnect: fetch.preconnect });

const drain = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];

  for await (const e of gen) out.push(e);

  return out;
};

describe('readNdjson', () => {
  test('yields one event per line', async () => {
    const out = await drain(readNdjson(streamOf('{"type":"a"}\n{"type":"b"}\n')));
    expect(out).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  test('buffers a partial line split across chunks', async () => {
    // The event boundary falls mid-object between the two reads.
    const out = await drain(readNdjson(streamOf('{"type":"a","n":1}\n{"type":"b"', ',"n":2}\n')));
    expect(out).toEqual([{ type: 'a', n: 1 }, { type: 'b', n: 2 }]);
  });

  test('skips blank and unparseable lines without aborting the stream', async () => {
    const out = await drain(readNdjson(streamOf('\n{"type":"a"}\nnot json\n{"type":"b"}\n')));
    expect(out).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  test('a trailing line without a newline stays buffered (the NDJSON contract terminates every event)', async () => {
    const out = await drain(readNdjson(streamOf('{"type":"a"}\n{"type":"b"}')));
    expect(out).toEqual([{ type: 'a' }]);
  });
});

describe('streamNdjson', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  const mockNdjson = (bodyText: string, status = 200) => {
    globalThis.fetch = fakeFetch(() =>
      new Response(bodyText, { status, headers: { 'content-type': 'application/x-ndjson' } }));
  };

  test('yields events until a server error event, then throws', async () => {
    mockNdjson('{"type":"data","v":1}\n{"type":"error","error":"boom"}\n{"type":"data","v":2}\n');
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const e of streamNdjson('/api/x', { url: 'x' })) seen.push(e);
      })()
    ).rejects.toThrow('boom');
    expect(seen).toEqual([{ type: 'data', v: 1 }]); // data before the error was delivered
  });

  test('rejects a non-NDJSON response', async () => {
    globalThis.fetch = fakeFetch(() =>
      new Response('{"error":"nope"}', { status: 500, headers: { 'content-type': 'application/json' } }));
    await expect(drain(streamNdjson('/api/x', { url: 'x' }))).rejects.toThrow('nope');
  });
});

describe('streamSummary', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  test('grows the drafts frame by frame up to the newest, then resolves to the checked summary', async () => {
    const line = (l: SummaryEvent) => new TextEncoder().encode(JSON.stringify(l) + '\n');

    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(line({ type: 'summary-draft', summary: { verdict: 'Go', highlights: [] } }));
        c.enqueue(line({ type: 'summary-draft', summary: { verdict: 'Good food, fair prices', highlights: [{ text: 'Fast', sentiment: 'positive' }] } }));
        await new Promise((r) => setTimeout(r, 300));
        c.enqueue(line({ type: 'summary', summary: { verdict: 'Good', highlights: [{ text: 'Fast', sentiment: 'positive', support: 3 }] }, cached: false }));
        c.close();
      },
    });

    globalThis.fetch = fakeFetch(() => new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }));
    const drafts: string[] = [];
    const done = await streamSummary('/api/summarize', { featureId: 'p' }, (d) => drafts.push(d.verdict));
    expect(drafts.length).toBeGreaterThan(2);
    expect(drafts.every((v, i) => 'Good food, fair prices'.startsWith(v) && v.length >= (drafts[i - 1]?.length ?? 0))).toBe(true);
    expect(drafts.at(-1)).toBe('Good food, fair prices');
    expect(done.summary?.highlights[0]?.support).toBe(3);
  });

  test('throws when the stream closes without a summary', async () => {
    globalThis.fetch = fakeFetch(() => new Response('{"type":"summary-draft","summary":{"verdict":"Go","highlights":[]}}\n', { headers: { 'content-type': 'application/x-ndjson' } }));
    await expect(streamSummary('/api/summarize', { featureId: 'p' }, () => {})).rejects.toThrow('without a summary');
  });
});
