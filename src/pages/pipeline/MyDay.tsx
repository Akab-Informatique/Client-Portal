import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowDownUp, GripVertical, CalendarClock, CalendarDays, Star, CalendarOff, CheckCircle2, EyeOff, ChevronLeft, ChevronRight, Coffee, Loader2, Lock, MessageSquareText, Plus, RefreshCw, Sparkles, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiDirection, useAiDirection } from "@/components/AiDirection";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useTicketWorkspace } from "@/pages/tickets/workspace";
import { PRIORITY_STYLE, addDays, dayLabel, hm, longDay, todayYmd, toMinutes, type Block, type DayData, type DayItem, type TaskCard } from "./shared";
import { taskError, usePeople } from "./TaskDialog";
import { DayProjects, MyTickets, Priorities } from "./DayLists";
import { DayEdge } from "./DayEdge";
import { AgendaCard } from "@/pages/tickets/Planning";
import { DayBlockDialog, type DayBlockDraft } from "./DayBlockDialog";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { byCustom, useCustomOrder, useSortDefault } from "@/lib/sortPrefs";
import { useProjectWorkspace } from "@/pages/projects/ProjectWorkspace";

const addMin = (hhmm: string, plus: number) => {
  const m = Math.min(23 * 60 + 45, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + plus);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** The hours shown on the timeline: from an hour before the day starts to an hour after it ends */
const DEFAULT_HOUR_PX = 100;
const HOUR_PX_KEY = "akab.pipeline.hourPx.v2";

/**
 * Ma journée: what is on the plate today, laid out as a suggestion (blocks of time, not a booking) with the AI's
 * summary and whether there is time for all of it. Everything opens in place: a task in its window, a ticket in the ticket window.
 */
export function MyDay({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const ws = useTicketWorkspace();
  const pws = useProjectWorkspace();
  const people = usePeople();
  const [date, setDate] = useState(todayYmd());
  const [userId, setUserId] = useState<string>(me.id);
  const [quick, setQuick] = useState("");
  // the height of the blocks of the day: dragged by the bar under them (pixels an hour), kept on this computer
  const [hourPx, setHourPx] = useState(() => {
    const v = Number(localStorage.getItem(HOUR_PX_KEY));
    return v >= 60 && v <= 200 ? v : DEFAULT_HOUR_PX;
  });
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = hourPx;
    let last = h0;
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.min(200, Math.max(60, h0 + (ev.clientY - y0) / 8)));
      setHourPx(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(HOUR_PX_KEY, String(last));
      } catch {
        /* not kept */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // the width of the left side (percent), dragged with the mouse and kept on this computer
  const box = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(() => {
    const v = Number(localStorage.getItem("akab.pipeline.split"));
    return v >= 25 && v <= 75 ? v : 46;
  });
  const setSplitSaved = (v: number) => {
    setSplit(v);
    try {
      localStorage.setItem("akab.pipeline.split", String(v));
    } catch {
      /* not kept */
    }
  };
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    let last = split;
    const move = (ev: PointerEvent) => {
      last = Math.min(75, Math.max(25, ((ev.clientX - rect.left) / rect.width) * 100));
      setSplit(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSplitSaved(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const direction = useAiDirection(`pipeline.day:${date}:${userId}`);
  const key = ["pipeline", "day", date, userId];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get<DayData>(`/pipeline/day?date=${date}${userId !== me.id ? `&userId=${userId}` : ""}`),
    refetchInterval: 60_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["pipeline"] });
  // a slot of time blocked by hand (new, or an existing one being edited)
  const [blockDraft, setBlockDraft] = useState<DayBlockDraft | null>(null)
  const replan = useMutation({
    mutationFn: () => api.post<{ aiError: string | null }>("/pipeline/day/plan", { date, ...(userId !== me.id ? { userId } : {}), ...direction.body }),
    onSuccess: (r) => {
      refresh();
      if (r.aiError) toast.message(t("pipeline.day.rulesOnly"), { description: t(`pipeline.day.aiError.${["not_configured", "disabled"].includes(r.aiError) ? r.aiError : "other"}`) });
      else toast.success(t("pipeline.day.replanned"));
    },
    onError: () => toast.error(t("common.error")),
  });
  const complete = useMutation({
    mutationFn: (id: string) => api.patch(`/pipeline/tasks/${id}`, { status: "done" }),
    onSuccess: refresh,
    onError: (e) => toast.error(taskError(t, e)),
  });
  const add = useMutation({
    mutationFn: (title: string) => api.post("/pipeline/tasks", { title, assigneeId: userId, dueDate: date }),
    onSuccess: () => {
      setQuick("");
      refresh();
    },
    onError: (e) => toast.error(taskError(t, e)),
  });

  const first = me.name.split(/\s+/)[0];
  const isToday = date === todayYmd();
  const plan = data?.plan;
  const short = plan ? Math.max(0, plan.plannedMinutes - plan.capacityMinutes) : 0;
  const pct = plan && plan.capacityMinutes > 0 ? Math.min(100, Math.round((Math.min(plan.plannedMinutes, plan.capacityMinutes) / plan.capacityMinutes) * 100)) : 0;
  const tickets = (data?.items ?? []).filter((i) => i.kind === "ticket");
  const tasks = (data?.items ?? []).filter((i) => i.kind === "task");
  // the list of tasks is every open task of the person, not only the ones of the day
  const allTasks = useQuery({
    queryKey: ["pipeline", "tasks", "mine-open", userId],
    queryFn: () => api.get<TaskCard[]>(`/pipeline/tasks?status=open&${userId === me.id ? "scope=mine" : `assignee=${userId}`}`),
    refetchInterval: 60_000,
  });
  const today = todayYmd();
  const taskItems: DayItem[] = (allTasks.data ?? [])
    .map((k): DayItem => ({ key: `task:${k.id}`, kind: "task", refId: k.id, title: k.title, priority: k.priority, due: k.checkpointDate ? `${k.checkpointDate} ${k.checkpointTime ?? "17:00"}` : k.dueDate ? `${k.dueDate} 23:59` : null, overdue: Boolean(k.dueDate && k.dueDate < today), minutes: k.estimateMinutes ?? 30, ticketNumber: k.ticketNumber, blocked: k.waiting || k.status === "blocked", reminder: Boolean(k.continuous && k.remindEveryDays) }))
    .sort((a, b) => (a.due ?? "9999-99-99 ").localeCompare(b.due ?? "9999-99-99 ") || a.title.localeCompare(b.title));
  const check = useMutation({
    mutationFn: (id: string) => api.post(`/pipeline/tasks/${id}/check`, {}),
    onSuccess: () => {
      toast.success(t("pipeline.checked"));
      refresh();
    },
    onError: (e) => toast.error(taskError(t, e)),
  });
  const open = (i: DayItem) => (i.kind === "ticket" ? ws.open(Number(i.refId)) : i.kind === "ptask" ? i.projectId && pws.openTask(i.projectId, i.refId) : onOpenTask(i.refId));
  const projectTasks = (data?.items ?? []).filter((i) => i.kind === "ptask");
  const when = plan ? new Date(plan.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className="space-y-4">
      {/* the day, and who it is for */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border bg-background/40 p-0.5">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setDate(addDays(date, -1))} aria-label={t("pipeline.day.prev")}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" className={cn("h-8 min-w-36 px-3 capitalize", isToday && "text-primary")} onClick={() => setDate(todayYmd())}>
            {isToday ? t("pipeline.day.today") : dayLabel(date)}
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setDate(addDays(date, 1))} aria-label={t("pipeline.day.next")}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        {can("pipeline.manage") && (
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className="h-9 rounded-md border bg-transparent px-2 text-sm" aria-label={t("pipeline.day.whose")}>
            <option value={me.id}>{t("pipeline.day.mine")}</option>
            {(people.data ?? []).filter((p) => p.id !== me.id).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* the summary: the AI's words, and whether there is time */}
      <section className="glass relative overflow-hidden rounded-2xl border border-[color:var(--gold)]/25 p-5">
        <div className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-[color:var(--gold)]/10 blur-3xl" />
        {isLoading || !data || !plan ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <div className="relative grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-bold capitalize">{userId === me.id ? t("pipeline.day.hello", { name: first }) : (people.data?.find((p) => p.id === userId)?.name ?? "")}</h2>
                <span className="text-sm capitalize text-muted-foreground">{longDay(date)}</span>
                <span
                  className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", plan.source === "ai" ? "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary" : "border-muted-foreground/30 text-muted-foreground")}
                >
                  <Sparkles className="size-3" /> {plan.source === "ai" ? t("pipeline.day.byAi") : t("pipeline.day.byRules")}
                </span>
                {plan.smsSentAt && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <MessageSquareText className="size-3" /> {new Date(plan.smsSentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{t("pipeline.day.smsSent")}</TooltipContent>
                  </Tooltip>
                )}
              </div>
              <p className="max-w-3xl text-[15px] leading-relaxed">{plan.summary}</p>
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
                <span>{t("pipeline.day.updated", { time: when })}</span>
                <span className={cn("flex items-center gap-1", plan.calendar === "ok" ? "text-sky-300" : plan.calendar === "none" ? "" : "text-orange-300")} title={plan.calendar === "ok" || plan.calendar === "none" ? undefined : plan.calendar}>
                  <CalendarDays className="size-3" />{" "}
                  {plan.calendar === "ok" ? t("pipeline.day.calendarOk", { count: plan.calendarEvents }) : plan.calendar === "none" ? t("pipeline.day.calendarNone") : plan.calendar === "o365_not_signed_in" ? t("pipeline.day.calendarSignIn") : t("pipeline.day.calendarError")}
                </span>
                {data.stale && <span className="flex items-center gap-1 text-orange-300"><AlertTriangle className="size-3" /> {t("pipeline.day.stale")}</span>}
                {can("pipeline.edit") && (
                  <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={replan.isPending} onClick={() => replan.mutate()}>
                    {replan.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("pipeline.day.replan")}
                  </Button>
                )}
                {can("pipeline.edit") && (
                  <AiDirection id={`pipeline.day:${date}:${userId}`} className="-ml-2" />
                )}
              </div>
            </div>
            {/* the time: planned against free */}
            <div className="space-y-2 rounded-xl border bg-background/40 p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("pipeline.day.time")}</span>
                <span className="font-mono text-sm">
                  {hm(plan.plannedMinutes)} <span className="text-muted-foreground">/ {hm(plan.capacityMinutes)}</span>
                </span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full transition-all", short > 0 ? "bg-gradient-to-r from-orange-400 to-red-500" : "bg-grad-gold")} style={{ width: `${plan.capacityMinutes ? pct : 0}%` }} />
              </div>
              {data.absent ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <CalendarOff className="size-4" /> {t("pipeline.day.dayOff")}
                </p>
              ) : short > 0 ? (
                <p className="flex items-center gap-1.5 text-sm font-medium text-orange-300">
                  <AlertTriangle className="size-4" /> {t("pipeline.day.short", { time: hm(short) })}
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-300">
                  <CheckCircle2 className="size-4" /> {t("pipeline.day.enough", { time: hm(plan.capacityMinutes - plan.plannedMinutes) })}
                </p>
              )}
              <div className="grid grid-cols-3 gap-2 pt-1 text-center">
                {[
                  [tickets.length, t("pipeline.day.tickets")],
                  [tasks.length, t("pipeline.day.tasks")],
                  [data.doneToday, t("pipeline.day.done")],
                ].map(([n, label]) => (
                  <div key={String(label)} className="rounded-lg bg-muted/40 py-1.5">
                    <p className="font-mono text-lg font-semibold leading-none">{n}</p>
                    <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {blockDraft && <DayBlockDialog key={blockDraft.id ?? "new"} draft={blockDraft} date={date} forUser={userId === me.id ? undefined : userId} onClose={() => setBlockDraft(null)} onSaved={refresh} />}
      {/* left: the blocks of the day (and the priorities of the day); right: the priorities of the week, all my tickets (compact), projects, tasks. The bar between them is dragged to give one side more room. */}
      <div ref={box} className="grid gap-4 xl:gap-0 xl:grid-cols-[var(--split)_12px_minmax(0,1fr)]" style={{ "--split": `${split}%` } as React.CSSProperties}>
        <div className="min-w-0 space-y-4">
          <Priorities items={data?.items ?? []} horizon="day" onOpen={open} canRemove={can("pipeline.edit") && (userId === me.id || can("pipeline.manage"))} forUser={userId === me.id ? undefined : userId} />
          <section className="glass h-fit rounded-2xl border border-[color:var(--gold)]/30 p-4 shadow-[0_0_30px_-12px_rgba(255,206,26,0.35)]">
            <div className="relative mb-3 flex items-center justify-center">
              <h3 className="flex items-center gap-2 text-center text-base font-bold tracking-wide text-primary">
                <CalendarClock className="size-5" /> {t("pipeline.day.timeline")}
              </h3>
              <div className="absolute right-0 flex items-center gap-1">
              {can("pipeline.edit") && (userId === me.id || can("pipeline.manage")) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="size-7 text-pink-300 hover:bg-pink-500/15" onClick={() => setBlockDraft({ start: "09:00", end: "10:00", title: "", note: "" })} aria-label={t("pipeline.day.block.title")}>
                      <CalendarClock className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("pipeline.day.block.title")}</TooltipContent>
                </Tooltip>
              )}
              {can("pipeline.edit") && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="size-7 text-violet-300 hover:bg-violet-500/15" disabled={replan.isPending} onClick={() => replan.mutate()} aria-label={t("pipeline.day.aiRefresh")}>
                      {replan.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("pipeline.day.aiRefresh")}</TooltipContent>
                </Tooltip>
              )}
              </div>
            </div>
            {isToday && data && data.reevaluate.length > 0 && (
              <div className="mb-3">
                <Reevaluate items={data.reevaluate} onOpen={open} />
              </div>
            )}
            {data && data.items.length === 0 && <p className="mb-3 rounded-lg border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">{t("pipeline.day.emptyManual")}</p>}
            <div className="mb-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              {[
                ["bg-[color:var(--gold)]/60", "pipeline.day.legend.ticket"],
                ["bg-violet-400/70", "pipeline.day.legend.task"],
                ["bg-teal-400/70", "pipeline.day.legend.project"],
                ["bg-pink-400/70", "pipeline.day.legend.local"],
              ].map(([c, k]) => (
                <span key={k} className="flex items-center gap-1">
                  <span className={cn("size-2 rounded-sm", c)} /> {t(k)}
                </span>
              ))}
            </div>
            {data && data.plan.blocks.some((b) => b.allDay) && (
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("pipeline.day.allDay")}</span>
                {data.plan.blocks
                  .filter((b) => b.allDay)
                  .map((b, i) => (
                    <span key={i} className="rounded-full border border-sky-400/30 bg-sky-500/10 px-2.5 py-0.5 text-xs text-sky-200">
                      {b.title}
                    </span>
                  ))}
              </div>
            )}
            {isLoading || !data ? <Skeleton className="h-96 w-full" /> : <Timeline data={data} hourPx={hourPx} onBlock={(b, start) => setBlockDraft(b ? { id: b.refId ?? undefined, start: b.start, end: b.end, title: b.title, note: b.detail ?? "" } : { start: start ?? "09:00", end: start ? addMin(start, 60) : "10:00", title: "", note: "" })} canEdit={can("pipeline.edit") && (userId === me.id || can("pipeline.manage"))} forUser={userId === me.id ? undefined : userId} onSaved={refresh} onOpen={(b) => (b.kind === "ticket" ? ws.open(Number(b.refId)) : b.kind === "ptask" ? b.projectId && b.refId && pws.openTask(b.projectId, b.refId) : b.refId && onOpenTask(b.refId))} />}
            <div role="separator" aria-orientation="horizontal" title={t("pipeline.day.resizeHeight")} aria-label={t("pipeline.day.resizeHeight")} onPointerDown={startResize} onDoubleClick={() => setHourPx(DEFAULT_HOUR_PX)} className="group mt-2 flex h-3 cursor-row-resize touch-none items-center justify-center">
              <span className="h-0.5 w-16 rounded-full bg-[color:var(--glass-border)] transition-colors group-hover:bg-[color:var(--gold)]/60 group-active:bg-[color:var(--gold)]" />
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">{t("pipeline.day.suggestion")}</p>
          </section>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("pipeline.day.resize")}
          title={t("pipeline.day.resize")}
          onPointerDown={startDrag}
          onDoubleClick={() => setSplitSaved(46)}
          className="group hidden cursor-col-resize touch-none items-stretch justify-center xl:flex"
        >
          <span className="my-2 w-0.5 rounded-full bg-[color:var(--glass-border)] transition-colors group-hover:bg-[color:var(--gold)]/60 group-active:bg-[color:var(--gold)]" />
        </div>

        <div className="min-w-0 space-y-4">
          {/* the week, as on the Tickets page: a small square per day, and the priorities of the day picked below */}
          <AgendaCard compact filterTech={userId === me.id ? null : userId} />
          <MyTickets userId={userId} mine={userId === me.id} onOpen={(id) => ws.open(id)} />
          {userId === me.id && can("projects.view") && <DayProjects />}
          {projectTasks.length > 0 && <ItemList title={t("pipeline.day.projectTasks")} icon={Workflow} items={projectTasks} loading={false} onOpen={open} empty="" sortView="projectTasks" />}
          <ItemList title={t("pipeline.day.tasksToday")} icon={Workflow} items={taskItems} loading={allTasks.isLoading} onOpen={open} onComplete={can("pipeline.edit") ? (i) => (i.reminder ? check.mutate(i.refId) : complete.mutate(i.refId)) : undefined} empty={t("pipeline.day.noTasks")} sortView="tasks" />
          {can("pipeline.edit") && (
            <form
              className="glass flex gap-2 rounded-2xl border p-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (quick.trim()) add.mutate(quick.trim());
              }}
            >
              <Plus className="my-auto ml-2 size-4 shrink-0 text-primary" />
              <Input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder={t("pipeline.day.quickAdd")} className="h-9 border-transparent bg-transparent shadow-none focus-visible:border-input" maxLength={200} />
              <Button type="submit" size="sm" disabled={!quick.trim() || add.isPending} className="h-9 bg-grad-gold font-semibold text-[#1a1204]">
                {t("pipeline.add")}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

const LIST_SORTS = ["checkpoint", "priority", "name", "custom"] as const;
type ListSort = (typeof LIST_SORTS)[number];
const PRIO_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

/** A list of tasks of the day: checkpoint order by default; the technician picks the sort (their default for this list) or drags their own order. */
/** What is late and not done is not planned in the day: a reminder on top to look at its dates again */
function Reevaluate({ items, onOpen }: { items: DayItem[]; onOpen: (i: DayItem) => void }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(true);
  return (
    <section className="rounded-2xl border border-orange-400/40 bg-orange-500/[0.07] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="size-4 text-orange-300" />
        <h3 className="text-sm font-semibold text-orange-200">{t("pipeline.day.reevaluate.title", { count: items.length })}</h3>
        <button type="button" onClick={() => setShown((v) => !v)} className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline">
          {shown ? t("pipeline.day.reevaluate.hide") : t("pipeline.day.reevaluate.show")}
        </button>
      </div>
      {shown && (
        <>
          <p className="mt-1 text-xs text-muted-foreground">{t("pipeline.day.reevaluate.text")}</p>
          <ul className="mt-2 grid gap-1 md:grid-cols-2">
            {items.map((i) => (
              <li key={i.key}>
                <button type="button" onClick={() => onOpen(i)} className="flex w-full items-center gap-2 rounded-lg border border-orange-400/20 bg-background/40 px-2.5 py-1.5 text-left text-sm hover:bg-foreground/[0.05]">
                  <span className={cn("size-2 shrink-0 rounded-full", i.kind === "ticket" ? "bg-[color:var(--gold)]" : i.kind === "ptask" ? "bg-teal-400" : "bg-violet-400")} />
                  {i.ticketNumber && <span className="shrink-0 font-mono text-xs text-primary">{i.ticketNumber}</span>}
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  <span className="shrink-0 text-[11px] text-orange-300">{t("pipeline.day.reevaluate.since", { date: (i.checkpoint ?? i.due ?? "").slice(0, 10) })}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ItemList({ title, icon: Icon, items, loading, onOpen, onComplete, empty, sortView }: { title: string; icon: typeof Workflow; items: DayItem[]; loading: boolean; onOpen: (i: DayItem) => void; onComplete?: (i: DayItem) => void; empty: string; sortView: string }) {
  const { t } = useTranslation();
  const [sort, setSort] = useSortDefault<ListSort>(`day.${sortView}`, "checkpoint", LIST_SORTS);
  const { keys, save } = useCustomOrder(`day:${sortView}`, sort === "custom");
  // "checkpoint": the order the list comes in (checkpoint day and time, then the due day)
  const shown = sort === "custom" ? byCustom(items, (i) => i.key, keys) : sort === "priority" ? [...items].sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority]) : sort === "name" ? [...items].sort((a, b) => a.title.localeCompare(b.title)) : items;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = shown.map((i) => i.key);
    save(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
    if (sort !== "custom") setSort("custom");
  };
  return (
    <section className="glass rounded-2xl border p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="size-3.5" /> {title} <span className="font-mono normal-case opacity-70">{items.length}</span>
        </h3>
        {items.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
              <ArrowDownUp className="size-3" /> {t(`pipeline.day.listSort.${sort}`)}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {LIST_SORTS.map((s) => (
                <DropdownMenuItem key={s} onClick={() => setSort(s === "checkpoint" ? null : s)} className={cn(s === sort && "font-semibold text-primary")}>
                  {t(`pipeline.day.listSort.${s}`)}
                </DropdownMenuItem>
              ))}
              <p className="max-w-56 px-2 py-1.5 text-[10px] text-muted-foreground">{t("projects.sort.hint")}</p>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : items.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
          <SortableContext items={shown.map((i) => i.key)} strategy={verticalListSortingStrategy}>
            <ul className="divide-y divide-[color:var(--glass-border)]">
              {shown.map((i) => (
                <ItemRow key={i.key} i={i} onOpen={onOpen} onComplete={onComplete} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

function ItemRow({ i, onOpen, onComplete }: { i: DayItem; onOpen: (i: DayItem) => void; onComplete?: (i: DayItem) => void }) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: i.key });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("flex items-center gap-2.5 py-2", isDragging && "relative z-10 bg-background/80 opacity-80")}>
      <button type="button" aria-label={t("projects.sort.drag")} title={t("projects.sort.drag")} className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing" {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </button>
      {!i.masked && (i.kind === "ticket" || i.kind === "task" || i.kind === "ptask") && <DayEdge kind={i.kind} id={i.refId} number={i.ticketNumber} title={i.title} urgent={i.priority === "urgent"} onOpen={() => onOpen(i)} />}
      {onComplete && <Checkbox disabled={i.blocked} onCheckedChange={() => onComplete(i)} aria-label={t("pipeline.complete")} />}
      <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_STYLE[i.priority].dot)} />
      <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left">
        <span className="flex items-baseline gap-2">
          {i.pin && <Star className={cn("size-3 shrink-0 fill-current", i.pin === "day" ? "text-primary" : "text-muted-foreground")} aria-label={t(`pipeline.day.pin.${i.pin}`)} />}
          {i.ticketNumber && <span className="shrink-0 font-mono text-[11px] text-primary">{i.ticketNumber}</span>}
          <span className={cn("truncate text-sm font-medium", i.masked && "italic text-muted-foreground")}>{i.title || t("pipeline.private")}</span>
        </span>
        {(i.client || i.pinNote) && <span className="block truncate text-xs text-muted-foreground">{[i.client, i.pinNote].filter(Boolean).join(" · ")}</span>}
      </button>
      {i.blocked && <Lock className="size-3.5 shrink-0 text-fuchsia-300" />}
      {i.overdue && <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 text-[10px] font-medium text-red-300">{t("pipeline.late")}</span>}
      {i.dueTime && <span className="shrink-0 font-mono text-[10px] text-orange-300">{t("pipeline.before", { time: i.dueTime })}</span>}
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{hm(i.minutes)}</span>
    </li>
  );
}

/** The day from the start of work to its end, an hour on each side; the blocks are placed by their time. */
function Timeline({ data, onOpen, onBlock, hourPx, canEdit, forUser, onSaved }: { data: DayData; onOpen: (b: Block) => void; onBlock: (b?: Block, start?: string) => void; hourPx: number; canEdit: boolean; forUser?: string; onSaved: () => void }) {
  const { t } = useTranslation();
  // a block is stretched or shrunk by its top or bottom edge, in quarter hours (the time given to that ticket / task)
  const [drag, setDrag] = useState<{ i: number; edge: "top" | "bottom"; delta: number } | null>(null);
  const saveTime = useMutation({
    mutationFn: (v: { key: string; minutes: number }) => api.put("/pipeline/day/alloc", { date: data.date, key: v.key, minutes: v.minutes, ...(forUser ? { userId: forUser } : {}) }),
    onSuccess: onSaved,
    onError: () => toast.error(t("common.error")),
  });
  // a block is dragged up or down to change its place in the day: the others follow in the order given
  const [move, setMove] = useState<{ i: number; dy: number } | null>(null);
  const lane = useRef<HTMLDivElement>(null);
  const justMoved = useRef(false);
  const saveStart = useMutation({
    mutationFn: (v: { key: string; minute: number }) => api.put("/pipeline/day/start", { date: data.date, key: v.key, minute: v.minute, ...(forUser ? { userId: forUser } : {}) }),
    onSuccess: onSaved,
    onError: () => toast.error(t("common.error")),
  });
  const totals = new Map<string, number>();
  for (const b of data.plan.blocks) {
    if (!b.overflow && b.start && b.end && b.refId && (b.kind === "ticket" || b.kind === "task" || b.kind === "ptask")) {
      const k = `${b.kind}:${b.refId}`;
      totals.set(k, (totals.get(k) ?? 0) + toMinutes(b.end) - toMinutes(b.start));
    }
  }
  const startMove = (e: React.PointerEvent, i: number, key: string) => {
    if (e.button !== 0) return;
    const y0 = e.clientY;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - y0) < 6) return;
      moved = true;
      setMove({ i, dy: ev.clientY - y0 });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setMove(null);
      if (!moved || !lane.current) return;
      justMoved.current = true;
      setTimeout(() => (justMoved.current = false), 80);
      // dropped where the person wants: the item starts there (quarter hours), the others work around it
      const delta = Math.round((ev.clientY - y0) / (hourPx / 60) / 15) * 15;
      if (delta === 0) return;
      const first = Math.min(...placed.filter((x) => `${x.kind}:${x.refId}` === key).map((x) => toMinutes(x.start)));
      saveStart.mutate({ key, minute: Math.max(0, Math.min(1425, first + delta)) });
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const startDrag = (e: React.PointerEvent, i: number, key: string, own: number, edge: "top" | "bottom") => {
    e.preventDefault();
    e.stopPropagation();
    const y0 = e.clientY;
    const total = totals.get(key) ?? own;
    let delta = 0;
    const move = (ev: PointerEvent) => {
      const q = Math.round((ev.clientY - y0) / (hourPx / 60) / 15) * 15 * (edge === "top" ? -1 : 1);
      delta = Math.max(15 - total, Math.min(480 - total, q));
      setDrag({ i, edge, delta });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (delta !== 0) saveTime.mutate({ key, minutes: total + delta });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // the usual hours, widened to hold anything planned outside them (an evening, a weekend)
  const shown = data.plan.blocks.filter((b) => b.start && b.end && !b.overflow && !b.allDay);
  const lo = Math.min(toMinutes(data.workHours.start), ...shown.map((b) => toMinutes(b.start)));
  const hi = Math.max(toMinutes(data.workHours.end), ...shown.map((b) => toMinutes(b.end)));
  const startH = Math.max(0, Math.floor(lo / 60) - 1);
  const endH = Math.min(24, Math.ceil(hi / 60) + 1);
  const hours = Array.from({ length: endH - startH }, (_, i) => startH + i);
  const placed = data.plan.blocks.filter((b) => !b.overflow && !b.allDay && b.start);
  const overflow = data.plan.blocks.filter((b) => b.overflow);
  const top = (m: number) => ((m - startH * 60) / 60) * hourPx;
  const now = new Date();
  const nowM = data.date === todayYmd() ? now.getHours() * 60 + now.getMinutes() : null;
  return (
    <div className="space-y-3">
      <div className="relative" style={{ height: hours.length * hourPx }}>
        {hours.map((h) => (
          <div key={h} className="absolute inset-x-0 flex items-start border-t border-[color:var(--glass-border)]" style={{ top: (h - startH) * hourPx, height: hourPx }}>
            <span className="-mt-2 w-12 shrink-0 bg-transparent pr-2 text-right font-mono text-[10px] text-muted-foreground">{String(h).padStart(2, "0")}:00</span>
          </div>
        ))}
        {/* the quarter hours: a faint line each, with its time when there is room for it */}
        {hours.flatMap((h) =>
          [15, 30, 45].map((m) => (
            <div key={`${h}:${m}`} className="absolute inset-x-0 flex items-start border-t border-dashed border-[color:var(--glass-border)]/50" style={{ top: (h - startH) * hourPx + (m / 60) * hourPx }}>
              {hourPx / 4 >= 22 || (m === 30 && hourPx / 2 >= 22) ? <span className="-mt-1.5 w-12 shrink-0 pr-2 text-right font-mono text-[9px] text-muted-foreground/60">{String(h).padStart(2, "0")}:{m}</span> : null}
            </div>
          )),
        )}
        <div
          ref={lane}
          className="absolute inset-y-0 left-14 right-0"
          onClick={(e) => {
            // a click on free space blocks time there (from that quarter hour, an hour long)
            if (e.target !== e.currentTarget || !canEdit || justMoved.current) return;
            const m = Math.floor((startH * 60 + ((e.clientY - e.currentTarget.getBoundingClientRect().top) / hourPx) * 60) / 15) * 15;
            onBlock(undefined, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
          }}
        >
          {placed.map((b, i) => {
            const s = toMinutes(b.start);
            const e = toMinutes(b.end);
            const own = e - s;
            const key = `${b.kind}:${b.refId}`;
            const live = drag && drag.i === i ? drag : null;
            const h = Math.max(((own + (live?.delta ?? 0)) / 60) * hourPx - 3, 18);
            const shift = live?.edge === "top" ? -(live.delta / 60) * hourPx : 0;
            const stretch = canEdit && !b.done && !b.masked && (b.kind === "ticket" || b.kind === "task" || b.kind === "ptask");
            if (b.kind === "break")
              return (
                <div key={`br${i}`} className="absolute inset-x-0 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-muted-foreground/30 bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,rgba(255,255,255,0.03)_6px,rgba(255,255,255,0.03)_12px)] text-[11px] text-muted-foreground" style={{ top: top(s) + 1, height: h }}>
                  <Coffee className="size-3" /> {t("pipeline.day.lunch")}
                </div>
              );
            const task = b.kind === "task";
            const ptask = b.kind === "ptask";
            const event = b.kind === "event";
            return (
              <div key={`${b.refId}${i}`} className={cn("absolute inset-x-0", (live || move?.i === i) && "z-20")} style={{ top: top(s) + 1 + shift, height: h, ...(move?.i === i ? { transform: `translateY(${move.dy}px)`, opacity: 0.85, pointerEvents: "none" as const } : {}) }}>
              <button
                type="button"
                disabled={event && !b.local}
                onClick={() => (justMoved.current ? (justMoved.current = false) : b.local ? (canEdit ? onBlock(b) : undefined) : onOpen(b))}
                onPointerDown={stretch ? (ev) => startMove(ev, i, key) : undefined}
                className={cn(
                  "h-full w-full overflow-hidden rounded-lg border py-1 pr-2.5 text-left transition-all enabled:hover:brightness-110",
                  event ? "pl-2.5" : "pl-4",
                  stretch && "cursor-grab touch-none active:cursor-grabbing",
                  b.done && "opacity-40 saturate-50",
                  event
                    ? b.local
                      ? "border-pink-400/50 bg-pink-500/15 text-pink-100"
                      : b.o365
                        ? "border-sky-400/40 bg-sky-500/10 text-sky-100"
                        : "border-slate-400/30 bg-slate-500/10 text-slate-300"
                    : ptask
                      ? "border-teal-400/50 bg-teal-500/10"
                      : task
                      ? "border-violet-400/40 bg-violet-500/10"
                      : "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10",
                )}
                title={b.note ?? undefined}
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {b.start}–{b.end}
                    {live && live.delta !== 0 && <span className="ml-1 text-primary">{live.delta > 0 ? "+" : "−"}{hm(Math.abs(live.delta))}</span>}
                  </span>
                  {b.pinned && <Star className={cn("size-2.5 fill-current", b.pinned === "day" ? "text-primary" : "text-muted-foreground")} />}
                  {b.partial && <span className="rounded-full bg-orange-400/15 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-orange-300">{t("pipeline.day.share.partial")}</span>}
                  {ptask && <span className="rounded-full bg-teal-400/15 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-teal-300">{t("pipeline.day.share.project")}</span>}
                  {b.ticketNumber && <span className={cn("font-mono text-[10px]", ptask ? "text-teal-300" : "text-primary")}>{b.ticketNumber}</span>}
                  {b.o365 && <span className="flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300"><CalendarDays className="size-2.5" /> Outlook</span>}
                  {b.masked && <EyeOff className="size-3 text-muted-foreground" />}
                </span>
                <span className={cn("block truncate text-[13px] font-medium leading-tight", b.done && "line-through")}>{b.title || t("pipeline.private")}</span>
                {b.note && h > 50 && <span className="block truncate text-[11px] text-muted-foreground">{b.note}</span>}
              </button>
              {!event && !b.masked && !b.done && b.refId && (b.kind === "ticket" || b.kind === "task" || b.kind === "ptask") && (
                <DayEdge kind={b.kind} id={b.refId} number={b.ticketNumber} title={b.title} urgent={b.priority === "urgent"} onOpen={() => onOpen(b)} className="absolute left-0 top-0 z-10 h-full" />
              )}
              {stretch &&
                (["top", "bottom"] as const).map((edge) => (
                  <div key={edge} role="separator" aria-orientation="horizontal" title={t("pipeline.day.resizeBlock")} onPointerDown={(ev) => startDrag(ev, i, key, own, edge)} className={cn("group/h absolute inset-x-3 z-10 flex h-2 cursor-ns-resize touch-none items-center justify-center", edge === "top" ? "top-0" : "bottom-0")}>
                    <span className="h-0.5 w-8 rounded-full bg-transparent transition-colors group-hover/h:bg-[color:var(--gold)]/70" />
                  </div>
                ))}
              </div>
            );
          })}
          {nowM !== null && nowM >= startH * 60 && nowM <= endH * 60 && (
            <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: top(nowM) }}>
              <span className="size-2 -translate-x-1 rounded-full bg-red-400" />
              <span className="h-px flex-1 bg-red-400/70" />
            </div>
          )}
        </div>
      </div>
      {overflow.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-orange-400/30 bg-orange-400/[0.06] p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-orange-300">
            <AlertTriangle className="size-3.5" /> {t("pipeline.day.overflow")}
          </p>
          <ul className="space-y-1">
            {overflow.map((b, i) => (
              <li key={`${b.refId}${i}`}>
                <button type="button" onClick={() => onOpen(b)} className="flex w-full items-baseline gap-2 text-left text-sm hover:underline">
                  {b.ticketNumber && <span className="font-mono text-[11px] text-primary">{b.ticketNumber}</span>}
                  <span className="truncate">{b.title}</span>
                  {b.note && <span className="truncate text-xs text-muted-foreground">· {b.note}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
