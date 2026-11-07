import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BookOpen, Building2, CalendarCheck, FileText, FolderKanban, HardDrive, Loader2, Receipt, Search, Ticket, UserRound, Workflow, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { TicketSummary } from "@/pages/tickets/shared";
import { useTicketWorkspace } from "@/pages/tickets/workspace";

type Hit = { kind: string; id: string; title: string; sub: string; path: string; ticketId?: number };

const GROUPS: { kind: string; icon: LucideIcon }[] = [
  { kind: "ticket", icon: Ticket },
  { kind: "client", icon: Building2 },
  { kind: "contact", icon: UserRound },
  { kind: "device", icon: HardDrive },
  { kind: "project", icon: FolderKanban },
  { kind: "invoice", icon: Receipt },
  { kind: "quote", icon: FileText },
  { kind: "task", icon: Workflow },
  { kind: "kb", icon: BookOpen },
  { kind: "sop", icon: CalendarCheck },
];

/**
 * The search of the top bar, for everything at once: tickets, clients, contacts, RMM devices, projects, invoices,
 * quotes, tasks, the knowledge base and procedures — each only for what the person may see. Arrows and Enter move
 * through the results; a ticket opens in the ticket window, anything else on its own page.
 */
export function TopSearch() {
  const { t } = useTranslation();
  const can = useCan();
  const navigate = useNavigate();
  const ws = useTicketWorkspace();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, []);
  // "/" jumps to the search (unless one is typing somewhere)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? "") && !el?.isContentEditable) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const on = q.length >= 2;
  const others = useQuery({ queryKey: ["search", "all", q], queryFn: () => api.get<Hit[]>(`/search?q=${encodeURIComponent(q)}`), enabled: on, placeholderData: keepPreviousData, staleTime: 15_000 });
  const tickets = useQuery({
    queryKey: ["search", "tickets", q],
    queryFn: () => api.get<{ items: TicketSummary[] }>(`/tickets/search?q=${encodeURIComponent(q)}`),
    enabled: on && can("tickets.view"),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const hits = useMemo<Hit[]>(() => {
    if (!on) return [];
    const tk: Hit[] = (tickets.data?.items ?? []).slice(0, 6).map((x) => ({ kind: "ticket", id: String(x.id), title: `${x.number} ${x.title}`, sub: x.company.name, path: "", ticketId: x.id }));
    const rest = others.data ?? [];
    return GROUPS.flatMap((g) => (g.kind === "ticket" ? tk : rest.filter((h) => h.kind === g.kind)));
  }, [on, tickets.data, others.data]);
  const go = (h: Hit) => {
    setOpen(false);
    input.current?.blur();
    if (h.ticketId) ws.open(h.ticketId);
    else navigate(h.path);
  };
  const busy = on && (others.isFetching || tickets.isFetching);
  return (
    <div ref={box} className="relative hidden w-56 sm:block lg:w-72">
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
            setActive((i) => Math.min(i + 1, Math.max(0, hits.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && hits[active]) {
            e.preventDefault();
            go(hits[active]);
          }
        }}
        placeholder={t("topSearch.placeholder")}
        aria-label={t("topSearch.placeholder")}
        className="h-9 w-full rounded-full border bg-background/60 pl-9 pr-8 text-sm outline-none transition focus:border-[color:var(--gold)]/60 focus:ring-2 focus:ring-[color:var(--gold)]/20"
      />
      {busy && <Loader2 className="absolute right-3 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />}
      {open && on && (
        <div className="fixed inset-x-2 top-[4.25rem] z-50 max-h-[70vh] overflow-y-auto rounded-xl border bg-popover p-1.5 shadow-2xl lg:absolute lg:inset-x-auto lg:right-0 lg:top-11 lg:w-[34rem]">
          {hits.length === 0 && !busy && <p className="px-3 py-4 text-center text-sm text-muted-foreground">{t("topSearch.none", { q })}</p>}
          {GROUPS.map((g) => {
            const list = hits.filter((h) => h.kind === g.kind);
            if (!list.length) return null;
            return (
              <div key={g.kind} className="pb-1">
                <p className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <g.icon className="size-3" /> {t(`topSearch.groups.${g.kind}`)}
                </p>
                {list.map((h) => {
                  const i = hits.indexOf(h);
                  return (
                    <button key={`${h.kind}${h.id}`} type="button" onMouseEnter={() => setActive(i)} onClick={() => go(h)} className={cn("flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-sm", i === active ? "bg-[color:var(--gold)]/12" : "hover:bg-accent/40")}>
                      <span className="min-w-0 flex-1 truncate font-medium">{h.title}</span>
                      {h.sub && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{h.sub}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
