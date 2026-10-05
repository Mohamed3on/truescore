import { test, expect, describe, afterEach } from 'bun:test';
import { readNdjson, streamNdjson, streamSummary } from './http';

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
};

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
    globalThis.fetch = (async () =>
      new Response(bodyText, { status, headers: { 'content-type': 'application/x-ndjson' } })) as unknown as typeof fetch;
  };

  test('yields events until a server error event, then throws', async () => {
    mockNdjson('{"type":"data","v":1}\n{"type":"error","error":"boom"}\n{"type":"data","v":2}\n');
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const e of streamNdjson('/api/x', {})) seen.push(e);
      })()
    ).rejects.toThrow('boom');
    expect(seen).toEqual([{ type: 'data', v: 1 }]); // data before the error was delivered
  });

  test('rejects a non-NDJSON response', async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"nope"}', { status: 500, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(drain(streamNdjson('/api/x', {}))).rejects.toThrow('nope');
  });
});

describe('streamSummary', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  test('hands each draft on, then resolves to the checked summary', async () => {
    const lines = [
      { type: 'summary-draft', summary: { verdict: 'Go', highlights: [] } },
      { type: 'summary-draft', summary: { verdict: 'Good', highlights: [{ text: 'Fast', sentiment: 'positive' }] } },
      { type: 'summary', summary: { verdict: 'Good', highlights: [{ text: 'Fast', sentiment: 'positive', support: 3 }] }, cached: false },
    ];
    globalThis.fetch = (async () => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } })) as unknown as typeof fetch;
    const drafts: string[] = [];
    const done = await streamSummary('/api/summarize', {}, (d) => drafts.push(d.verdict));
    expect(drafts).toEqual(['Go', 'Good']);
    expect(done.summary?.highlights[0]?.support).toBe(3);
  });

  test('throws when the stream closes without a summary', async () => {
    globalThis.fetch = (async () => new Response('{"type":"summary-draft","summary":{"verdict":"Go","highlights":[]}}\n', { headers: { 'content-type': 'application/x-ndjson' } })) as unknown as typeof fetch;
    await expect(streamSummary('/api/summarize', {}, () => {})).rejects.toThrow('without a summary');
  });
});
