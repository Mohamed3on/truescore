// The shared LLM-markdown renderer. Not gmaps-specific, but it lives in the
// shared package because both the web app and the extension render the same
// model summaries and need identical, forgiving behaviour. Deliberately
// hand-rolled, NOT a library: models emit MALFORMED markdown (stray/odd `**`,
// unpaired emphasis, `__bold__`, `_italic_`), and a spec-compliant parser would
// render the orphan markers as literal asterisks (see markdown.test.ts) and add
// bundle weight for CommonMark features these summaries never use. Pure
// string→html; each package keeps its own DOM sink (renderMarkdown).

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const mdInline = (s: string): string => {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold: the **…** must hug its content (CommonMark-style flanking — opener
  // followed by non-space, closer preceded by non-space). Without this, a stray
  // or odd ** from the model (e.g. "…techniques.**** The") pairs with the wrong
  // neighbor and inverts emphasis across the rest of the line, bolding the
  // connectors instead of the specifics. Then drop any leftover unpaired **.
  s = s.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*\*/g, '');
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
  // Underscore emphasis (__bold__ / _italic_), which models emit too. Word-
  // boundary guards keep intra-word underscores (snake_case, URLs) from becoming
  // emphasis. Runs before the link rule so its injected target="_blank" is safe.
  s = s.replace(/(^|[^\w_])__(?=\S)([^_\n]+?)(?<=\S)__(?=[^\w_]|$)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?=[^\w_]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
};

export const mdToHtml = (src: string): string => {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const isList = (l: string) => /^\s*[-*]\s+/.test(l);
  const isOrdered = (l: string) => /^\s*\d+\.\s+/.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1]!.length}>${mdInline(h[2]!)}</h${h[1]!.length}>`); i++; continue; }
    if (isList(line)) {
      out.push('<ul>');
      while (i < lines.length && isList(lines[i]!)) {
        out.push(`<li>${mdInline(lines[i]!.replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push('</ul>');
      continue;
    }
    if (isOrdered(line)) {
      out.push('<ol>');
      while (i < lines.length && isOrdered(lines[i]!)) {
        out.push(`<li>${mdInline(lines[i]!.replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push('</ol>');
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^#{1,6}\s+/.test(lines[i]!) && !isList(lines[i]!) && !isOrdered(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    out.push(`<p>${mdInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
};
