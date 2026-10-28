import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Layers, Package, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import type { QuoteProduct, QuoteService } from "./shared";

type Choice = { kind: "service"; s: QuoteService } | { kind: "product"; p: QuoteProduct };

/**
 * The quick add of a quote: one field. Type a SKU or a name to pick from the
 * services (Inventory › Services) or the inventory (what is quoted most often
 * comes first), or type anything and press Enter for a free line, with nothing
 * to create beforehand.
 */
export function LineAdder({ onProduct, onService, onFree }: { onProduct: (p: QuoteProduct) => void; onService: (s: QuoteService) => void; onFree: (text: string) => void }) {
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

  const products = useQuery({
    queryKey: ["quotes", "products", typed],
    queryFn: () => api.get<QuoteProduct[]>(`/quotes/products?q=${encodeURIComponent(typed)}`),
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
  const services = useQuery({
    queryKey: ["quotes", "services", typed],
    queryFn: () => api.get<QuoteService[]>(`/quotes/services?q=${encodeURIComponent(typed)}`),
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
  // services first, then the inventory; with nothing typed, a few of each
  const svc = (services.data ?? []).slice(0, typed ? 15 : 6);
  const prod = (products.data ?? []).slice(0, typed ? 25 : 8);
  const found: Choice[] = [...svc.map((s) => ({ kind: "service" as const, s })), ...prod.map((p) => ({ kind: "product" as const, p }))];
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
    const c = found[i];
    if (c) c.kind === "service" ? onService(c.s) : onProduct(c.p);
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
      const sku = (c: Choice) => (c.kind === "service" ? c.s.sku : c.p.sku);
      const exact = found.findIndex((c) => sku(c)?.toLowerCase() === free.toLowerCase());
      choose(exact >= 0 ? exact : active);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const heading = (label: string) => <li className="sticky top-0 z-10 bg-popover px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</li>;
  const row = (i: number, icon: React.ReactNode, title: string, sub: string, price: string) => (
    <li
      key={i}
      role="option"
      aria-selected={i === active}
      // mouse down, not click: the field must not lose focus first
      onMouseDown={(e) => {
        e.preventDefault();
        choose(i);
      }}
      onMouseEnter={() => setIndex(i)}
      className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2", i === active && "bg-accent text-accent-foreground")}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
      </div>
      <span className="shrink-0 text-sm font-semibold tabular-nums">{price}</span>
    </li>
  );

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

      {/* solid background (not glass): the lines under the list must not show through */}
      {open && count > 0 && (
        <ul id="quote-line-suggestions" role="listbox" className="absolute inset-x-0 top-12 z-40 max-h-96 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-2xl ring-1 ring-black/40">
          {svc.length > 0 && heading(t("quotes.editor.services"))}
          {svc.map((s, i) =>
            row(
              i,
              <Layers className="size-4 shrink-0 text-sky-400" />,
              s.name,
              [s.sku, t(`quotes.recurrence.${s.recurrence}`)].filter(Boolean).join("  ·  "),
              `${money(s.priceCents, i18n.language)}${s.recurrence !== "once" ? ` ${t(`quotes.recurrence.per.${s.recurrence}`)}` : ""}`,
            ),
          )}
          {prod.length > 0 && heading(!typed && prod.some((p) => p.uses > 0) ? t("quotes.editor.suggestions") : t("quotes.editor.inventory"))}
          {prod.map((p, j) =>
            row(
              svc.length + j,
              <Package className="size-4 shrink-0 text-muted-foreground" />,
              p.name,
              [p.sku, p.manufacturer, p.stock > 0 ? t("quotes.editor.inStock", { count: p.stock }) : t("quotes.editor.noStock")].filter(Boolean).join("  ·  "),
              money(p.priceCents, i18n.language),
            ),
          )}
          {showFree && (
            <li
              role="option"
              aria-selected={active === found.length}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(found.length);
              }}
              onMouseEnter={() => setIndex(found.length)}
              className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2", active === found.length && "bg-accent text-accent-foreground", found.length > 0 && "mt-1 border-t")}
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
