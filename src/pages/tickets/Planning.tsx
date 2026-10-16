import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  BellRing,
  CalendarClock,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Pin,
  Plus,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { STATUS_STYLE, ticketErrorText, useChoiceText, type StatusKind, type TicketSummary } from "./shared";
import { useTicketWorkspace } from "./workspace";

/**
 * Planning beside the ticket list: the technician's priorities (of the day,
 * of the week, carried over) given by an admin with a direction, and the
 * weekly calendar of time reserved for them. Admins (tickets.plan) choose the
 * technician, give priorities and reserve time; technicians see their own.
 */
type Horizon = "day" | "week";
export type Priority = {
  id: string;
  ticketId: number;
  ticketNumber: string;
  ticketTitle: string;
  technicianId: string;
  note: string;
  horizon: Horizon;
  forDate: string;
  doneAt: string | null;
  rank: number;
  bucket: "day" | "week" | "carried";
  pinnedByName: string | null;
  company: string | null;
  dueAt: string | null;
  status: { label: string | null; kind: StatusKind } | null;
};
type BlockKind = "work" | "onsite" | "slot";
type Block = {
  id: string;
  technicianId: string;
  kind: BlockKind;
  ticketId: number | null;
  ticketNumber: string | null;
  title: string;
  note: string;
  companyName: string | null;
  reminderMinutes: number;
  autotaskServiceCallId: number | null;
  startsAt: string;
  endsAt: string;
};
type OutlookEvent = { id: string; title: string; startsAt: string; endsAt: string; allDay: boolean; location: string | null };
/** How each kind of block looks: work on a ticket, on-site service call, reserved time. */
type PlanAbsence = { id: string; startDate: string; endDate: string; kind: "vacation" | "sick" | "training" | "personal" | "other"; note: string | null };
const ABSENCE_STYLE: Record<PlanAbsence["kind"], string> = {
  vacation: "border-sky-500/40 bg-sky-500/15 text-sky-200",
  sick: "border-red-500/40 bg-red-500/15 text-red-200",
  training: "border-violet-500/40 bg-violet-500/15 text-violet-200",
  personal: "border-amber-500/40 bg-amber-500/15 text-amber-200",
  other: "border-slate-500/40 bg-slate-500/15 text-slate-200",
};

const KIND_STYLE: Record<BlockKind, string> = {
  work: "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/20 text-foreground",
  onsite: "border-orange-400/70 bg-orange-500/25 text-orange-50 shadow-[0_0_12px_-4px_rgba(249,115,22,0.7)]",
  slot: "border-sky-500/40 bg-sky-500/15 text-sky-100",
};
const REMINDERS = [0, 5, 10, 15, 30, 60];
type Person = { id: string; name: string };

const OPEN_KEY = "akab.planning.open";
const WEEKEND_KEY = "akab.planning.weekend";
const DAY_START = 7;
const DAY_END = 18;
const HOUR_PX = 30;
const loc = () => (currentLocale() === "en" ? "en-CA" : "fr-CA");
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
function mondayOf(d: Date) {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const readBool = (k: string, dflt: boolean) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? dflt : v === "1";
  } catch {
    return dflt;
  }
};
const saveBool = (k: string, v: boolean) => {
  try {
    localStorage.setItem(k, v ? "1" : "0");
  } catch {
    /* ignore */
  }
};

