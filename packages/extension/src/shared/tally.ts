import type { TallyEvent, Thread, ThreadAskEvent, ThreadTurn } from '@truescore/gmaps-shared';

// A Thread's Tally, and the questions asked of it, come from the truescore
// server through the background worker, which carries the server's password
// (background.ts); the page's script never sees it.
export const TALLY_PORT = 'truescore-tally';
// `chat`: a question asked of the Thread (ThreadAskRequest) rather than its Tally.
export type TallyAsk = { thread: Thread; chat?: ThreadTurn[] };

type Failed = { type: 'error'; error: string };
// Streams the server's events to `onEvent`; the returned function stops it.
const request = <E extends { type: string }>(ask: TallyAsk, onEvent: (e: E | Failed) => void): (() => void) => {
  const port = chrome.runtime.connect({ name: TALLY_PORT });
  let over = false;
  port.onMessage.addListener((e: E) => {
    if (e.type === 'done' || e.type === 'error') over = true;
    onEvent(e);
  });
  port.onDisconnect.addListener(() => { if (!over) onEvent({ type: 'error', error: "Couldn't reach the TrueScore server" }); });
  port.postMessage(ask);
  return () => { over = true; port.disconnect(); };
};

export const requestTally = (thread: Thread, onEvent: (e: TallyEvent) => void) => request({ thread }, onEvent);
// The answer to the last question in `chat`, as it's written.
export const askThread = (thread: Thread, chat: ThreadTurn[], onEvent: (e: ThreadAskEvent) => void) => request({ thread, chat }, onEvent);

// Whether the server's password is set: without it the server counts nothing,
// so there's no link to offer.
export const tallyReady = (): Promise<boolean> =>
  chrome.runtime.sendMessage({ type: 'tallyReady' }).then(Boolean, () => false);
