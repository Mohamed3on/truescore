// Cmd/Ctrl+Shift+F focuses the BJJ Fanatics search input.

const SEARCH_INPUTS = [
  'input[name="q"]',
  'input[type="search"]',
  '[role="search"] input',
];

const SEARCH_TRIGGERS = [
  'button[aria-controls*="search" i]',
  'details-modal[aria-label*="search" i] summary',
  'summary[aria-label*="search" i]',
  'button[aria-label*="search" i]',
  'a[href*="/search" i][aria-label*="search" i]',
];

const isVisible = (el: HTMLElement) =>
  el.offsetParent !== null && el.getClientRects().length > 0;

const findVisibleInput = () => {
  for (const sel of SEARCH_INPUTS) {
    for (const input of document.querySelectorAll<HTMLInputElement>(sel)) {
      if (isVisible(input)) return input;
    }
  }
  return null;
};

const focusSearch = async () => {
  let input = findVisibleInput();
  if (!input) {
    for (const sel of SEARCH_TRIGGERS) {
      const trigger = document.querySelector<HTMLElement>(sel);
      if (trigger) { trigger.click(); break; }
    }
    // Wait for the drawer/modal to mount and become focusable
    for (let i = 0; i < 20 && !input; i++) {
      await new Promise((r) => setTimeout(r, 25));
      input = findVisibleInput();
    }
  }
  if (input) {
    input.focus();
    input.select();
  }
};

document.addEventListener(
  'keydown',
  (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      e.stopPropagation();
      focusSearch();
    }
  },
  true,
);
