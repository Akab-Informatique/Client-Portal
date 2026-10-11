import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { ArrowDownUp, CalendarRange, ChevronDown, Eye, FlaskConical, Inbox, Plus, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCan } from "@/lib/session";
import { cn, initials } from "@/lib/utils";
import { NewTicketDialog } from "./NewTicketDialog";
import { TicketPanel } from "./TicketPanel";
import { dueState, FILTER_KEYS, PRIORITY_STYLE, shortDate, STATUS_STYLE, useTickets, VIEWS, type TicketSummary, type View } from "./shared";

/**
 * Tickets: tabs for the technician's day (mine, unassigned, due, all), quick
 * filters kept in the address bar, and the ticket opened in a side panel
 * (?ticket=<id>) so the list stays in place.
 */
export function TicketsPage() {
  const { t } = useTranslation();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.includes(params.get("view") as View) ? params.get("view") : "mine") as View;
  const openId = Number(params.get("ticket")) || null;
  const { data, isLoading } = useTickets(view, params);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(patch)) {
          if (v) p.set(k, v);
          else p.delete(k);
        }
        return p;
      },
      { replace: true },
    );
  const activeFilters = FILTER_KEYS.filter((k) => k !== "sort" && k !== "q" && params.get(k));

  // Shortcuts: "/" search, "n" new ticket (not while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [contenteditable], [role=dialog]")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key.toLowerCase() === "n" && can("tickets.edit") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [can]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{t("tickets.title")}</h1>
          {data?.demo && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="gap-1 border-dashed text-muted-foreground">
                  <FlaskConical className="size-3" /> {t("tickets.demo")}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{t("tickets.demoHint")}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {can("tickets.edit") && (
          <Button onClick={() => setCreating(true)} className="bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105">
            <Plus className="size-4" /> {t("tickets.new")}
            <kbd className="ml-1 rounded border border-black/20 px-1 font-mono text-[10px] opacity-70">N</kbd>
          </Button>
        )}
      </div>

      {/* Views */}
      <div className="flex flex-wrap gap-1 rounded-xl border bg-card/60 p-1">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => set({ view: v === "mine" ? null : v })}
            className={cn(
              "relative flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors",
              view === v ? "text-[#1a1204]" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {view === v && <motion.span layoutId="ticket-view" className="absolute inset-0 rounded-lg bg-grad-gold" transition={{ type: "spring", bounce: 0.15, duration: 0.35 }} />}
            <span className="relative">{t(`tickets.views.${v}`)}</span>
            {data && (
              <span className={cn("relative rounded-full px-1.5 text-[11px] tabular-nums", view === v ? "bg-black/15" : "bg-muted")}>{data.counts[v]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={params.get("q") ?? ""}
            onChange={(e) => set({ q: e.target.value || null })}
            placeholder={t("tickets.search")}
            className="pl-9 pr-8"
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border px-1 font-mono text-[10px] text-muted-foreground">/</kbd>
        </div>
        {data && (
          <>
            <MultiFilter label={t("tickets.fields.status")} param="status" options={data.facets.statuses.map((s) => ({ value: s, label: t(`tickets.status.${s}`) }))} params={params} set={set} />
            <MultiFilter
              label={t("tickets.fields.priority")}
              param="priority"
              options={data.facets.priorities.map((p) => ({ value: p, label: t(`tickets.priority.${p}`), dot: PRIORITY_STYLE[p].dot }))}
              params={params}
              set={set}
            />
            <MultiFilter label={t("tickets.fields.company")} param="company" options={data.facets.companies.map((c) => ({ value: String(c.id), label: c.name }))} params={params} set={set} searchable />
            <MultiFilter label={t("tickets.fields.queue")} param="queue" options={data.facets.queues.map((q) => ({ value: q, label: q }))} params={params} set={set} />
            <DatesFilter params={params} set={set} />
          </>
        )}
        <div className="ml-auto">
          <SortMenu value={params.get("sort") ?? "due"} onChange={(v) => set({ sort: v === "due" ? null : v })} />
        </div>
      </div>
      {activeFilters.length > 0 && (
        <div className="-mt-2 flex flex-wrap items-center gap-1.5">
          {activeFilters.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => set({ [k]: null })}
              className="flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-xs hover:border-destructive/50"
            >
              {t(`tickets.filter.${k}`)}: <span className="font-medium">{filterLabel(k, params.get(k)!, data, t)}</span>
              <X className="size-3 text-muted-foreground" />
            </button>
          ))}
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => set(Object.fromEntries(activeFilters.map((k) => [k, null])))}>
            {t("tickets.clearFilters")}
          </Button>
        </div>
      )}

      {/* List */}
      <div className="overflow-hidden rounded-2xl border bg-card/80">
        <div className="hidden grid-cols-[minmax(0,1fr)_150px_120px_130px_96px_120px_28px] gap-4 border-b px-5 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground lg:grid">
          <span>{t("tickets.fields.ticket")}</span>
          <span>{t("tickets.fields.status")}</span>
          <span>{t("tickets.fields.priority")}</span>
          <span>{t("tickets.fields.assignee")}</span>
          <span className="flex items-center gap-1">
            {t("tickets.fields.start")} <PortalTag />
          </span>
          <span>{t("tickets.fields.due")}</span>
          <span />
        </div>
        {isLoading || !data ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : data.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
            <Inbox className="size-8 opacity-50" />
            {activeFilters.length || params.get("q") ? t("tickets.emptyFiltered") : t(`tickets.empty.${view}`)}
          </div>
        ) : (
          <ul className="divide-y">
            {data.items.map((tk) => (
              <TicketRow key={tk.id} tk={tk} active={tk.id === openId} onOpen={() => set({ ticket: String(tk.id) })} />
            ))}
          </ul>
        )}
      </div>

      <TicketPanel id={openId} onClose={() => set({ ticket: null })} />
      {data && <NewTicketDialog open={creating} onOpenChange={setCreating} facets={data.facets} onCreated={(id) => set({ ticket: String(id) })} />}
    </div>
  );
}

