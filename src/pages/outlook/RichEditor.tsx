import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Bold, Eraser, ImagePlus, Italic, Link2, List, ListOrdered, Palette, Strikethrough, Underline } from "lucide-react";
import { cn } from "@/lib/utils";

export type RichEditorHandle = { html: () => string; focus: () => void; element: () => HTMLDivElement | null };

const COLORS = ["#111111", "#c00000", "#e36c09", "#1f6f3f", "#1f4e9c", "#7030a0", "#808080"];
const MAX_IMAGE = 200 * 1024;

/**
 * A small rich text editor (bold, italic, lists, links, colors, images for a
 * signature). The HTML it makes is sanitized by the server before use.
 */
export const RichEditor = forwardRef<
  RichEditorHandle,
  {
    initialHtml: string;
    onChange?: (html: string) => void;
    allowImages?: boolean;
    className?: string;
    minHeight?: string;
    label: string;
    autoFocus?: boolean;
    onKeyDown?: (e: React.KeyboardEvent) => void;
  }
>(function RichEditor({ initialHtml, onChange, allowImages, className, minHeight = "12rem", label, autoFocus, onKeyDown }, ref) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ html: () => box.current?.innerHTML ?? "", focus: () => box.current?.focus(), element: () => box.current }));
  // the content is set once; the editor owns it afterwards
  useEffect(() => {
    if (box.current) box.current.innerHTML = initialHtml;
    if (autoFocus) box.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changed = () => onChange?.(box.current?.innerHTML ?? "");
  const run = (command: string, value?: string) => {
    box.current?.focus();
    document.execCommand(command, false, value);
    changed();
  };
  const link = () => {
    const url = window.prompt(t("outlook.editor.linkPrompt"), "https://");
    if (!url) return;
    if (!/^(https?:\/\/|mailto:|tel:)/i.test(url.trim())) {
      toast.error(t("outlook.editor.badLink"));
      return;
    }
    run("createLink", url.trim());
  };
  const insertImage = (file: File) => {
    if (file.size > MAX_IMAGE) {
      toast.error(t("outlook.editor.imageTooBig"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => run("insertImage", String(reader.result));
    reader.readAsDataURL(file);
  };

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border bg-background/60 focus-within:border-[color:var(--gold)]/60", className)}>
      <div className="flex flex-wrap items-center gap-0.5 border-b px-1.5 py-1" role="toolbar" aria-label={t("outlook.editor.toolbar")}>
        <Tool label={t("outlook.editor.bold")} onClick={() => run("bold")}>
          <Bold className="size-4" />
        </Tool>
        <Tool label={t("outlook.editor.italic")} onClick={() => run("italic")}>
          <Italic className="size-4" />
        </Tool>
        <Tool label={t("outlook.editor.underline")} onClick={() => run("underline")}>
          <Underline className="size-4" />
        </Tool>
        <Tool label={t("outlook.editor.strike")} onClick={() => run("strikeThrough")}>
          <Strikethrough className="size-4" />
        </Tool>
        <Sep />
        <Tool label={t("outlook.editor.bullets")} onClick={() => run("insertUnorderedList")}>
          <List className="size-4" />
        </Tool>
        <Tool label={t("outlook.editor.numbers")} onClick={() => run("insertOrderedList")}>
          <ListOrdered className="size-4" />
        </Tool>
        <Sep />
        <span className="flex items-center gap-0.5 px-1" title={t("outlook.editor.color")}>
          <Palette className="size-4 text-muted-foreground" />
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`${t("outlook.editor.color")} ${c}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run("foreColor", c)}
              className="size-3.5 rounded-full border border-white/20"
              style={{ background: c }}
            />
          ))}
        </span>
        <Sep />
        <Tool label={t("outlook.editor.link")} onClick={link}>
          <Link2 className="size-4" />
        </Tool>
        {allowImages && (
          <>
            <Tool label={t("outlook.editor.image")} onClick={() => picture.current?.click()}>
              <ImagePlus className="size-4" />
            </Tool>
            <input
              ref={picture}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) insertImage(f);
                e.target.value = "";
              }}
            />
          </>
        )}
        <Tool label={t("outlook.editor.clear")} onClick={() => run("removeFormat")}>
          <Eraser className="size-4" />
        </Tool>
      </div>
      <div
        ref={box}
        contentEditable
        role="textbox"
        aria-multiline
        aria-label={label}
        suppressContentEditableWarning
        onInput={changed}
        onKeyDown={onKeyDown}
        className="prose-mail min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm outline-none [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_img]:inline-block [&_img]:max-h-40 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
        style={{ minHeight }}
      />
    </div>
  );
});

function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // keep the selection in the editor
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-0.5 h-4 w-px bg-border" />;
