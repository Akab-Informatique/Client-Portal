import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { GroupToggle, KindSwitch, filterProjectRows, type ProjKind } from "@/pages/proj/ProjRows";
import { useProjectRows } from "@/pages/proj/shared";
import { Pager } from "@/components/Pager";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Columns3, Eye, Rows3, Search, Siren, Sparkles, Star, Ticket as TicketIcon, UserRound, UserX, X, type LucideIcon } from "lucide-react";
import { SmsInboxDialog, SmsTile } from "@/pages/sms/SmsPage";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CompactList, KanbanBoard } from "@/pages/tickets/Layouts";
import { useCan, useMe } from "@/lib/session";
import { type TicketList } from "@/pages/tickets/shared";
import { DAY_ROUTE, isWork, type DayItem } from "./shared";
import { DayEdge } from "./DayEdge";
import { usePeople } from "./TaskDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";


/**
 * A technician's tickets, as the compact view of the Tickets page with the "My tickets" filter (all of them, not only today's);
 * for someone else's day, their tickets (the Tickets page filtered on them).
 */
export function MyTickets({ userId, mine, onOpen }: { userId: string; mine: boolean; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const people = usePeople();
  // whose tickets: the person of the day by default; any technician, or everyone's, from the title (open tickets only, always)
  const [pick, setPick] = useState<string | null>(null);
  const who = pick ?? userId;
  const own = who === userId && mine;
  // the view (compact list or kanban boards) and a search of the tickets shown
  const can = useCan();
  const navigate = useNavigate();
  const [view, setView] = useState<"compact" | "kanban">(() => {
    try {
      return localStorage.getItem("akab.pipeline.ticketsView") === "kanban" ? "kanban" : "compact";
    } catch {
      return "compact";
    }
  });
  const pickView = (v: "compact" | "kanban") => {
    setView(v);
    try {
      localStorage.setItem("akab.pipeline.ticketsView", v);
    } catch {
      /* not kept */
    }
  };
  // what to show (all / tickets / projects) and whether projects are grouped apart; mixed by due date by default
  const [kind, setKind] = useState<ProjKind>(() => {
    try {
      const k = localStorage.getItem("akab.pipeline.kind");
      return k === "tickets" || k === "projects" ? k : "all";
    } catch {
      return "all";
    }
  });
  const [grouped, setGrouped] = useState(() => {
    try {
      return localStorage.getItem("akab.pipeline.grouped") === "1";
    } catch {
      return false;
    }
  });
  const pickKind = (k: ProjKind) => {
    setKind(k);
    setPage(1);
    try {
      localStorage.setItem("akab.pipeline.kind", k);
    } catch {
      /* not kept */
    }
  };
  const pickGrouped = (v: boolean) => {
    setGrouped(v);
    try {
      localStorage.setItem("akab.pipeline.grouped", v ? "1" : "0");
    } catch {
      /* not kept */
    }
  };
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setSearch(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  // the same buttons as the Tickets page, small: my tickets, texts, new, unassigned, needs attention, and my saved filters
  const [filter, setFilter] = useState("view=mine");
  const [sms, setSms] = useState(false);
  const base = own ? filter : who === "all" ? "view=all" : `view=all&assignee=${who}`;
  const query = search ? `${base}&q=${encodeURIComponent(search)}` : base;
  const { data, isLoading } = useQuery({
    queryKey: ["tickets", "pipeline", query],
    queryFn: () => api.get<TicketList>(`/tickets?${query}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const m = data?.metrics;
  const chips: { key: string; icon: LucideIcon; tone: string; label: string; count: number | undefined; query: string }[] = [
    { key: "mine", icon: UserRound, tone: "text-primary", label: t("tickets.metrics.mine"), count: m?.mine, query: "view=mine" },
    { key: "fresh", icon: Sparkles, tone: "text-emerald-400", label: t("tickets.metrics.fresh"), count: m?.fresh, query: "view=unassigned&statusKind=new" },
    { key: "unassigned", icon: UserX, tone: "text-sky-400", label: t("tickets.metrics.unassigned"), count: m?.unassigned, query: "view=unassigned" },
    { key: "statusAttention", icon: BellRing, tone: "text-amber-300", label: t("tickets.metrics.statusAttention"), count: m?.statusAttention, query: "view=all&statusKind=needsAttention" },
    { key: "attention", icon: Siren, tone: "text-red-400", label: t("tickets.metrics.attention"), count: m?.attention, query: "view=all&attention=1" },
    ...(data?.buttons ?? []).map((b) => ({ key: `b:${b.id}`, icon: Eye, tone: "text-muted-foreground", label: b.name, count: b.count as number | undefined, query: b.query })),
  ];
  const all = kind === "projects" ? [] : (data?.items ?? []).filter((x) => x.statusKind !== "complete");
  // projects of the new format, with the tickets (the person's own, or the one picked)
  const canProj = can("proj.view");
  const projRows = useProjectRows(canProj);
  const projects = canProj && kind !== "tickets"
    ? filterProjectRows(projRows.data ?? [], { q: search, view: who === "all" ? "all" : "mine", meId: who === "all" ? me.id : who, assignee: [], company: [], companyNames: new Map() })
    : [];
  // not stretched over the page: 10 at first, the others on the next pages
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const pages = Math.max(1, Math.ceil(all.length / size));
  const cur = Math.min(page, pages);
  const items = all.slice((cur - 1) * size, cur * size);
  // mixed with the tickets by due date: each page takes the projects due between its first ticket and the next page's first
  const dayOf = (i: number) => all[i]?.dueAt.slice(0, 10) ?? null;
  const range = { lo: cur === 1 ? null : dayOf((cur - 1) * size), hi: cur >= pages ? null : dayOf(cur * size) };
  const tools = (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input value={text} onChange={(e) => (setText(e.target.value), setPage(1))} placeholder={t("pipeline.day.searchTickets")} aria-label={t("pipeline.day.searchTickets")} className="h-7 w-36 rounded-lg border border-[color:var(--glass-border)] bg-background/40 pl-7 pr-2 text-xs outline-none focus:border-[color:var(--gold)]/50" />
      </div>
      {canProj && (
        <div className="flex items-center gap-1.5">
          <KindSwitch value={kind} onChange={pickKind} />
          {kind === "all" && <GroupToggle value={grouped} onChange={pickGrouped} />}
        </div>
      )}
      <div className="flex items-center rounded-lg border border-[color:var(--glass-border)] p-0.5" role="group" aria-label={t("tickets.layout.title")}>
        {([["compact", Rows3], ["kanban", Columns3]] as const).map(([v, Icon]) => (
          <button key={v} type="button" aria-pressed={view === v} title={t(`tickets.layout.${v}Hint`)} onClick={() => pickView(v)} className={cn("flex h-6 items-center gap-1 rounded-md px-1.5 text-xs", view === v ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
            <Icon className="size-3.5" />
            <span className="hidden xl:inline">{t(`tickets.layout.${v}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <section className="glass rounded-2xl border">
      {own && (
        <div className="flex items-center gap-1 overflow-x-auto px-3 pt-3 scrollbar-thin">
          {chips.map((c) => {
            const on = filter === c.query;
            return (
              <button key={c.key} type="button" onClick={() => (setFilter(c.query), setPage(1))} className={cn("flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs transition-colors hover:border-[color:var(--gold)]/40", on ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 text-foreground" : "border-[color:var(--glass-border)] text-muted-foreground")}>
                <c.icon className={cn("size-3.5", c.tone)} />
                <span className="font-medium">{c.label}</span>
                <span className="font-mono tabular-nums">{c.count ?? "…"}</span>
              </button>
            );
          })}
          <SmsTile onOpen={() => setSms(true)} compact />
          {tools}
        </div>
      )}
      {!own && <div className="flex items-center gap-2 px-3 pt-3">{tools}</div>}
      {sms && <SmsInboxDialog initialId={null} onClose={() => setSms(false)} />}
      <h3 className="flex items-center gap-1.5 px-4 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <TicketIcon className="size-3.5" />
        <Select value={who} onValueChange={(v) => (setPick(v === userId ? null : v), setPage(1))}>
          <SelectTrigger className="h-7 w-auto gap-1.5 border-transparent bg-transparent px-1.5 text-[11px] font-semibold uppercase tracking-wide shadow-none hover:border-[color:var(--glass-border)]" aria-label={t("pipeline.day.ticketsOf")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="all" className="text-xs">
              {t("pipeline.day.ticketsAll")}
            </SelectItem>
            {[...(people.data ?? [])]
              .sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name)))
              .map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  {p.id === me.id ? t("pipeline.day.ticketsMine") : p.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <span className="font-mono normal-case opacity-70">{all.length}</span>
      </h3>
      {isLoading ? <Skeleton className="m-4 h-20" /> : all.length === 0 && projects.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t("pipeline.day.noTickets")}</p> : view === "kanban" ? <KanbanBoard items={all} canEdit={can("tickets.edit")} onOpen={onOpen} facets={data?.facets} /> : <CompactList items={items} activeIds={new Set()} onOpen={onOpen} facets={data?.facets} projects={grouped ? (cur === 1 ? projects : []) : projects} grouped={grouped} range={range} onOpenProject={(id) => navigate(`/pipeline?section=tickets&pj=${id}`)} />}
      {view === "compact" && all.length > size && <Pager total={all.length} page={page} size={size} onPage={setPage} onSize={(n) => (setSize(n), setPage(1))} />}
    </section>
  );
}

/** The priorities pinned in Planning: of the day (beside the blocks) or of the week (beside the tickets). */
export function Priorities({ items, horizon, onOpen, canRemove, forUser }: { items: DayItem[]; horizon: "day" | "week"; onOpen: (i: DayItem) => void; canRemove?: boolean; forUser?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // a ticket put on the day by hand leaves it with one click (nothing on the ticket changes)
  const remove = useMutation({
    mutationFn: (i: DayItem) => api.del(`/pipeline/day/${DAY_ROUTE[i.kind]}/${i.refId}${forUser ? `?userId=${forUser}` : ""}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["pipeline"] }),
  });
  const list = items.filter((i) => i.pin === horizon);
  return (
    <section className="glass rounded-2xl border p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Star className={cn("size-3.5 fill-current", horizon === "day" ? "text-primary" : "")} /> {t(`pipeline.day.priorities.${horizon}`)} <span className="font-mono normal-case opacity-70">{list.length}</span>
      </h3>
      {list.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">{t(`pipeline.day.priorities.none${horizon === "day" ? "Day" : "Week"}`)}</p>
      ) : (
        <ul className="divide-y divide-[color:var(--glass-border)]">
          {list.map((i) => (
            <li key={i.key} className="flex items-center gap-1">
              {!i.masked && isWork(i.kind) && <DayEdge kind={i.kind} id={i.refId} number={i.ticketNumber} title={i.title} urgent={i.priority === "urgent"} onOpen={() => onOpen(i)} onDay={i.added ? { forUser } : undefined} />}
              <button type="button" onClick={() => onOpen(i)} className="flex min-w-0 flex-1 items-baseline gap-2 py-1.5 text-left">
                {i.ticketNumber && <span className="shrink-0 font-mono text-[11px] text-primary">{i.ticketNumber}</span>}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.title}</span>
                {i.client && <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block">{i.client}</span>}
                {i.pinNote && <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">· {i.pinNote}</span>}
                {i.added && i.dueTime && <span className="shrink-0 font-mono text-[10px] text-orange-300">{t("pipeline.before", { time: i.dueTime })}</span>}
              </button>
              {i.added && canRemove && (
                <button type="button" onClick={() => remove.mutate(i)} disabled={remove.isPending} title={t("tickets.addDay.remove")} aria-label={t("tickets.addDay.remove")} className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive">
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
