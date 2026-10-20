// Client-side HTTP transport for the web client and the extension:
// fetch-with-retry (Cloudflare 5xx returns an HTML error page that would blow up
// resp.json() as "Unexpected token '<'"), the JSON helpers, and the NDJSON stream
// reader used by /api/lookup, /api/search, /api/highlights, /api/ask.
// DOM-free (bar the summary drafts' requestAnimationFrame) so it's unit-testable in bun without a browser (fetch /
// ReadableStream / TextDecoder are all globals).
import { DRAFT_MS, type SummaryDraft, type SummaryEvent } from './wire';

const RETRY_STATUSES = new Set([502, 503, 504, 521, 522, 524]);

export async function fetchWithRetry(input: RequestInfo, init?: RequestInit, retries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetch(input, init);
      if (!RETRY_STATUSES.has(resp.status) || attempt >= retries) return resp;
    } catch (e) {
      if (attempt >= retries || init?.signal?.aborted) throw e;
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

export async function postNdjson(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return ndjsonResponse(await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }));
}

// An NDJSON POST's response, checked: a JSON error body throws its message, and
// anything but a stream throws.
export async function ndjsonResponse(resp: Response): Promise<Response> {
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
export async function* streamNdjson<T extends { type: string }>(url: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
  const resp = await postNdjson(url, body, signal);
  for await (const evt of readNdjson<T>(resp.body!)) {
    if (evt.type === 'error') throw new Error((evt as { error?: string }).error || 'request failed');
    yield evt;
  }
}

// A summary route asked to `stream`: `onDraft` gets each draft as the model
// writes it; resolves to the checked summary (or the cached one, alone), with
// `later`: the aliases that follow it on the stream, if any.
export async function streamSummary(url: string, body: unknown, onDraft: (draft: SummaryDraft) => void, signal?: AbortSignal) {
  const events = streamNdjson<SummaryEvent>(url, body, signal);
  const drafts = smoothDrafts(onDraft);
  try {
    for (let next = await events.next(); !next.done; next = await events.next()) {
      const evt = next.value;
      if (evt.type === 'summary-draft') drafts.push(evt.summary);
      else if (evt.type === 'summary') return { ...evt, later: lateAliases(events) };
    }
  } finally {
    drafts.stop();
  }
  throw new Error('the summary stream closed without a summary');
}

// Drafts land in clumps, a few words each, one per DRAFT_MS. Passed on frame by
// frame instead, each string growing by its share of what it has left, so the
// text flows in and catches up just as the next draft is due. `stop` before
// drawing the checked summary, so no draft lands after it. Another shape of
// draft (the extension's streamed partials, bursty rather than periodic) brings
// its own `step`, growing each of its strings with `grow`.
type DraftStep<T> = (shown: T | undefined, target: T, grow: (from: string | undefined, to: string) => string) => T;
const stepSummary: DraftStep<SummaryDraft> = (shown, target, grow) => ({
  verdict: grow(shown?.verdict, target.verdict),
  highlights: target.highlights.map((h, i) => ({ ...h, text: grow(shown?.highlights[i]?.text, h.text) })),
});
export const smoothDrafts = <T = SummaryDraft>(onDraft: (draft: T) => void, step = stepSummary as unknown as DraftStep<T>) => {
  let target: T | undefined;
  let shown: T | undefined;
  let due = 0;
  let last = 0;
  let frame: number | undefined;
  const tick = () => {
    frame = undefined;
    if (!target) return;
    const now = performance.now();
    const share = Math.min(1, (now - last) / Math.max(1, due - last));
    last = now;
    shown = step(shown, target, (from = '', to) => to.slice(0, from.length + Math.ceil((to.length - from.length) * share)));
    onDraft(shown);
    if (share < 1) frame = requestAnimationFrame(tick);
  };
  return {
    push(draft: T) {
      target = draft;
      last = performance.now();
      due = last + DRAFT_MS;
      frame ??= requestAnimationFrame(tick);
    },
    stop() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = target = undefined;
    },
  };
};

const lateAliases = async (events: AsyncGenerator<SummaryEvent>): Promise<Record<string, string[]> | undefined> => {
  try {
    for await (const evt of events) if (evt.type === 'aliases') return evt.aliases;
  } catch {}
  return undefined;
};
