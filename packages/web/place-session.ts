// The epoch a place's async work belongs to.
//
// Every continuation in the client has to answer one question — is this result
// still for the place on screen? — and the client answered it three different
// ways (a featureId compare, a generation counter, object identity) and, six
// times, not at all.
//
// The worst of those was silent rather than visible. A summary takes 5-20s and
// renderSummary read the module-global featureId, so pasting a second place
// while the first was still summarizing painted place A's verdict into place
// B's panel — and then auto-searched A's praised **items** against B's
// featureId, producing plausible-looking scored chips for dishes that place has
// never served. No error, just a wrong answer.
//
// beginPlace() is the only supersession primitive now. Per-place single-flights
// live on the handle rather than as file globals, so they can't outlive their
// place either — `ensureHighlightReviews` used to be a bare module global, and a
// click on place B would await a request issued for place A.

export type PlaceEpoch = {
  readonly featureId: string;
  /** False once another place was looked up, or this one was looked up again. */
  readonly alive: boolean;
  /** Calls `fn` only while this epoch is current; returns undefined otherwise. */
  run<T>(fn: () => T): T | undefined;
  /**
   * At most one in-flight promise per key for this epoch. A later epoch starts
   * its own, so a stale request is never adopted by the place that replaced it.
   */
  once(key: string, fn: () => Promise<void>): Promise<void>;
};

let generation = 0;
let current: PlaceEpoch | null = null;

export const beginPlace = (featureId: string): PlaceEpoch => {
  const gen = ++generation;
  const inflight = new Map<string, Promise<void>>();
  const epoch: PlaceEpoch = {
    featureId,
    get alive() { return gen === generation; },
    run(fn) { return epoch.alive ? fn() : undefined; },
    once(key, fn) {
      const running = inflight.get(key);
      if (running) return running;
      const p = fn().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
  current = epoch;
  return epoch;
};

/** The place on screen, or null before the first lookup. */
export const currentPlace = (): PlaceEpoch | null => current;

/** Ends the current epoch without starting another (the panel was cleared). */
export const endPlace = (): void => {
  generation++;
  current = null;
};
