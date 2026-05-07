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
  const onUrlChange = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (match()) init();
    else fullCleanup();
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
