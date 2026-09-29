// Since 2026-09-29 Google checks each x-maps-bgkey against the exact review request
// it was minted for, so a captured key replays only its own request and every replay
// needs a key signed for it. Maps mints one per request with its own BotGuard VM, and
// so do we: the extension in the user's Maps tab, the server with the same VM booted
// from a Maps page's challenge (packages/web/maps-minter).

/** Signs one review request: resolves to its x-maps-bgkey, or null when it can't. */
export type Signer = (request: string) => Promise<string | null>;

// What Maps' BotGuard signs for a review request: the inner ListUgcPosts JSON in the
// body's f.req.
export const bgkeyRequestOf = (body: string): string | null => {
  try { return JSON.parse(new URLSearchParams(body).get('f.req') ?? '')[0][0][1] ?? null; } catch { return null; }
};

// A built review request re-keyed for its exact body. Unchanged when there's nothing
// to sign or the signer can't, so the captured key goes out as before.
export const signReq = async <T extends { body?: string; headers?: Record<string, string> }>(init: T | undefined, sign: Signer | undefined): Promise<T | undefined> => {
  const request = init?.body ? bgkeyRequestOf(init.body) : null;
  const key = request && sign ? await sign(request) : null;
  return key ? { ...init!, headers: { ...init!.headers, 'x-maps-bgkey': key } } : init;
};

// Installs window.__truescoreSignMaps in a Maps page; must run before Maps' own
// scripts. Maps hands each request to its VM as {request} and sends the key
// that comes back, building that VM from window.botguard.a, whose ready callback
// delivers the snapshot function. The interpreter keeps its own reference to the
// object and fills it in later, so a get trap (not a setter) is what hands Maps a
// wrapped `a` that keeps the newest one. Signing resolves null until Maps has built
// a VM, which it does the first time it needs a key.
export function installMapsSigner(): void {
  type Snapshot = (done: (key: string) => void, args: unknown[]) => void;
  let snapshot: Snapshot | null = null;
  const wrappedA = new WeakMap<Function, Function>();
  const wrapA = (a: Function) => function (this: unknown, program: unknown, ready: (...fns: any[]) => unknown, ...rest: unknown[]) {
    return a.call(this, program, (...fns: any[]) => { snapshot = fns[0]; return ready(...fns); }, ...rest);
  };
  let botguard: unknown;
  Object.defineProperty(window, 'botguard', {
    configurable: true,
    enumerable: true,
    get: () => botguard,
    set: (v: unknown) => {
      botguard = v && typeof v === 'object' ? new Proxy(v, {
        get: (t: any, k) => {
          const val = t[k];
          if (k !== 'a' || typeof val !== 'function') return val;
          if (!wrappedA.has(val)) wrappedA.set(val, wrapA(val));
          return wrappedA.get(val);
        },
      }) : v;
    },
  });
  (window as any).__truescoreSignMaps = (request: string): Promise<string | null> => new Promise((resolve) => {
    const sign = snapshot;
    if (!sign) return resolve(null);
    const timer = setTimeout(() => resolve(null), 5000);
    sign((key) => { clearTimeout(timer); resolve(key); }, [{ request }, undefined, undefined, undefined]);
  });
}
