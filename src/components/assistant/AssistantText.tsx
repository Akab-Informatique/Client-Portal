import { Fragment, type ReactNode } from "react";

/**
 * The answers of the assistant, with a small safe subset of markdown: paragraphs, "- " / "* " and "1. " lists,
 * **bold** and `code`. Built as React elements (never as HTML), so nothing in an answer can inject markup.
 */
export function AssistantText({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {parseBlocks(text).map((b, i) =>
        b.kind === "ul" ? (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ul>
        ) : b.kind === "ol" ? (
          <ol key={i} className="list-decimal space-y-1 pl-5">
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ol>
        ) : (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

export type Block = { kind: "p"; lines: string[] } | { kind: "ul"; items: string[] } | { kind: "ol"; items: string[] };

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/** Blocks are separated by blank lines; a block of bullets or of numbered lines is a list, anything else a paragraph. */
export function parseBlocks(src: string): Block[] {
  const out: Block[] = [];
  const chunks = src.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const bullets = lines.map((l) => BULLET.exec(l));
    if (bullets.every(Boolean)) {
      out.push({ kind: "ul", items: bullets.map((m) => (m as RegExpExecArray)[1]) });
      continue;
    }
    const numbered = lines.map((l) => NUMBERED.exec(l));
    if (numbered.every(Boolean)) {
      out.push({ kind: "ol", items: numbered.map((m) => (m as RegExpExecArray)[1]) });
      continue;
    }
    out.push({ kind: "p", lines });
  }
  return out;
}

/** **bold** and `code` inside one line. */
export function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
      return (
        <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    return <Fragment key={i}>{part}</Fragment>;
  });
}
