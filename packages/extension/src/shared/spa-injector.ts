interface SpaInjectorOpts<T> {
  match: () => unknown;
  load: () => Promise<T | null>;
  inject: (data: T) => void;
  cleanup: () => void;
}

export const setupSpaInjector = <T>({ match, load, inject, cleanup }: SpaInjectorOpts<T>) => {
  let generation = 0;
  let activeObs: MutationObserver | null = null;

  const fullCleanup = () => {
    if (activeObs) { activeObs.disconnect(); activeObs = null; }
    cleanup();
  };

  const init = async () => {
    if (!match()) return;
    const gen = ++generation;
    fullCleanup();

    const data = await load();
    if (gen !== generation || data == null) return;

    const run = () => {
      if (gen !== generation) return;
      inject(data);
    };
    run();
    activeObs = new MutationObserver(run);
    activeObs.observe(document.body, { childList: true, subtree: true });
  };

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (match()) init();
    else fullCleanup();
  }).observe(document, { childList: true, subtree: true });

  init();
};