function PortalTag() {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="rounded border border-[color:var(--gold)]/40 px-1 text-[9px] font-semibold normal-case tracking-normal text-primary">{t("tickets.portalTag")}</span>
      </TooltipTrigger>
      <TooltipContent>{t("tickets.portalHint")}</TooltipContent>
    </Tooltip>
  );
}

function TicketRow({ tk, active, onOpen }: { tk: TicketSummary; active: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const due = dueState(tk.dueAt, tk.status);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "group relative grid w-full grid-cols-1 gap-x-4 gap-y-2 px-5 py-3 text-left transition-colors hover:bg-accent/50 lg:grid-cols-[minmax(0,1fr)_150px_120px_130px_96px_120px_28px] lg:items-center",
          active && "bg-[color:var(--gold)]/[0.07]",
        )}
      >
        <span className={cn("absolute inset-y-2 left-0 w-1 rounded-r-full", PRIORITY_STYLE[tk.priority].bar)} />
        <span className="min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{tk.number}</span>
            <span className="truncate font-medium group-hover:text-primary">{tk.title}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {tk.company.name}
            {tk.contact && ` · ${tk.contact}`}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2 lg:contents">
          <span>
            <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[tk.status])}>{t(`tickets.status.${tk.status}`)}</span>
          </span>
          <span className={cn("flex items-center gap-1.5 text-xs font-medium", PRIORITY_STYLE[tk.priority].text)}>
            <span className={cn("size-2 rounded-full", PRIORITY_STYLE[tk.priority].dot)} />
            {t(`tickets.priority.${tk.priority}`)}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs">
            {tk.assignee ? (
              <>
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{initials(tk.assignee.name)}</span>
                <span className="truncate">{tk.assignee.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground italic">{t("tickets.unassigned")}</span>
            )}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">{tk.startDate ? shortDate(tk.startDate) : "—"}</span>
          <span
            className={cn(
              "text-xs font-medium tabular-nums",
              due === "overdue" ? "text-destructive" : due === "today" ? "text-orange-400" : due === "soon" ? "text-primary" : "text-muted-foreground",
            )}
          >
            {due === "overdue" ? t("tickets.overdue") : due === "today" ? t("tickets.today") : shortDate(tk.dueAt)}
          </span>
          <span className="flex justify-end">
            {tk.viewers.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="relative flex size-6 items-center justify-center text-orange-400">
                    <span className="absolute inset-0 animate-ping rounded-full bg-orange-400/20" />
                    <Eye className="size-4" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t("tickets.openBy", { names: tk.viewers.map((v) => v.name).join(", ") })}</TooltipContent>
              </Tooltip>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

type SetFn = (patch: Record<string, string | null>) => void;

function FilterButton({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-9 gap-1.5", count > 0 && "border-[color:var(--gold)]/50 text-primary")}>
          {label}
          {count > 0 && <span className="rounded-full bg-grad-gold px-1.5 text-[10px] font-bold text-[#1a1204]">{count}</span>}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function MultiFilter({
  label,
  param,
  options,
  params,
  set,
  searchable,
}: {
  label: string;
  param: string;
  options: { value: string; label: string; dot?: string }[];
  params: URLSearchParams;
  set: SetFn;
  searchable?: boolean;
}) {
  const { t } = useTranslation();
  const selected = useMemo(() => (params.get(param) ?? "").split(",").filter(Boolean), [params, param]);
  const [q, setQ] = useState("");
  const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    set({ [param]: next.join(",") || null });
  };
  return (
    <FilterButton label={label} count={selected.length}>
      {searchable && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} className="mb-1 h-8" />}
      <div className="max-h-72 overflow-y-auto">
        {shown.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
            <Checkbox checked={selected.includes(o.value)} onCheckedChange={() => toggle(o.value)} />
            {o.dot && <span className={cn("size-2 rounded-full", o.dot)} />}
            <span className="truncate">{o.label}</span>
          </label>
        ))}
      </div>
      {selected.length > 0 && (
        <Button variant="ghost" size="sm" className="mt-1 h-7 w-full text-xs text-muted-foreground" onClick={() => set({ [param]: null })}>
          {t("tickets.clear")}
        </Button>
      )}
    </FilterButton>
  );
}

