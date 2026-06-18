// Shared protocol constants for the gmaps content scripts. ISOLATED-world
// gmaps-bridge.ts proxies chrome.storage; MAIN-world gmaps-capture.ts emits
// PREVIEW_CAPTURED so harvesters can wake on the event instead of polling.
export const STORAGE_GET = 'truescore-storage-get';
export const STORAGE_SET = 'truescore-storage-set';
export const STORAGE_RESULT = 'truescore-storage-result';
export const PREVIEW_CAPTURED = 'truescore-preview-captured';
// Botguard creds lifted off Google's own ListUgcPosts batchexecute XHR. Session-
// bound (reusable across places/sorts/pages/tokens until expiry), so we cache one
// set globally and replay it; legacy GET /maps/rpc/listugcposts is retired.
export const MAPS_CREDS_CAPTURED = 'truescore-maps-creds-captured';

export type MapsCapturedCreds = { bgkey: string; bgbind: string; sessionId: string; at: string; ts: number };

declare global {
  interface Window {
    __truescorePreviews?: Record<string, { json: any; ts: number }>;
    __truescorePreviewCapture?: boolean;
    __truescoreMapsCreds?: MapsCapturedCreds;
    __rcGmapsKeybound?: boolean;
    __truescoreGmaps?: { fetchLabelSearch: (query: string) => Promise<unknown[]> } & Record<string, unknown>;
  }
}