function useWide() {
  const q = "(min-width: 1536px)";
  const [wide, setWide] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

export function usePriorities(technicianId: string, date = ymd(new Date())) {
  return useQuery({
    queryKey: ["planning", "pins", technicianId, date],
    queryFn: () => api.get<Priority[]>(`/planning/pins?technicianId=${technicianId}&date=${date}`),
    staleTime: 30_000,
  });
}

/** The panel at the right of the ticket list: open inline on wide screens, as a drawer otherwise. */
export function PlanningPanel() {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const wide = useWide();
  // open by default only where it fits beside the list
  const [open, setOpen] = useState(() => readBool(OPEN_KEY, window.matchMedia("(min-width: 1536px)").matches));
  const [techId, setTechId] = useState(me.id);
  const { data: techs = [{ id: me.id, name: me.name }] } = useQuery({
    queryKey: ["planning", "technicians"],
    queryFn: () => api.get<Person[]>("/planning/technicians"),
    staleTime: 5 * 60_000,
  });
  // May plan for this technician: planners, or oneself with tickets.planSelf
  const planner = can("tickets.plan") || (techId === me.id && can("tickets.planSelf"));
  const { data: pins } = usePriorities(techId);
  const toDo = (pins ?? []).filter((p) => !p.doneAt).length;
  const toggle = (v: boolean) => {
    setOpen(v);
    saveBool(OPEN_KEY, v);
  };

  if (!open) {
    return (
      <div className={cn("shrink-0", wide ? "sticky top-4 self-start" : "fixed right-3 top-1/2 z-30 -translate-y-1/2")}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => toggle(true)}
              className="glass relative flex flex-col items-center gap-2 rounded-2xl border px-2 py-3 text-muted-foreground transition hover:text-foreground"
              aria-label={t("planning.open")}
            >
              <PanelRightOpen className="size-4" />
              <CalendarRange className="size-4 text-primary" />
              {toDo > 0 && <span className="hex flex size-5 items-center justify-center bg-grad-gold text-[10px] font-bold text-[#1a1204]">{toDo}</span>}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">{t("planning.open")}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  const body = (
    <aside className={cn("glass flex flex-col overflow-hidden rounded-2xl border", wide ? "sticky top-4 max-h-[calc(100dvh-6rem)] w-[400px] shrink-0 self-start" : "fixed bottom-3 right-3 top-20 z-40 w-[min(400px,calc(100vw-1.5rem))] shadow-2xl")}>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <CalendarRange className="size-4 text-primary" />
        <p className="flex-1 text-sm font-semibold">{t("planning.title")}</p>
        <BrowserAlerts />
        {techs.length > 1 && (
          <Select value={techId} onValueChange={setTechId}>
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {techs.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button variant="ghost" size="icon" className="size-8" onClick={() => toggle(false)} aria-label={t("planning.close")}>
          <PanelRightClose className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <PrioritiesList technicianId={techId} technicianName={techs.find((x) => x.id === techId)?.name ?? me.name} planner={planner} />
        <WeekCalendar technicianId={techId} technicianName={techs.find((x) => x.id === techId)?.name ?? me.name} planner={planner} />
      </div>
    </aside>
  );
  return body;
}

// ── Priorities ────────────────────────────────────────────────────────────────
function PrioritiesList({ technicianId, technicianName, planner }: { technicianId: string; technicianName: string; planner: boolean }) {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const ws = useTicketWorkspace();
  const txt = useChoiceText();
  const { data: pins, isLoading } = usePriorities(technicianId);
  const [editing, setEditing] = useState<Priority | "new" | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["planning"] });
  const done = useMutation({
    mutationFn: (p: Priority) => api.post(`/planning/pins/${p.id}/done`, { done: !p.doneAt }),
    onSuccess: refresh,
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const move = useMutation({ mutationFn: (v: { id: string; dir: "up" | "down" }) => api.post(`/planning/pins/${v.id}/move`, { dir: v.dir }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/planning/pins/${id}`), onSuccess: refresh });
  const mine = technicianId === me.id;

  const groups: { key: Priority["bucket"]; label: string }[] = [
    { key: "day", label: t("planning.groups.day") },
    { key: "week", label: t("planning.groups.week") },
    { key: "carried", label: t("planning.groups.carried") },
  ];
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <Star className="size-3.5 text-primary" />
        <p className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{mine ? t("planning.myPriorities") : t("planning.prioritiesOf", { name: technicianName })}</p>
        {planner && (
          <button type="button" onClick={() => setEditing("new")} className="flex items-center gap-1 text-xs text-primary hover:underline">
            <Plus className="size-3.5" /> {t("planning.add")}
          </button>
        )}
      </div>
      {isLoading ? (
        <Skeleton className="h-20" />
      ) : !pins?.length ? (
        <p className="rounded-xl border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{mine ? t("planning.noneMine") : t("planning.none")}</p>
      ) : (
        groups.map((g) => {
          const list = pins.filter((p) => p.bucket === g.key);
          if (!list.length) return null;
          return (
            <div key={g.key} className="space-y-1.5">
              <p className={cn("text-[10px] font-semibold uppercase tracking-wide", g.key === "carried" ? "text-orange-300" : "text-primary/80")}>{g.label}</p>
              <ul className="space-y-1.5">
                {list.map((p, i) => (
                  <li key={p.id} className={cn("group rounded-xl border bg-background/40 px-3 py-2 text-sm transition", p.doneAt && "opacity-55")}>
                    <div className="flex items-start gap-2">
                      {(mine || planner) && (
                        <button
                          type="button"
                          onClick={() => done.mutate(p)}
                          className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border", p.doneAt ? "border-emerald-500 bg-emerald-500 text-white" : "border-muted-foreground/50 hover:border-primary")}
                          aria-label={p.doneAt ? t("planning.reopen") : t("planning.markDone")}
                        >
                          {p.doneAt && <Check className="size-3" />}
                        </button>
                      )}
                      <button type="button" onClick={() => ws.open(p.ticketId)} className="min-w-0 flex-1 text-left">
                        <span className="flex items-baseline gap-2">
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{p.ticketNumber}</span>
                          <span className={cn("truncate font-medium", p.doneAt && "line-through")}>{p.ticketTitle}</span>
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                          {p.status && <span className={cn("rounded-full border px-1.5 text-[10px]", STATUS_STYLE[p.status.kind])}>{txt.status({ label: p.status.label, kind: p.status.kind })}</span>}
                          {p.company && <span className="truncate">{p.company}</span>}
                        </span>
                      </button>
                      {planner && (
                        <span className="flex shrink-0 opacity-0 transition group-hover:opacity-100">
                          {i > 0 && (
                            <IconBtn label={t("planning.up")} onClick={() => move.mutate({ id: p.id, dir: "up" })}>
                              <ArrowUp className="size-3" />
                            </IconBtn>
                          )}
                          {i < list.length - 1 && (
                            <IconBtn label={t("planning.down")} onClick={() => move.mutate({ id: p.id, dir: "down" })}>
                              <ArrowDown className="size-3" />
                            </IconBtn>
                          )}
                          <IconBtn label={t("common.edit")} onClick={() => setEditing(p)}>
                            <Pencil className="size-3" />
                          </IconBtn>
                          <IconBtn label={t("planning.remove")} onClick={() => void confirm({ title: t("planning.removeConfirm"), destructive: true }).then((ok) => ok && remove.mutate(p.id))}>
                            <Trash2 className="size-3" />
                          </IconBtn>
                        </span>
                      )}
                    </div>
                    {p.note && <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-[color:var(--gold)]/60 pl-2 text-xs text-foreground/85">{p.note}</p>}
                    {p.pinnedByName && <p className="mt-1 text-[10px] text-muted-foreground">{t("planning.by", { name: p.pinnedByName })}</p>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
      {editing && <PriorityDialog technicianId={technicianId} technicianName={technicianName} priority={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
      {children}
    </button>
  );
}

/** Give (or change) a priority: ticket, day or week, the direction. */
export function PriorityDialog({
  technicianId,
  technicianName,
  priority,
  ticket,
  onClose,
}: {
  technicianId?: string;
  technicianName?: string;
  priority: Priority | null;
  /** From a ticket window: the ticket is known, the technician is chosen */
  ticket?: { id: number; number: string; title: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: techs = [] } = useQuery({ queryKey: ["planning", "technicians"], queryFn: () => api.get<Person[]>("/planning/technicians"), staleTime: 5 * 60_000 });
  const [tech, setTech] = useState(technicianId ?? "");
  const [picked, setPicked] = useState<{ id: number; number: string; title: string } | null>(ticket ?? (priority ? { id: priority.ticketId, number: priority.ticketNumber, title: priority.ticketTitle } : null));
  const [horizon, setHorizon] = useState<Horizon>(priority?.horizon ?? "day");
  const [date, setDate] = useState(priority?.forDate ?? ymd(new Date()));
  const [note, setNote] = useState(priority?.note ?? "");
  const save = useMutation({
    mutationFn: () =>
      priority
        ? api.patch(`/planning/pins/${priority.id}`, { note: note.trim(), horizon, forDate: date })
        : api.post("/planning/pins", { ticketId: picked!.id, technicianId: tech, note: note.trim(), horizon, forDate: date }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["planning"] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("planning.saved"));
      onClose();
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const valid = picked && tech && date;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pin className="size-5 text-primary" /> {priority ? t("planning.editPriority") : t("planning.newPriority")}
          </DialogTitle>
          <DialogDescription>{technicianName && !ticket ? t("planning.for", { name: technicianName }) : t("planning.newHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          {!technicianId && (
            <div className="space-y-1.5">
              <Label>{t("planning.technician")}</Label>
              <Select value={tech} onValueChange={setTech}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("planning.pickTechnician")} />
                </SelectTrigger>
                <SelectContent position="popper">
                  {techs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t("planning.ticket")}</Label>
            {picked ? (
              <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                <span className="font-mono text-xs text-primary">{picked.number}</span>
                <span className="min-w-0 flex-1 truncate">{picked.title}</span>
                {!priority && !ticket && (
                  <button type="button" onClick={() => setPicked(null)} className="text-xs text-muted-foreground hover:text-foreground">
                    {t("planning.change")}
                  </button>
                )}
              </div>
            ) : (
              <TicketSearch onPick={setPicked} />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("planning.horizon")}</Label>
              <div className="grid grid-cols-2 gap-1 rounded-xl border p-1 text-xs">
                {(["day", "week"] as const).map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setHorizon(h)}
                    className={cn("rounded-lg px-2 py-1.5 font-medium", horizon === h ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground")}
                  >
                    {t(`planning.horizonOf.${h}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pr-date">{horizon === "day" ? t("planning.theDay") : t("planning.theWeek")}</Label>
              <Input id="pr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pr-note">{t("planning.direction")}</Label>
            <Textarea id="pr-note" rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("planning.directionHint")} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Find a ticket (global search). */
function TicketSearch({ onPick }: { onPick: (t: { id: number; number: string; title: string }) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text]);
  const { data, isFetching } = useQuery({
    queryKey: ["tickets", "search", q, false],
    queryFn: () => api.get<{ items: TicketSummary[] }>(`/tickets/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("planning.searchTicket")} className="pl-9" />
        {isFetching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>
      {q.length >= 2 && data && (
        <ul className="max-h-44 overflow-y-auto rounded-lg border">
          {data.items.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">{t("tickets.global.none")}</li>}
          {data.items.map((x) => (
            <li key={x.id}>
              <button type="button" onClick={() => onPick({ id: x.id, number: x.number, title: x.title })} className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent">
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{x.number}</span>
                <span className="truncate">{x.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Weekly calendar ───────────────────────────────────────────────────────────
function WeekCalendar({ technicianId, technicianName, planner }: { technicianId: string; technicianName: string; planner: boolean }) {
  const { t } = useTranslation();
  const ws = useTicketWorkspace();
  const [week, setWeek] = useState(() => mondayOf(new Date()));
  const [weekend, setWeekend] = useState(() => readBool(WEEKEND_KEY, false));
  const [slot, setSlot] = useState<{ block: Block | null; start: Date } | null>(null);
  const days = useMemo(() => Array.from({ length: weekend ? 7 : 5 }, (_, i) => addDays(week, i)), [week, weekend]);
  const from = week.toISOString();
  const to = addDays(week, 7).toISOString();
  const { data: blocks = [], isLoading } = useQuery({
    queryKey: ["planning", "calendar", technicianId, from],
    queryFn: () => api.get<Block[]>(`/planning/calendar?technicianId=${technicianId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    placeholderData: keepPreviousData,
  });
  const { data: outlook } = useQuery({
    queryKey: ["planning", "outlook", technicianId, from],
    queryFn: () => api.get<{ synced: boolean; events: OutlookEvent[]; error?: string }>(`/planning/calendar/outlook?technicianId=${technicianId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const external = outlook?.events ?? [];
  // Absences from the weekly meeting calendar (same data)
  const { data: absences = [] } = useQuery({
    queryKey: ["meetings", "absences", "planning", technicianId, from],
    queryFn: () => api.get<PlanAbsence[]>(`/planning/absences?technicianId=${technicianId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    placeholderData: keepPreviousData,
  });
  const absentOn = (day: Date) => absences.find((x) => x.startDate <= ymd(day) && x.endDate >= ymd(day));
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const label = new Intl.DateTimeFormat(loc(), { day: "numeric", month: "short" });
  const height = (DAY_END - DAY_START) * HOUR_PX;
  const top = (d: Date) => Math.max(0, Math.min(height, (d.getHours() + d.getMinutes() / 60 - DAY_START) * HOUR_PX));
  const hoursOn = (day: Date) =>
    blocks
      .filter((b) => ymd(new Date(b.startsAt)) === ymd(day))
      .reduce((s, b) => s + (new Date(b.endsAt).getTime() - new Date(b.startsAt).getTime()) / 3_600_000, 0);
  const weekHours = days.reduce((s, d) => s + hoursOn(d), 0);

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1.5">
        <CalendarDays className="size-3.5 text-primary" />
        <p className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("planning.week", { from: label.format(week), hours: weekHours.toLocaleString(undefined, { maximumFractionDigits: 1 }) })}</p>
        <IconBtn label={t("planning.prevWeek")} onClick={() => setWeek((w) => addDays(w, -7))}>
          <ChevronLeft className="size-3.5" />
        </IconBtn>
        <button type="button" onClick={() => setWeek(mondayOf(new Date()))} className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
          {t("planning.today")}
        </button>
        <IconBtn label={t("planning.nextWeek")} onClick={() => setWeek((w) => addDays(w, 7))}>
          <ChevronRight className="size-3.5" />
        </IconBtn>
        <button
          type="button"
          onClick={() => {
            setWeekend((v) => !v);
            saveBool(WEEKEND_KEY, !weekend);
          }}
          className={cn("rounded px-1.5 py-0.5 text-[11px]", weekend ? "text-primary" : "text-muted-foreground hover:text-foreground")}
          title={t("planning.weekendHint")}
        >
          {t("planning.weekend")}
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border bg-background/30">
        {/* day headers: date and booked hours */}
        <div className="grid border-b text-center" style={{ gridTemplateColumns: `28px repeat(${days.length}, minmax(0,1fr))` }}>
          <span />
          {days.map((d) => {
            const today = ymd(d) === ymd(now);
            const h = hoursOn(d);
            return (
              <span key={d.toISOString()} className={cn("border-l px-0.5 py-1", today && "bg-[color:var(--gold)]/10")}>
                <span className={cn("block text-[10px] uppercase", today ? "font-semibold text-primary" : "text-muted-foreground")}>
                  {new Intl.DateTimeFormat(loc(), { weekday: "short" }).format(d).replace(".", "")} {d.getDate()}
                </span>
                <span className={cn("block font-mono text-[9px]", h > 8 ? "text-destructive" : h > 0 ? "text-foreground/70" : "text-muted-foreground/50")}>{h ? `${h.toLocaleString(undefined, { maximumFractionDigits: 1 })} h` : "—"}</span>
                {(() => {
                  const ab = absentOn(d);
                  return ab ? (
                    <span className={cn("mt-0.5 block truncate rounded-sm border px-0.5 text-[9px]", ABSENCE_STYLE[ab.kind])} title={[t(`meetings.absences.kind.${ab.kind}`), ab.note].filter(Boolean).join(" · ")}>
                      {t("planning.absent")} · {t(`meetings.absences.kind.${ab.kind}`)}
                    </span>
                  ) : null;
                })()}
                {/* all-day Outlook events */}
                {external
                  .filter((e) => e.allDay && ymd(new Date(e.startsAt)) <= ymd(d) && ymd(new Date(new Date(e.endsAt).getTime() - 1)) >= ymd(d))
                  .map((e) => (
                    <span key={e.id} className="mt-0.5 block truncate rounded-sm border border-dashed border-slate-400/40 px-0.5 text-[9px] text-slate-300" title={e.title}>
                      {e.title}
                    </span>
                  ))}
              </span>
            );
          })}
        </div>
        {/* hours grid */}
        <div className="relative grid" style={{ gridTemplateColumns: `28px repeat(${days.length}, minmax(0,1fr))`, height }}>
          <div className="relative">
            {Array.from({ length: DAY_END - DAY_START }, (_, i) => (
              <span key={i} className="absolute right-1 -translate-y-1/2 font-mono text-[9px] text-muted-foreground" style={{ top: i * HOUR_PX }}>
                {i === 0 ? "" : DAY_START + i}
              </span>
            ))}
          </div>
          {days.map((d) => {
            const dayBlocks = blocks.filter((b) => ymd(new Date(b.startsAt)) === ymd(d));
            const dayEvents = external.filter((e) => !e.allDay && ymd(new Date(e.startsAt)) === ymd(d));
            const today = ymd(d) === ymd(now);
            return (
              <div
                key={d.toISOString()}
                className={cn("relative border-l", today && "bg-[color:var(--gold)]/[0.04]", planner && "cursor-copy")}
                onClick={(e) => {
                  if (!planner) return;
                  const y = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
                  const hour = DAY_START + Math.floor((y / HOUR_PX) * 2) / 2;
                  const start = new Date(d);
                  start.setHours(Math.floor(hour), (hour % 1) * 60, 0, 0);
                  setSlot({ block: null, start });
                }}
              >
                {Array.from({ length: DAY_END - DAY_START }, (_, i) => (
                  <span key={i} className="pointer-events-none absolute inset-x-0 border-t border-border/40" style={{ top: i * HOUR_PX }} />
                ))}
                {absentOn(d) && (
                  <span
                    className="pointer-events-none absolute inset-0 z-[3]"
                    style={{ backgroundImage: "repeating-linear-gradient(135deg, rgba(148,163,184,0.10) 0 6px, transparent 6px 12px)" }}
                  />
                )}
                {today && now.getHours() >= DAY_START && now.getHours() < DAY_END && (
                  <span className="pointer-events-none absolute inset-x-0 z-10 h-px bg-destructive" style={{ top: top(now) }} />
                )}
                {/* Outlook events: read only, under the portal blocks */}
                {dayEvents.map((e) => {
                  const s = new Date(e.startsAt);
                  const en = new Date(e.endsAt);
                  return (
                    <span
                      key={e.id}
                      onClick={(ev) => ev.stopPropagation()}
                      title={`${hm(s)}–${hm(en)} · ${e.title}${e.location ? ` · ${e.location}` : ""} (Outlook)`}
                      className="absolute inset-x-1 z-[4] overflow-hidden rounded-sm border border-dashed border-slate-400/50 bg-slate-500/15 px-1 text-[9px] leading-tight text-slate-300"
                      style={{ top: top(s), height: Math.max(12, top(en) - top(s) - 1) }}
                    >
                      {e.title}
                    </span>
                  );
                })}
                {dayBlocks.map((b) => {
                  const s = new Date(b.startsAt);
                  const e = new Date(b.endsAt);
                  return (
                    <Tooltip key={b.id}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            if (planner) setSlot({ block: b, start: s });
                            else if (b.ticketId) ws.open(b.ticketId);
                          }}
                          className={cn(
                            "absolute inset-x-0.5 z-[5] overflow-hidden rounded-md border px-1 py-0.5 text-left text-[10px] leading-tight shadow-sm transition hover:brightness-110",
                            KIND_STYLE[b.kind],
                          )}
                          style={{ top: top(s), height: Math.max(14, top(e) - top(s) - 1) }}
                        >
                          <span className="flex items-center gap-0.5 font-mono text-[9px]">
                            {b.kind === "onsite" && <MapPin className="size-2.5 shrink-0 text-orange-300" />}
                            {b.ticketNumber && <span className={b.kind === "onsite" ? "text-orange-200" : "text-primary"}>{b.ticketNumber.slice(-4)}</span>}
                          </span>
                          <span className="line-clamp-2">{b.kind === "onsite" && b.companyName ? b.companyName : b.title}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-64">
                        <p className="text-[10px] uppercase tracking-wide opacity-70">{t(`planning.kind.${b.kind}`)}</p>
                        <p className="font-medium">
                          {hm(s)}–{hm(e)} · {b.title}
                        </p>
                        {b.companyName && b.kind === "onsite" && (
                          <p className="flex items-center gap-1">
                            <MapPin className="size-3" /> {b.companyName}
                          </p>
                        )}
                        {b.ticketNumber && <p className="font-mono text-[10px] opacity-80">{b.ticketNumber}</p>}
                        {b.note && <p className="mt-1 opacity-80">{b.note}</p>}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            );
          })}
          {isLoading && <div className="absolute inset-0 animate-pulse bg-background/30" />}
        </div>
      </div>
      {/* legend */}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className={cn("size-2.5 rounded-sm border", KIND_STYLE.work)} /> {t("planning.kind.work")}
        </span>
        <span className="flex items-center gap-1">
          <MapPin className="size-3 text-orange-300" /> {t("planning.kind.onsite")}
        </span>
        <span className="flex items-center gap-1">
          <span className={cn("size-2.5 rounded-sm border", KIND_STYLE.slot)} /> {t("planning.kind.slot")}
        </span>
        {absences.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="size-2.5 rounded-sm border border-slate-400/40" style={{ backgroundImage: "repeating-linear-gradient(135deg, rgba(148,163,184,0.35) 0 2px, transparent 2px 4px)" }} /> {t("planning.absent")}
          </span>
        )}
        {outlook?.synced && (
          <span className="flex items-center gap-1">
            <span className="size-2.5 rounded-sm border border-dashed border-slate-400/60" /> Outlook
          </span>
        )}
      </p>
      {outlook?.error && <p className="text-[10px] text-orange-300">{t("planning.outlookError")}</p>}
      {planner && <p className="text-[10px] text-muted-foreground">{t("planning.clickToReserve")}</p>}
      {slot && <BlockDialog technicianId={technicianId} technicianName={technicianName} block={slot.block} start={slot.start} onClose={() => setSlot(null)} onOpenTicket={(id) => ws.open(id)} />}
    </section>
  );
}

/** Reserve time (for a priority ticket, or a reserved slot) — or change / remove it. */
function BlockDialog({
  technicianId,
  technicianName,
  block,
  start,
  onClose,
  onOpenTicket,
}: {
  technicianId: string;
  technicianName: string;
  block: Block | null;
  start: Date;
  onClose: () => void;
  onOpenTicket: (id: number) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: pins = [] } = usePriorities(technicianId, ymd(start));
  const [kind, setKind] = useState<BlockKind>(block?.kind ?? "work");
  const [reminder, setReminder] = useState(block?.reminderMinutes ?? 15);
  const [picked, setPicked] = useState<{ id: number; number: string; title: string } | null>(block?.ticketId ? { id: block.ticketId, number: block.ticketNumber ?? "", title: block.title } : null);
  const [title, setTitle] = useState(block && !block.ticketId ? block.title : "");
  const [date, setDate] = useState(ymd(start));
  const [from, setFrom] = useState(hm(start));
  const [until, setUntil] = useState(hm(block ? new Date(block.endsAt) : new Date(start.getTime() + 3_600_000)));
  const [note, setNote] = useState(block?.note ?? "");
  const at = (d: string, h: string) => new Date(`${d}T${h}:00`).toISOString();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["planning"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      block
        ? api.patch<{ warnings: string[] }>(`/planning/calendar/${block.id}`, {
            startsAt: at(date, from),
            endsAt: at(date, until),
            note: note.trim(),
            reminderMinutes: reminder,
            ...(kind === "slot" && title.trim() ? { title: title.trim() } : {}),
          })
        : api.post<{ warnings: string[] }>("/planning/calendar", {
            technicianId,
            kind,
            ticketId: kind === "slot" ? null : picked?.id,
            title: kind === "slot" ? title.trim() : "",
            note: note.trim(),
            reminderMinutes: reminder,
            startsAt: at(date, from),
            endsAt: at(date, until),
          }),
    onSuccess: (r) => {
      toast.success(t("planning.saved"));
      // saved, but Autotask or Outlook did not follow
      for (const w of r?.warnings ?? []) toast.warning(t(`planning.warnings.${w.split("_")[0]}`, { code: w }));
      done();
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const remove = useMutation({ mutationFn: () => api.del(`/planning/calendar/${block!.id}`), onSuccess: done });
  const valid = until > from && (kind === "slot" ? title.trim().length > 0 : Boolean(picked));
  const open = pins.filter((p) => !p.doneAt);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="size-5 text-primary" /> {block ? t("planning.editBlock") : t("planning.reserve")}
          </DialogTitle>
          <DialogDescription>{t("planning.for", { name: technicianName })}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          {!block && (
            <div className="grid grid-cols-3 gap-1 rounded-xl border p-1 text-xs">
              {(["work", "onsite", "slot"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    "flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 font-medium",
                    kind === k ? (k === "onsite" ? "bg-orange-500 text-white" : "bg-grad-gold text-[#1a1204]") : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {k === "onsite" && <MapPin className="size-3.5" />}
                  {t(`planning.kind.${k}`)}
                </button>
              ))}
            </div>
          )}
          {kind !== "slot" ? (
            <div className="space-y-1.5">
              <Label>{t("planning.ticket")}</Label>
              {picked ? (
                <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <span className="font-mono text-xs text-primary">{picked.number}</span>
                  <span className="min-w-0 flex-1 truncate">{picked.title}</span>
                  {block?.ticketId ? (
                    <button type="button" onClick={() => onOpenTicket(block.ticketId!)} className="text-xs text-primary hover:underline">
                      {t("planning.openTicket")}
                    </button>
                  ) : (
                    <button type="button" onClick={() => setPicked(null)} className="text-xs text-muted-foreground hover:text-foreground">
                      {t("planning.change")}
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {open.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {open.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setPicked({ id: p.ticketId, number: p.ticketNumber, title: p.ticketTitle })}
                          className="flex max-w-full items-center gap-1 rounded-full border border-[color:var(--gold)]/40 px-2 py-0.5 text-xs hover:bg-[color:var(--gold)]/10"
                        >
                          <Star className="size-3 text-primary" /> <span className="truncate">{p.ticketTitle}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <TicketSearch onPick={setPicked} />
                  <p className="text-[11px] text-muted-foreground">{t("planning.becomesPriority")}</p>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="bl-title">{t("planning.slotTitle")}</Label>
              <Input id="bl-title" autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("planning.slotHint")} />
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bl-date">{t("planning.date")}</Label>
              <Input id="bl-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bl-from">{t("planning.from")}</Label>
              <Input id="bl-from" type="time" step={900} value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bl-to">{t("planning.until")}</Label>
              <Input id="bl-to" type="time" step={900} value={until} onChange={(e) => setUntil(e.target.value)} />
            </div>
          </div>
          {kind === "onsite" && <p className="-mt-2 flex items-start gap-1.5 rounded-lg bg-orange-500/10 px-3 py-2 text-[11px] text-orange-200"><MapPin className="mt-0.5 size-3 shrink-0" /> {block?.autotaskServiceCallId ? t("planning.serviceCallLinked", { id: block.autotaskServiceCallId }) : t("planning.serviceCallHint")}</p>}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <BellRing className="size-3.5 text-primary" /> {t("planning.reminder")}
            </Label>
            <Select value={String(reminder)} onValueChange={(v) => setReminder(Number(v))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {REMINDERS.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {m ? t("planning.reminderBefore", { count: m }) : t("planning.noReminder")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bl-note">{t("planning.blockNote")}</Label>
            <Textarea id="bl-note" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            {block && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => void confirm({ title: t("planning.removeBlockConfirm"), destructive: true }).then((ok) => ok && remove.mutate())}
              >
                <Trash2 className="size-4" /> {t("planning.removeBlock")}
              </Button>
            )}
            <span className="flex-1" />
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** In a ticket window: who has this ticket as a priority, with the direction. */
export function TicketPriorities({ ticketId }: { ticketId: number }) {
  const { t } = useTranslation();
  const { data = [] } = useQuery({
    queryKey: ["planning", "ticket", ticketId],
    queryFn: () => api.get<{ id: string; technician: string; note: string; horizon: Horizon; forDate: string; doneAt: string | null; pinnedByName: string | null }[]>(`/planning/pins/ticket/${ticketId}`),
    staleTime: 30_000,
  });
  const shown = data.filter((p) => !p.doneAt);
  if (!shown.length) return null;
  return (
    <div className="space-y-2">
      {shown.map((p) => (
        <div key={p.id} className="flex items-start gap-3 rounded-xl border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/[0.07] px-4 py-3 text-sm">
          <Star className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {t(`planning.bannerOf.${p.horizon}`, { name: p.technician })}
              {p.pinnedByName && <span className="font-normal text-muted-foreground"> · {t("planning.by", { name: p.pinnedByName })}</span>}
            </p>
            {p.note && <p className="mt-1 whitespace-pre-wrap text-foreground/90">{p.note}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Allow browser notifications (alerts even when the tab is in the background). */
function BrowserAlerts() {
  const { t } = useTranslation();
  const [state, setState] = useState(() => ("Notification" in window ? Notification.permission : "denied"));
  if (state !== "default") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-primary" onClick={() => void Notification.requestPermission().then(setState)} aria-label={t("planning.allowAlerts")}>
          <BellRing className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("planning.allowAlerts")}</TooltipContent>
    </Tooltip>
  );
}

type Note = { id: string; type: string; data: Record<string, string>; link: string | null; readAt: string | null; createdAt: string };
const SEEN_KEY = "akab.reminders.seen";

/**
 * Alerts before an event: when a reminder arrives (bell feed, every 30 s), a
 * pop-up stays on screen with "Open", and the browser shows a notification
 * if allowed. Each alert pops once.
 */
export function ReminderWatcher() {
  const { t } = useTranslation();
  const ws = useTicketWorkspace();
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<{ items: Note[]; unread: number }>("/notifications"),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    const items = (data?.items ?? []).filter((n) => n.type === "calendar.reminder" && !n.readAt && Date.now() - new Date(n.createdAt).getTime() < 2 * 3_600_000);
    if (!items.length) return;
    let seen: string[] = [];
    try {
      seen = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[];
    } catch {
      seen = [];
    }
    const fresh = items.filter((n) => !seen.includes(n.id));
    if (!fresh.length) return;
    for (const n of fresh) {
      const when = new Date(n.data.startsAt);
      const title = t(n.data.kind === "onsite" ? "planning.alert.onsite" : "planning.alert.event", { minutes: n.data.minutes, time: hm(when) });
      const body = [n.data.number, n.data.title, n.data.company].filter(Boolean).join(" · ");
      const ticketId = Number(n.link?.match(/ticket=(\d+)/)?.[1]);
      toast(title, {
        description: body,
        icon: n.data.kind === "onsite" ? <MapPin className="size-4 text-orange-400" /> : <CalendarClock className="size-4 text-primary" />,
        duration: 5 * 60_000,
        action: ticketId ? { label: t("planning.openTicket"), onClick: () => ws.open(ticketId) } : undefined,
      });
      if ("Notification" in window && Notification.permission === "granted") {
        try {
          const note = new Notification(title, { body, tag: n.id, icon: "/akab-icon.png" });
          note.onclick = () => {
            window.focus();
            if (ticketId) ws.open(ticketId);
          };
        } catch {
          /* not supported here */
        }
      }
    }
    try {
      sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen, ...fresh.map((n) => n.id)].slice(-100)));
    } catch {
      /* ignore */
    }
  }, [data, t, ws]);
  return null;
}
