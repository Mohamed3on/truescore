import type { Chip, ChipMeta, PartialScore, Review } from '@truescore/gmaps-shared';

// Shared protocol constants for the gmaps content scripts. ISOLATED-world
// gmaps-bridge.ts proxies chrome.storage; MAIN-world gmaps-capture.ts emits
// PREVIEW_CAPTURED so harvesters can wake on the event instead of polling.
// A STORAGE_REQUEST names an op of shared/cache.ts's Backend; the bridge runs it
// in its own host's namespace, so a page script can never reach another site's data.
export const STORAGE_REQUEST = 'truescore-storage-request';
export const STORAGE_RESULT = 'truescore-storage-result';

export type StorageOp = 'get' | 'set' | 'remove' | 'entries';

// What a bridge request carries besides its id: a storage op and its arguments,
// or nothing (LLM_SETTINGS_GET).
export type BridgePayload = { op?: StorageOp; key?: string; value?: any; prefix?: string };

export const PREVIEW_CAPTURED = 'truescore-preview-captured';

// The popup's model choices for Maps summaries and Asks, which MAIN-world gmaps.ts
// can't read from chrome.storage.sync itself. Answered with just the provider and
// reasoning effort, never a raw sync read: sync storage also holds the API keys,
// and any script on the page can dispatch this event.
export const LLM_SETTINGS_GET = 'truescore-llm-settings-get';

// A breakage check MAIN-world gmaps.ts can't report itself (shared/breakage.ts):
// the detail is a check name the bridge maps to its own fixed selector.
export const EXPECT_MOUNT = 'truescore-expect-mount';

// Botguard creds lifted off Google's own ListUgcPosts batchexecute request. The session
// they carry is kept and replayed, each request signed by the page;
// legacy GET /maps/rpc/listugcposts is retired.
export const MAPS_CREDS_CAPTURED = 'truescore-maps-creds-captured';

// Ask the background worker to score a place server-side — or, given a `query`,
// search its reviews there. /api/lookup and /api/search are same-origin only (a
// lookup triggers a real scrape), so a content-script fetch is refused by CORS;
// the worker holds the host permission and isn't subject to it. The bridge holds a
// port to the worker for the request and relays each ServerScoreMessage it posts
// as a RESULT event, always ending with `end`.
export const SERVER_SCORE_GET = 'truescore-server-score-get';
export const SERVER_SCORE_RESULT = 'truescore-server-score-result';
export const SERVER_SCORE_PORT = 'truescore-server-score';

// Posted as the server's streams land: each usable score, then the place's topic
// chips — `pending` while the server harvests them, `candidates` once it's scoring
// them, each `chip` with its reviews. A search posts its running match count
// (`found`), then the matches (`search`). `end` when the port closes.
export type ServerScoreMessage =
  | { kind: 'score'; score: PartialScore }
  | { kind: 'pending' }
  | { kind: 'candidates'; chips: ChipMeta[] }
  | { kind: 'chip'; chip: Chip }
  | { kind: 'found'; found: number }
  | { kind: 'search'; reviews: Review[] }
  | { kind: 'end' };

export type MapsCapturedCreds = { bgkey: string; bgbind: string; sessionId: string; at: string; authuser?: string; ts: number };

declare global {
  interface Window {
    __truescorePreviews?: Record<string, { json: any; ts: number }>;
    __truescoreMapsCreds?: MapsCapturedCreds;
    __truescoreRequestMapsCreds?: () => Promise<MapsCapturedCreds | null>;
    __truescoreSignMaps?: (request: string) => Promise<string | null>;
  }
}

// MAIN world's line to gmaps-bridge: dispatches the request and resolves with the
// bridge's STORAGE_RESULT reply, or null after a timeout (an extension reload
// mid-flight drops the reply; without it the listener and promise leak forever).
const BRIDGE_TIMEOUT_MS = 5000;
let nextRequestId = 0;

export const bridgeRequest = <T>(eventName: string, payload: BridgePayload): Promise<T | null> => new Promise((resolve) => {
  const id = String(++nextRequestId);

  const cleanup = () => {
    document.removeEventListener(STORAGE_RESULT, handler);
    clearTimeout(timer);
  };

  const handler = (e: Event) => {
    // SAFETY: gmaps-bridge sends STORAGE_RESULT as a CustomEvent; anything else has
    // no detail and fails the id check.
    const detail = (e as CustomEvent).detail;

    if (detail?.id !== id) return;
    cleanup();
    resolve(detail.value);
  };

  const timer = setTimeout(() => { cleanup(); resolve(null); }, BRIDGE_TIMEOUT_MS);
  document.addEventListener(STORAGE_RESULT, handler);
  document.dispatchEvent(new CustomEvent(eventName, { detail: { id, ...payload } }));
});
