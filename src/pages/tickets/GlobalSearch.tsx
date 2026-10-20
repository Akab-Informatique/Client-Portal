import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Archive, Loader2, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dueGlow, STATUS_STYLE, useChoiceText, type TicketSummary } from "./shared";
import { useTicketWorkspace } from "./workspace";

type Result = { items: TicketSummary[]; total: number; archive: TicketSummary[] };

/**
 * Search every ticket, whatever the view and filters below: all technicians,
 * recently completed ones too (local copy, instant). "Older tickets" also asks
 * the older tickets, on demand. Opening a result shows it in the ticket window.
 */
export function GlobalSearch({ demo }: { demo: boolean }) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const ws = useTicketWorkspace();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [deep, setDeep] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // a short pause after typing before searching
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 180);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => {
    setDeep(false);
    setActive(0);
  }, [q]);
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, []);

  const { data, isFetching } = useQuery({
    queryKey: ["tickets", "search", q, deep],
    queryFn: () => api.get<Result>(`/tickets/search?q=${encodeURIComponent(q)}${deep ? "&deep=1" : ""}`),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const results = q.length >= 2 && data ? [...data.items, ...data.archive] : [];

  const go = (tk: TicketSummary) => {
    setOpen(false);
    input.current?.blur();
    ws.open(tk.id);
  };

  return (
    <div ref={box} className="relative w-full sm:w-80">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={input}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && results[active]) {
            e.preventDefault();
            go(results[active]);
          }
        }}
        placeholder={t("tickets.global.placeholder")}
        aria-label={t("tickets.global.label")}
        className="glass hex h-9 w-full border pl-9 pr-8 text-sm outline-none ring-[color:var(--gold)]/40 placeholder:text-muted-foreground focus:ring-2"
      />
      {text && (
        <button
          type="button"
          onClick={() => {
            setText("");
            input.current?.focus();
          }}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          aria-label={t("tickets.clear")}
        >
          <X className="size-3.5" />
        </button>
      )}

      {open && q.length >= 2 && (
        <div className="glass-strong absolute right-0 top-11 z-40 w-[min(34rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border shadow-2xl">
          <div className="flex items-center justify-between border-b px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>{data ? t("tickets.global.count", { count: data.total }) : t("tickets.global.searching")}</span>
            {isFetching && <Loader2 className="size-3.5 animate-spin" />}
          </div>
          <ul className="max-h-[60vh] overflow-y-auto py-1" role="listbox">
            {data?.items.map((tk, i) => (
              <Row key={tk.id} tk={tk} active={i === active} onHover={() => setActive(i)} onPick={() => go(tk)} statusText={txt.status({ label: tk.statusLabel, kind: tk.statusKind })} />
            ))}
            {data && data.archive.length > 0 && (
              <li className="px-4 pb-1 pt-3 text-[11px] uppercase tracking-wide text-muted-foreground">{t("tickets.global.older")}</li>
            )}
            {data?.archive.map((tk, i) => (
              <Row
                key={tk.id}
                tk={tk}
                active={data.items.length + i === active}
                onHover={() => setActive(data.items.length + i)}
                onPick={() => go(tk)}
                statusText={txt.status({ label: tk.statusLabel, kind: tk.statusKind })}
              />
            ))}
            {data && results.length === 0 && !isFetching && <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t("tickets.global.none")}</li>}
          </ul>
          {!demo && !deep && (
            <button
              type="button"
              onClick={() => setDeep(true)}
              className="flex w-full items-center gap-2 border-t px-4 py-2.5 text-left text-xs font-medium text-primary hover:bg-accent/50"
            >
              <Archive className="size-3.5" /> {t("tickets.global.deep")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ tk, active, onHover, onPick, statusText }: { tk: TicketSummary; active: boolean; onHover: () => void; onPick: () => void; statusText: string }) {
  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        onMouseEnter={onHover}
        onClick={onPick}
        className={cn("relative isolate flex w-full items-start gap-3 px-4 py-2 text-left", active && "bg-[linear-gradient(90deg,rgba(255,206,26,0.1),transparent_70%)]")}
      >
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-56" style={dueGlow(tk.dueAt, tk.statusKind, 0.85)} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{tk.number}</span>
            <span className="truncate text-sm font-medium">{tk.title}</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {tk.company.name}
            {tk.contact && ` · ${tk.contact}`}
            {tk.assignee && ` · ${tk.assignee.name}`}
          </span>
        </span>
        <span className={cn("mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium", STATUS_STYLE[tk.statusKind])}>{statusText}</span>
      </button>
    </li>
  );
}
