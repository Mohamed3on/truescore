// Maps' BotGuard VM for one minted session (see maps-minter). Its interpreter expects a
// DOM on the global object, so it runs here: happy-dom's window and document stay out
// of the server's globals, and each session's VM gets a global of its own (a second
// interpreter in one global breaks the first). happy-dom's script sandbox doesn't run
// it under Bun. Boot with the page's challenge, then each {id, request} gets {id, key}.
import { Window } from 'happy-dom';

type Snapshot = (done: (key: string) => void, args: unknown[]) => void;

// The VM the interpreter defines: booted with the program, it hands back its snapshot.
type BotGuard = { a: (program: string, ready: (fn: Snapshot) => void, ...rest: unknown[]) => void };

let snapshot: Snapshot;

self.onmessage = ({ data }: MessageEvent) => {
  if (data.request === undefined) {
    const window = new Window({ url: 'https://www.google.com/maps', settings: { navigator: { userAgent: data.userAgent } } });
    Object.assign(globalThis, { window, document: window.document });
    new Function(data.interpreter)();
    // SAFETY: the interpreter just run defines its VM on the global, under the page's globalName.
    (globalThis as typeof globalThis & Record<string, BotGuard>)[data.globalName]!.a(data.program, (fn: Snapshot) => { snapshot = fn; postMessage('ready'); }, true, undefined, () => {}, [[], []]);

    return;
  }

  // A VM failure comes back as the key ("E:" + the error), which no header can carry.
  snapshot((key) => postMessage({ id: data.id, key: key.startsWith('E:') ? null : key }), [{ request: data.request }, undefined, undefined, undefined]);
};
