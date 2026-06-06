// Coalesce concurrent work by key. The first caller for a key runs `fn`; callers
// that arrive while it's in flight share the same promise, and the entry clears
// once it settles (so the next caller re-runs). `peek` exposes the in-flight
// promise so a separate path can await work someone else started — the
// highlights recompute kicked off inside revalidate, awaited by the cache-hit
// lookup stream — without starting its own.
export type Inflight<V> = {
  run: (key: string, fn: () => Promise<V>) => Promise<V>;
  peek: (key: string) => Promise<V> | undefined;
};

export function createInflight<V>(): Inflight<V> {
  const map = new Map<string, Promise<V>>();
  return {
    run(key, fn) {
      const existing = map.get(key);
      if (existing) return existing;
      const p = fn().finally(() => map.delete(key));
      map.set(key, p);
      return p;
    },
    peek(key) {
      return map.get(key);
    },
  };
}
