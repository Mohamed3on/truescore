import type { Chip, ChipMeta, PartialScore } from '@truescore/gmaps-shared';

// Shared protocol constants for the gmaps content scripts. ISOLATED-world
// gmaps-bridge.ts proxies chrome.storage; MAIN-world gmaps-capture.ts emits
// PREVIEW_CAPTURED so harvesters can wake on the event instead of polling.
export const STORAGE_GET = 'truescore-storage-get';
export const STORAGE_SET = 'truescore-storage-set';
export const STORAGE_RESULT = 'truescore-storage-result';
export const PREVIEW_CAPTURED = 'truescore-preview-captured';
// The popup's model choices for Maps summaries and Asks, which MAIN-world gmaps.ts
// can't read from chrome.storage.sync itself. Answered with just the provider and
// reasoning effort, never a raw sync read: sync storage also holds the API keys,
// and any script on the page can dispatch this event.
export const LLM_SETTINGS_GET = 'truescore-llm-settings-get';
// Botguard creds lifted off Google's own ListUgcPosts batchexecute XHR. The session
// they carry is cached per account and replayed, each request signed by the page;
// legacy GET /maps/rpc/listugcposts is retired.
export const MAPS_CREDS_CAPTURED = 'truescore-maps-creds-captured';
// Ask the background worker to score a place server-side. /api/lookup is
// deliberately same-origin only (it triggers a real scrape), so a content-script
// fetch is refused by CORS; the worker holds the host permission and isn't
// subject to it. The bridge holds a port to the worker for the request and relays
// each ServerScoreMessage it posts as a RESULT event.
export const SERVER_SCORE_GET = 'truescore-server-score-get';
export const SERVER_SCORE_RESULT = 'truescore-server-score-result';
export const SERVER_SCORE_PORT = 'truescore-server-score';
// Posted as the server's streams land: each usable score, then the place's topic
// chips — `pending` while the server harvests them, `candidates` once it's scoring
// them, each `chip` with its reviews — and `end` when the port closes.
export type ServerScoreMessage =
  | { kind: 'score'; score: PartialScore }
  | { kind: 'pending' }
  | { kind: 'candidates'; chips: ChipMeta[] }
  | { kind: 'chip'; chip: Chip }
  | { kind: 'end' };

export type MapsCapturedCreds = { bgkey: string; bgbind: string; sessionId: string; at: string; authuser?: string; ts: number };

declare global {
  interface Window {
    __truescorePreviews?: Record<string, { json: any; ts: number }>;
    __truescorePreviewCapture?: boolean;
    __truescoreMapsCreds?: MapsCapturedCreds;
    __truescoreRequestMapsCreds?: () => Promise<MapsCapturedCreds | null>;
    __truescoreSignMaps?: (request: string) => Promise<string | null>;
    __truescoreGmaps?: { fetchLabelSearch: (query: string) => Promise<unknown[]> } & Record<string, unknown>;
  }
}
