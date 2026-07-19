interface SpaInjectorOpts<T> {
  match: () => unknown;
  load: () => Promise<T | null>;
  inject: (data: T) => void;
  cleanup: () => void;
  // When set, retry load() — debounced on body mutations — until it returns
  // non-null, instead of calling it once per navigation. For PDPs whose id/data
  // arrives in late DOM (the host renders the product after the route commits),
  // so a single load() at nav time would miss it. See docs/adr/0001.
  retryUntilLoaded?: boolean;
}

export const setupSpaInjector = <T>({ match, load, inject, cleanup, retryUntilLoaded }: SpaInjectorOpts<T>) => {
  let generation = 0;
  let activeObs: MutationObserver | null = null;
  let retryObs: MutationObserver | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let loadingGen = -1;

  const stopRetry = () => {
    if (retryObs) { retryObs.disconnect(); retryObs = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  };

  const fullCleanup = () => {
    stopRetry();
    if (activeObs) { activeObs.disconnect(); activeObs = null; }
    cleanup();
  };

  // Once load() resolves, inject and re-inject on body mutations — the host SPA
  // often swaps the anchor out after we first render.
  const startInjecting = (gen: number, data: T) => {
    stopRetry();
    const run = () => {
      if (gen !== generation) return;
      inject(data);
    };
    run();
    activeObs = new MutationObserver(run);
    activeObs.observe(document.body, { childList: true, subtree: true });
  };

  const attempt = async (gen: number) => {
    if (loadingGen === gen) return; // a load for this generation is already in flight
    loadingGen = gen;
    let data: T | null = null;
    try {
      data = await load();
    } finally {
      if (loadingGen === gen) loadingGen = -1;
    }
    if (gen !== generation || data == null) return;
    startInjecting(gen, data);
  };

  const init = () => {
    if (!match()) return;
    const gen = ++generation;
    fullCleanup();

    if (!retryUntilLoaded) {
      attempt(gen);
      return;
    }

    // Late-DOM case: retry load() (debounced) on body mutations until it resolves,
    // so we read the product's data once the host has finished rendering it.
    const schedule = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (gen === generation && !activeObs) attempt(gen);
      }, 200);
    };
    retryObs = new MutationObserver(schedule);
    retryObs.observe(document.body, { childList: true, subtree: true });
    schedule();
  };

  let lastUrl = location.href;
  const onUrlChange = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (match()) init();
    else {
      // Invalidate any in-flight load() too, or it resolves after this cleanup
      // and injects the abandoned page's UI into the new page, re-inject
      // observer and all.
      generation++;
      fullCleanup();
    }
  };
  // Navigation API covers pushState/replaceState/popstate/hash; falls back to
  // popstate+hashchange on browsers without it. Replaces a body-subtree
  // MutationObserver that ran JS on every DOM mutation just to compare hrefs.
  const nav = (window as any).navigation;
  if (nav?.addEventListener) {
    nav.addEventListener('navigatesuccess', onUrlChange);
  } else {
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);
  }

  init();
};
