// Client-side HTTP transport: fetch-with-retry (Cloudflare 5xx returns an HTML
// error page that would blow up resp.json() as "Unexpected token '<'"), the JSON
// helpers, and the NDJSON stream reader used by /api/lookup, /api/search,
// /api/highlights, /api/ask. Deliberately DOM-free so it's unit-testable in
// bun without a browser (fetch / ReadableStream / TextDecoder are all globals).

const RETRY_STATUSES = new Set([502, 503, 504, 521, 522, 524]);

export async function fetchWithRetry(input: RequestInfo, init?: RequestInit, retries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetch(input, init);
      if (!RETRY_STATUSES.has(resp.status) || attempt >= retries) return resp;
    } catch (e) {
      if (attempt >= retries) throw e;
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 200));
  }
}

export async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const resp = await fetchWithRetry(input, init);
  const ct = resp.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new Error(`server returned ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`);
  const data = await resp.json() as T;
  if (!resp.ok) throw new Error((data as { error?: string }).error || `request failed (${resp.status})`);
  return data;
}

export const postJson = <T>(url: string, body: unknown): Promise<T> =>
  fetchJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Stream NDJSON events from a fetch response body. Each JSON-line yields as
// one event; partial lines accumulate in a buffer until the next newline.
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as T;
        } catch {
          console.warn('[readNdjson] skipping unparseable line');
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function postNdjson(url: string, body: unknown): Promise<Response> {
  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ct = resp.headers.get('content-type') ?? '';
  if (!resp.ok && ct.includes('json') && !ct.includes('ndjson')) {
    const data = await resp.json().catch(() => null);
    throw new Error(data?.error || `request failed (${resp.status})`);
  }
  if (!resp.ok) throw new Error(`server returned ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`);
  if (!ct.includes('ndjson') || !resp.body) throw new Error('expected NDJSON stream');
  return resp;
}

// Open an NDJSON POST stream and yield its events, throwing on a server-sent
// `error` event so callers only branch on their own event types.
export async function* streamNdjson<T extends { type: string }>(url: string, body: unknown): AsyncGenerator<T> {
  const resp = await postNdjson(url, body);
  for await (const evt of readNdjson<T>(resp.body!)) {
    if (evt.type === 'error') throw new Error((evt as { error?: string }).error || 'request failed');
    yield evt;
  }
}
