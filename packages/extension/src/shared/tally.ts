import type { TallyEvent, Thread } from '@truescore/gmaps-shared';

// A Thread's Tally comes from the truescore server through the background
// worker, which carries the server's password (background.ts); the page's
// script never sees it.
export const TALLY_PORT = 'truescore-tally';
export type TallyAsk = { thread: Thread };

// Streams the Tally's events to `onEvent`; the returned function stops it.
export const requestTally = (thread: Thread, onEvent: (e: TallyEvent) => void): (() => void) => {
  const port = chrome.runtime.connect({ name: TALLY_PORT });
  let over = false;
  port.onMessage.addListener((e: TallyEvent) => {
    if (e.type === 'done' || e.type === 'error') over = true;
    onEvent(e);
  });
  port.onDisconnect.addListener(() => { if (!over) onEvent({ type: 'error', error: "Couldn't reach the TrueScore server" }); });
  port.postMessage({ thread } satisfies TallyAsk);
  return () => { over = true; port.disconnect(); };
};

// Whether the server's password is set: without it the server counts nothing,
// so there's no link to offer.
export const tallyReady = (): Promise<boolean> =>
  chrome.runtime.sendMessage({ type: 'tallyReady' }).then(Boolean, () => false);
