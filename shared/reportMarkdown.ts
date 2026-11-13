/**
 * A small markdown renderer for the reports (headings, paragraphs, bullets, tables, bold). It is used by the
 * email copy of a run and by the reports screen. Every piece of text is escaped first, so a name or a figure
 * coming from the data can never inject markup.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Escaped text with **bold** turned into <strong>. */
export function inlineHtml(text: string): string {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** Markdown to HTML (escaped). Blocks are separated by blank lines. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineHtml(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inlineHtml(li)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      flushList();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      i--;
      const th = head.map((h) => `<th>${inlineHtml(h)}</th>`).join("");
      const tb = rows.map((r) => `<tr>${head.map((_, ci) => `<td>${inlineHtml(r[ci] ?? "")}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="overflow-x-auto"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const level = h[1].length === 1 ? 2 : h[1].length === 2 ? 3 : 4;
      out.push(`<h${level}>${inlineHtml(h[2])}</h${level}>`);
      continue;
    }
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b) {
      flushPara();
      list.push(b[1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join("\n");
}
