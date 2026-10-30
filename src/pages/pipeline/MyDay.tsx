import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CalendarDays, Star, CalendarOff, CheckCircle2, EyeOff, ChevronLeft, ChevronRight, Coffee, Loader2, Lock, MessageSquareText, Plus, RefreshCw, Sparkles, Workflow } from "lucide-react";
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
import { PRIORITY_STYLE, addDays, dayLabel, hm, longDay, todayYmd, toMinutes, type Block, type DayData, type DayItem } from "./shared";
import { taskError, usePeople } from "./TaskDialog";
import { DayProjects, DayTickets } from "./DayLists";

/** The hours shown on the timeline: from an hour before the day starts to an hour after it ends */
const HOUR_PX = 60;

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
  const people = usePeople();
  const [date, setDate] = useState(todayYmd());
  const [userId, setUserId] = useState<string>(me.id);
  const [quick, setQuick] = useState("");
  const direction = useAiDirection(`pipeline.day:${date}:${userId}`);
  const key = ["pipeline", "day", date, userId];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get<DayData>(`/pipeline/day?date=${date}${userId !== me.id ? `&userId=${userId}` : ""}`),
    refetchInterval: 60_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["pipeline"] });
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
  const open = (i: DayItem) => (i.kind === "ticket" ? ws.open(Number(i.refId)) : onOpenTask(i.refId));
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
              {data.absent || data.holiday || plan.capacityMinutes === 0 ? (
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

      {/* left: what is on the plate (tickets as the Tickets page's compact view, my projects, tasks); right: the day, hour by hour */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
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
          <DayTickets items={tickets} loading={isLoading} onOpen={(id) => ws.open(id)} />
          {userId === me.id && can("projects.view") && <DayProjects />}
          <ItemList title={t("pipeline.day.tasksToday")} icon={Workflow} items={tasks} loading={isLoading} onOpen={open} onComplete={can("pipeline.edit") ? (i) => complete.mutate(i.refId) : undefined} empty={t("pipeline.day.noTasks")} />
        </div>

        {/* every ticket and task planned during the day */}
        <section className="glass h-fit rounded-2xl border p-4">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("pipeline.day.timeline")}</h3>
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
          {isLoading || !data ? <Skeleton className="h-96 w-full" /> : <Timeline data={data} onOpen={(b) => (b.kind === "ticket" ? ws.open(Number(b.refId)) : b.refId && onOpenTask(b.refId))} />}
          <p className="mt-3 text-[11px] text-muted-foreground">{t("pipeline.day.suggestion")}</p>
        </section>
      </div>
    </div>
  );
}

function ItemList({ title, icon: Icon, items, loading, onOpen, onComplete, empty }: { title: string; icon: typeof Workflow; items: DayItem[]; loading: boolean; onOpen: (i: DayItem) => void; onComplete?: (i: DayItem) => void; empty: string }) {
  const { t } = useTranslation();
  return (
    <section className="glass rounded-2xl border p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" /> {title} <span className="font-mono normal-case opacity-70">{items.length}</span>
      </h3>
      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : items.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-[color:var(--glass-border)]">
          {items.map((i) => (
            <li key={i.key} className="flex items-center gap-2.5 py-2">
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
          ))}
        </ul>
      )}
    </section>
  );
}

/** The day from the start of work to its end, an hour on each side; the blocks are placed by their time. */
function Timeline({ data, onOpen }: { data: DayData; onOpen: (b: Block) => void }) {
  const { t } = useTranslation();
  const startH = Math.max(0, Math.floor(toMinutes(data.workHours.start) / 60) - 1);
  const endH = Math.min(24, Math.ceil(toMinutes(data.workHours.end) / 60) + 1);
  const hours = Array.from({ length: endH - startH }, (_, i) => startH + i);
  const placed = data.plan.blocks.filter((b) => !b.overflow && !b.allDay && b.start);
  const overflow = data.plan.blocks.filter((b) => b.overflow);
  const top = (m: number) => ((m - startH * 60) / 60) * HOUR_PX;
  const now = new Date();
  const nowM = data.date === todayYmd() ? now.getHours() * 60 + now.getMinutes() : null;
  return (
    <div className="space-y-3">
      <div className="relative" style={{ height: hours.length * HOUR_PX }}>
        {hours.map((h) => (
          <div key={h} className="absolute inset-x-0 flex items-start border-t border-[color:var(--glass-border)]" style={{ top: (h - startH) * HOUR_PX, height: HOUR_PX }}>
            <span className="-mt-2 w-12 shrink-0 bg-transparent pr-2 text-right font-mono text-[10px] text-muted-foreground">{String(h).padStart(2, "0")}:00</span>
          </div>
        ))}
        <div className="absolute inset-y-0 left-14 right-0">
          {placed.map((b, i) => {
            const s = toMinutes(b.start);
            const e = toMinutes(b.end);
            const h = Math.max(((e - s) / 60) * HOUR_PX - 3, 22);
            if (b.kind === "break")
              return (
                <div key={`br${i}`} className="absolute inset-x-0 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-muted-foreground/30 bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,rgba(255,255,255,0.03)_6px,rgba(255,255,255,0.03)_12px)] text-[11px] text-muted-foreground" style={{ top: top(s) + 1, height: h }}>
                  <Coffee className="size-3" /> {t("pipeline.day.lunch")}
                </div>
              );
            const task = b.kind === "task";
            const event = b.kind === "event";
            return (
              <button
                key={`${b.refId}${i}`}
                type="button"
                disabled={event}
                onClick={() => onOpen(b)}
                className={cn(
                  "absolute inset-x-0 overflow-hidden rounded-lg border px-2.5 py-1 text-left transition-all enabled:hover:brightness-110",
                  event
                    ? b.o365
                      ? "border-sky-400/40 bg-sky-500/10 text-sky-100"
                      : "border-slate-400/30 bg-slate-500/10 text-slate-300"
                    : task
                      ? "border-violet-400/40 bg-violet-500/10"
                      : b.priority === "urgent"
                        ? "border-red-400/50 bg-red-500/10"
                        : "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10",
                )}
                style={{ top: top(s) + 1, height: h }}
                title={b.note ?? undefined}
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {b.start}–{b.end}
                  </span>
                  {b.pinned && <Star className={cn("size-2.5 fill-current", b.pinned === "day" ? "text-primary" : "text-muted-foreground")} />}
                  {b.ticketNumber && <span className="font-mono text-[10px] text-primary">{b.ticketNumber}</span>}
                  {b.o365 && <span className="flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300"><CalendarDays className="size-2.5" /> Outlook</span>}
                  {b.masked && <EyeOff className="size-3 text-muted-foreground" />}
                </span>
                <span className="block truncate text-[13px] font-medium leading-tight">{b.title || t("pipeline.private")}</span>
                {b.note && h > 50 && <span className="block truncate text-[11px] text-muted-foreground">{b.note}</span>}
              </button>
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
