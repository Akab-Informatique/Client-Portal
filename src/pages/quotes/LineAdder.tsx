import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Package, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import type { QuoteProduct } from "./shared";

/**
 * The quick add of a quote: one field. Type a SKU or a name to pick from the
 * inventory (what is quoted most often comes first), or type anything and
 * press Enter for a free line, with no product to create beforehand.
 */
export function LineAdder({ onProduct, onFree }: { onProduct: (p: QuoteProduct) => void; onFree: (text: string) => void }) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState("");
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // wait a moment after the last key before asking the server
  useEffect(() => {
    const id = window.setTimeout(() => setTyped(text.trim()), 150);
    return () => window.clearTimeout(id);
  }, [text]);

  const { data: found = [] } = useQuery({
    queryKey: ["quotes", "products", typed],
    queryFn: () => api.get<QuoteProduct[]>(`/quotes/products?q=${encodeURIComponent(typed)}`),
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
  const free = text.trim();
  const showFree = free.length > 0;
  const count = found.length + (showFree ? 1 : 0);
  const active = Math.min(index, Math.max(count - 1, 0));

  const reset = () => {
    setText("");
    setIndex(0);
    input.current?.focus();
  };
  const choose = (i: number) => {
    if (i < found.length) onProduct(found[i]);
    else if (showFree) onFree(free);
    else return;
    reset();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setIndex((i) => (count ? (i + 1) % count : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (count ? (i - 1 + count) % count : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // an exact SKU wins over the first suggestion
      const exact = found.findIndex((p) => p.sku && p.sku.toLowerCase() === free.toLowerCase());
      choose(exact >= 0 ? exact : active);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKey}
          placeholder={t("quotes.editor.addPlaceholder")}
          aria-label={t("quotes.editor.addPlaceholder")}
          aria-expanded={open}
          aria-controls="quote-line-suggestions"
          role="combobox"
          autoComplete="off"
          className="h-11 bg-background/40 pl-9 text-base"
        />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{t("quotes.editor.addHint")}</p>

      {open && count > 0 && (
        <ul id="quote-line-suggestions" role="listbox" className="glass absolute inset-x-0 top-12 z-40 max-h-80 overflow-y-auto rounded-xl border p-1 shadow-lg">
          {!typed && found.length > 0 && <li className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">{found.some((p) => p.uses > 0) ? t("quotes.editor.suggestions") : t("quotes.editor.inventory")}</li>}
          {found.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={i === active}
              // mouse down, not click: the field must not lose focus first
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
              onMouseEnter={() => setIndex(i)}
              className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2", i === active && "bg-accent")}
            >
              <Package className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[p.sku, p.manufacturer, p.stock > 0 ? t("quotes.editor.inStock", { count: p.stock }) : t("quotes.editor.noStock")].filter(Boolean).join("  ·  ")}
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold tabular-nums">{money(p.priceCents, i18n.language)}</span>
            </li>
          ))}
          {showFree && (
            <li
              role="option"
              aria-selected={active === found.length}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(found.length);
              }}
              onMouseEnter={() => setIndex(found.length)}
              className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2", active === found.length && "bg-accent", found.length > 0 && "mt-1 border-t")}
            >
              <Plus className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 truncate text-sm">{t("quotes.editor.addFree", { text: free })}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