/** Due date (Autotask) and start date (portal only) ranges. */
function DatesFilter({ params, set }: { params: URLSearchParams; set: SetFn }) {
  const { t } = useTranslation();
  const keys = ["dueFrom", "dueTo", "startFrom", "startTo"] as const;
  const count = keys.filter((k) => params.get(k)).length;
  const today = new Date().toISOString().slice(0, 10);
  const Range = ({ from, to, title, tag }: { from: (typeof keys)[number]; to: (typeof keys)[number]; title: string; tag?: boolean }) => (
    <div className="space-y-1.5 p-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        {title} {tag && <PortalTag />}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" aria-label={`${title} — ${t("tickets.from")}`} value={params.get(from) ?? ""} onChange={(e) => set({ [from]: e.target.value || null })} className="h-8 text-xs" />
        <Input type="date" aria-label={`${title} — ${t("tickets.to")}`} value={params.get(to) ?? ""} onChange={(e) => set({ [to]: e.target.value || null })} className="h-8 text-xs" />
      </div>
      <div className="flex gap-1">
        <QuickRange label={t("tickets.quick.today")} onClick={() => set({ [from]: today, [to]: today })} />
        <QuickRange label={t("tickets.quick.week")} onClick={() => set({ [from]: today, [to]: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10) })} />
        <QuickRange label={t("tickets.quick.clear")} onClick={() => set({ [from]: null, [to]: null })} />
      </div>
    </div>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-9 gap-1.5", count > 0 && "border-[color:var(--gold)]/50 text-primary")}>
          <CalendarRange className="size-4" /> {t("tickets.dates")}
          {count > 0 && <span className="rounded-full bg-grad-gold px-1.5 text-[10px] font-bold text-[#1a1204]">{count}</span>}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 divide-y p-1.5">
        <Range from="startFrom" to="startTo" title={t("tickets.fields.start")} tag />
        <Range from="dueFrom" to="dueTo" title={t("tickets.fields.due")} />
      </PopoverContent>
    </Popover>
  );
}

function QuickRange({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground">
      {label}
    </button>
  );
}

function SortMenu({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-9 gap-1.5 text-muted-foreground">
          <ArrowDownUp className="size-4" /> {t(`tickets.sort.${value}`)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-1">
        {["due", "priority", "start", "updated"].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className={cn("block w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent", value === s && "font-semibold text-primary")}
          >
            {t(`tickets.sort.${s}`)}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function filterLabel(key: string, value: string, data: ReturnType<typeof useTickets>["data"], t: (k: string) => string) {
  const parts = value.split(",");
  switch (key) {
    case "status":
      return parts.map((p) => t(`tickets.status.${p}`)).join(", ");
    case "priority":
      return parts.map((p) => t(`tickets.priority.${p}`)).join(", ");
    case "company":
      return parts.map((p) => data?.facets.companies.find((c) => String(c.id) === p)?.name ?? p).join(", ");
    case "dueFrom":
    case "dueTo":
    case "startFrom":
    case "startTo":
      return shortDate(value);
    default:
      return parts.join(", ");
  }
}
