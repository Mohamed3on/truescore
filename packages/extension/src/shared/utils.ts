export const addCommas = (x: number | string): string =>
  String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const npsColor = (nps: number): string => {
  const hue = Math.min(120, Math.max(0, (nps - 50) * 3));
  return `hsl(${hue}, 70%, 35%)`;
};

export const el = (tag: string, className?: string, text?: string | number) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = String(text);
  return e;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const mdInline = (s: string): string => {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
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
    const line = lines[i];
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (isList(line)) {
      out.push('<ul>');
      while (i < lines.length && isList(lines[i])) {
        out.push(`<li>${mdInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push('</ul>');
      continue;
    }
    if (isOrdered(line)) {
      out.push('<ol>');
      while (i < lines.length && isOrdered(lines[i])) {
        out.push(`<li>${mdInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push('</ol>');
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s+/.test(lines[i]) && !isList(lines[i]) && !isOrdered(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${mdInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
};

export const renderMarkdown = (container: HTMLElement, text: string) => {
  container.innerHTML = mdToHtml(text);
};

export const renderMarkdownInline = (container: HTMLElement, text: string) => {
  container.innerHTML = mdInline(text);
};
