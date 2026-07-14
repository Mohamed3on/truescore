import { mdInline, mdToHtml } from '@truescore/gmaps-shared';

// The web DOM sink for the shared LLM-markdown renderer (gmaps-shared/markdown).
// createContextualFragment rather than innerHTML so the parsed nodes attach in
// one replace; the extension uses innerHTML in its own sink.
const renderHtml = (container: HTMLElement, html: string) => {
  container.replaceChildren(document.createRange().createContextualFragment(html));
};

export const renderMarkdown = (container: HTMLElement, text: string) => {
  renderHtml(container, mdToHtml(text));
};

export const renderMarkdownInline = (container: HTMLElement, text: string) => {
  renderHtml(container, mdInline(text));
};
