// Host-DOM breakage, reported from real browsing: a script that has a page's data but
// can't find where to show it means the host changed its markup. The background
// worker passes each verdict on to the server, and a GitHub workflow turns them into
// issues (.github/workflows/breakage.yml).
const GRACE_MS = 20_000;

export const reportMount = (check: string, ok: boolean) => {
  // No chrome.runtime in a MAIN-world script or a test.
  globalThis.chrome?.runtime?.sendMessage?.({ type: 'breakage', check, ok })?.catch(() => {});
};

// `selector` should be on the page GRACE_MS from now, unless the page changed meanwhile.
export const expectMount = (check: string, selector: string) => {
  const href = location.href;

  setTimeout(() => {
    if (location.href === href) reportMount(check, !!document.querySelector(selector));
  }, GRACE_MS);
};
