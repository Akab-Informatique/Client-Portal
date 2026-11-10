import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellRing, Check, CalendarClock, CalendarPlus, CheckCircle2, CircleDashed, Clock3, ListChecks, Loader2, Lock, MessageSquare, Paperclip, PlayCircle, Repeat, Tag, Trash2, UserRound, Workflow, Ticket as TicketIcon, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddToDayDialog } from "@/pages/tickets/AddToDayDialog";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { hm as hmHours, parseHm } from "@shared/duration";
import { PRIORITIES, PRIORITY_STYLE, STATUSES, STATUS_STYLE, dayLabel, fileToBase64, hm, todayYmd, type Person, type Recurrence, type TaskCard, type TaskFull, type TaskKind, type TaskPriority, type Visibility } from "./shared";
import { FilesBox, RecurrenceEditor, TagsEditor, VisibilityEditor } from "./TaskParts";
import { newStep, TaskSteps, type Step } from "./TaskSteps";
import { TaskNotify } from "./TaskNotify";
import { PickEntryDialog, TaskActivity } from "./TaskActivity";

const selectCls = "h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40";
const KNOWN_ERRORS = ["task_blocked", "task_open_children", "task_cycle", "invalid_assignee", "invalid_ticket", "forbidden", "checklist_open", "item_blocked", "item_not_started", "item_cycle", "item_has_done_dependents", "item_invalid", "no_recipient"];

export function usePeople() {
  return useQuery({ queryKey: ["pipeline", "people"], queryFn: () => api.get<Person[]>("/pipeline/people"), staleTime: 60_000 });
}
/** Every open task, for the "waits for" picker */
export function useOpenTasks() {
  return useQuery({ queryKey: ["pipeline", "tasks", "pick"], queryFn: () => api.get<TaskCard[]>("/pipeline/tasks?status=open"), staleTime: 15_000 });
}

export function taskError(t: (k: string, o?: Record<string, unknown>) => string, e: unknown): string {
  if (e instanceof ApiError && KNOWN_ERRORS.includes(e.code)) return t(`pipeline.errors.${e.code}`);
  // keep the reason visible: a bare "something went wrong" says nothing about a server that is not up to date
  if (e instanceof ApiError && e.code && e.code !== "error") return `${t("common.error")} (${e.code})`;
  return t("common.error");
}

type Schedule = "simple" | "recurring" | "continuous" | "daily";
const scheduleOf = (kind: TaskKind, recurrence: Recurrence | null): Schedule => (kind === "continuous" ? "continuous" : kind === "daily" ? "daily" : recurrence ? "recurring" : "simple");

/** The values that are the same whether the task is new (kept in the form) or open (saved as changed) */
type Values = {
  kind: TaskKind;
  recurrence: Recurrence | null;
  remindEveryDays: number | null;
  dueDate: string | null;
  startDate: string | null;
  checkpointDate: string | null;
  checkpointTime: string | null;
  estimateMinutes: number | null;
  tags: string[];
  visibility: Visibility;
  viewerIds: string[];
  assigneeId: string | null;
  /** The people it is assigned to (one or several, the first the main one) */
  assigneeIds: string[];
  priority: TaskPriority;
};

function Field({ label, icon: Icon, children }: { label: string; icon?: typeof Clock3; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="size-3" />} {label}
      </span>
      {children}
    </label>
  );
}

function Heading({ icon: Icon, children, extra }: { icon: typeof Clock3; children: ReactNode; extra?: ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon className="size-3.5" /> {children} {extra}
    </h3>
  );
}

/**
 * A task, nearly full screen. Left: the description, the steps (the checklist — the only subtasks, folded rows
 * inside this one window), the files and the team's notes. Right: how it is planned (simple, recurring or
 * continuous), who has it, who sees it. Open, everything saves as it is changed; with no id it is the form of a new task.
 */
export function TaskDialog({ taskId, defaults, onClose, onOpenTask }: { taskId: string | null; defaults?: { assigneeId?: string | null; dueDate?: string | null; parentId?: string | null }; onClose: () => void; onOpenTask?: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const can = useCan();
  const confirm = useConfirm();
  const isNew = !taskId;
  const editable = can("pipeline.edit");
  const people = usePeople();
  const open = useOpenTasks();
  const [addingDay, setAddingDay] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const { data: task, isLoading } = useQuery({ queryKey: ["pipeline", "task", taskId], queryFn: () => api.get<TaskFull>(`/pipeline/tasks/${taskId}`), enabled: Boolean(taskId) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["pipeline"] });
  const patch = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.patch(`/pipeline/tasks/${taskId}`, p),
    onSuccess: refresh,
    onError: (e) => {
      toast.error(taskError(t, e));
      refresh();
    },
  });
  /** A change on the open task, done at once; an error is shown and the screen reloaded */
  const sub = <T,>(fn: () => Promise<T>) =>
    fn().then(
      (r) => {
        refresh();
        return r;
      },
      (e) => {
        toast.error(taskError(t, e));
        refresh();
        return undefined;
      },
    );

  // ── what is typed ──
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [estimate, setEstimate] = useState("");
  const [pickItem, setPickItem] = useState<string | null>(null);
  const [timeTabKey, setTimeTabKey] = useState(0);
  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setNotes(task.notes);
    setEstimate(task.estimateMinutes ? hmHours(task.estimateMinutes / 60) : "");
  }, [task?.id, task?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── a new task: its values and steps stay here until "Create" ──
  const [f, setF] = useState<Values & { waitsOn: string }>({ kind: "normal", recurrence: null, remindEveryDays: null, dueDate: defaults?.dueDate ?? null, startDate: null, checkpointDate: null, checkpointTime: null, estimateMinutes: null, tags: [], visibility: "team", viewerIds: [], assigneeId: defaults?.assigneeId ?? me.id, assigneeIds: defaults?.assigneeId === null ? [] : [defaults?.assigneeId ?? me.id], priority: "normal", waitsOn: "" });
  const [newSteps, setNewSteps] = useState<Step[]>([]);
  const [staged, setStaged] = useState<File[]>([]);
  const [counter, setCounter] = useState(0);

  const v: Values = task
    ? { kind: task.kind, recurrence: task.recurrence, remindEveryDays: task.remindEveryDays, dueDate: task.dueDate, startDate: task.startDate, checkpointDate: task.checkpointDate, checkpointTime: task.checkpointTime, estimateMinutes: task.estimateMinutes, tags: task.tags, visibility: task.visibility, viewerIds: task.viewerIds, assigneeId: task.assigneeId, assigneeIds: task.assignees.map((x) => x.id), priority: task.priority }
    : f;
  const set = (p: Partial<Values>) => (isNew ? setF((old) => ({ ...old, ...p })) : patch.mutate(p));
  const schedule = scheduleOf(v.kind, v.recurrence);
  const setSchedule = (s: Schedule) => {
    if (s === schedule) return;
    if (s === "simple") set({ kind: "normal", recurrence: null });
    else if (s === "recurring") set({ kind: "normal", recurrence: v.recurrence ?? { freq: "weekly", interval: 1, weekdays: [], until: null }, dueDate: v.dueDate ?? todayYmd() });
    else set({ kind: "continuous", recurrence: null, dueDate: null, estimateMinutes: null });
    if (s === "continuous") setEstimate("");
  };
  const commitEstimate = () => {
    if (!estimate.trim()) return v.estimateMinutes ? set({ estimateMinutes: null }) : undefined;
    const h = parseHm(estimate);
    const m = h === null ? null : Math.round(h * 60);
    if (m === null || m < 5) return setEstimate(v.estimateMinutes ? hmHours(v.estimateMinutes / 60) : "");
    if (m !== v.estimateMinutes) set({ estimateMinutes: m });
  };

  const steps: Step[] = useMemo(
    () => (task ? task.checklistItems.map((c) => ({ id: c.id, text: c.text, done: c.done, priority: c.priority, assigneeId: c.assigneeId, startDate: c.startDate, dueDate: c.dueDate, dueTime: c.dueTime, dependsOnId: c.dependsOnId })) : newSteps),
    [task, newSteps],
  );
  const stepHandlers = {
    onAdd: (text: string) => {
      if (task) void sub(() => api.post(`/pipeline/tasks/${task.id}/checklist`, { text }));
      else {
        setNewSteps((l) => [...l, newStep(`n${counter}`, text)]);
        setCounter((n) => n + 1);
      }
    },
    onChange: (id: string, p: Partial<Step>) => {
      // a step ticked by hand: ask in which time entry it was done
      if (task) void sub(() => api.patch(`/pipeline/tasks/${task.id}/checklist/${id}`, p)).then((r) => r && p.done === true && setPickItem(id));
      else setNewSteps((l) => l.map((s) => (s.id === id ? { ...s, ...p } : s)));
    },
    onRemove: (id: string) => {
      if (task) void sub(() => api.del(`/pipeline/tasks/${task.id}/checklist/${id}`));
      else setNewSteps((l) => l.filter((s) => s.id !== id).map((s) => (s.dependsOnId === id ? { ...s, dependsOnId: null } : s)));
    },
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<TaskCard>("/pipeline/tasks", {
        title,
        notes,
        priority: f.priority,
        assigneeIds: f.assigneeIds,
        dueDate: f.kind !== "normal" ? null : f.dueDate,
        kind: f.kind,
        remindEveryDays: f.kind === "continuous" ? f.remindEveryDays : null,
        startDate: f.startDate,
        checkpointDate: f.checkpointDate,
        checkpointTime: f.checkpointDate ? f.checkpointTime : null,
        tags: f.tags,
        recurrence: f.kind === "normal" ? f.recurrence : null,
        visibility: f.visibility,
        viewerIds: f.viewerIds,
        parentId: defaults?.parentId ?? null,
        blockedById: f.waitsOn || null,
        estimateMinutes: f.kind === "continuous" ? null : v.estimateMinutes,
        checklist: newSteps
          .filter((s) => s.text.trim())
          .map((s) => ({ text: s.text.trim(), priority: s.priority, dueDate: s.dueDate, dueTime: s.dueDate ? s.dueTime : null, assigneeId: s.assigneeId, startDate: s.startDate, dependsOn: s.dependsOnId ? newSteps.filter((x) => x.text.trim()).findIndex((x) => x.id === s.dependsOnId) : null })),
      }),
    onSuccess: async (r) => {
      for (const x of staged) {
        try {
          await api.post(`/pipeline/tasks/${r.id}/files`, { name: x.name, contentType: x.type || "application/octet-stream", data: await fileToBase64(x) });
        } catch {
          toast.error(t("pipeline.files.failed", { name: x.name }));
        }
      }
      refresh();
      toast.success(t("pipeline.created"));
      if (onOpenTask) onOpenTask(r.id);
      else onClose();
    },
    onError: (e) => toast.error(taskError(t, e)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/pipeline/tasks/${taskId}`),
    onSuccess: () => {
      refresh();
      toast.success(t("pipeline.deleted"));
      onClose();
    },
    onError: (e) => toast.error(taskError(t, e)),
  });

  const shell = (children: ReactNode) => (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(97vh,1200px)] w-[min(99vw,1760px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogTitle className="sr-only">{t("pipeline.task")}</DialogTitle>
        <DialogDescription className="sr-only">{t("pipeline.taskHint")}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );

  if (!isNew && (isLoading || !task)) {
    return shell(
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>,
    );
  }

  const others = (open.data ?? []).filter((x) => x.id !== task?.id);
  const canDelete = task ? task.createdById === me.id || can("pipeline.manage") : false;
  const locked = !editable;
  const total = steps.length;
  const doneCount = steps.filter((s) => s.done).length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  const openSteps = total - doneCount;
  const saveTitle = () => {
    const next = title.trim();
    if (!task) return;
    if (next && next !== task.title) patch.mutate({ title: next });
    else setTitle(task.title);
  };

  const SCHEDULES: Schedule[] = schedule === "daily" ? ["simple", "recurring", "continuous", "daily"] : ["simple", "recurring", "continuous"];

  const left = (
    <div className="min-h-0 space-y-7 overflow-y-auto px-7 py-6">
      <section className="space-y-1.5">
        <Heading icon={Workflow}>{t("pipeline.description")}</Heading>
        <Textarea
          value={notes}
          disabled={locked}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => task && notes !== task.notes && patch.mutate({ notes })}
          rows={5}
          placeholder={t("pipeline.instructionsPlaceholder")}
          maxLength={8000}
          className="resize-y bg-background/40"
        />
      </section>

      <section className="space-y-2">
        <Heading
          icon={ListChecks}
          extra={
            total > 0 ? (
              <>
                <span className="font-normal normal-case">{t("pipeline.steps.progress", { done: doneCount, total })}</span>
                <span className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-grad-gold transition-all" style={{ width: `${pct}%` }} />
                </span>
              </>
            ) : null
          }
        >
          {t("pipeline.steps.title")}
        </Heading>
        <p className="text-xs text-muted-foreground">{t("pipeline.steps.hint")}</p>
        <TaskSteps steps={steps} people={people.data ?? []} disabled={locked} creating={isNew} {...stepHandlers} />
      </section>

      <section className="space-y-2">
        <Heading icon={Paperclip} extra={task && task.fileList.length > 0 ? <span className="font-normal normal-case">{task.fileList.length}</span> : null}>
          {t("pipeline.files.title")}
        </Heading>
        {task ? (
          <FilesBox
            stored={task.fileList}
            disabled={locked}
            downloadUrl={(id) => `/api/pipeline/tasks/${task.id}/files/${id}`}
            onRemove={(id) => void sub(() => api.del(`/pipeline/tasks/${task.id}/files/${id}`))}
            onAdd={(x) =>
              void sub(async () => {
                await api.post(`/pipeline/tasks/${task.id}/files`, { name: x.name, contentType: x.type || "application/octet-stream", data: await fileToBase64(x) });
              })
            }
          />
        ) : (
          <FilesBox staged={staged} onAdd={(x) => setStaged((old) => (old.some((o) => o.name === x.name && o.size === x.size) ? old : [...old, x]))} onRemoveStaged={(x) => setStaged((old) => old.filter((o) => o !== x))} />
        )}
      </section>

      {task && (
        <section className="space-y-2">
          <Heading icon={MessageSquare}>{t("pipeline.activity.title")}</Heading>
          <TaskActivity key={timeTabKey} startOnTime={timeTabKey > 0} task={task} editable={editable} onChanged={refresh} />
        </section>
      )}
      {task && pickItem && <PickEntryDialog task={task} itemId={pickItem} onClose={() => setPickItem(null)} onChanged={refresh} onAddTime={() => setTimeTabKey((k) => k + 1)} />}
    </div>
  );

  const aside = (
    <aside className="min-h-0 space-y-5 overflow-y-auto border-t bg-muted/20 px-5 py-6 lg:border-l lg:border-t-0">
      {/* how it is planned */}
      <div className="space-y-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("pipeline.schedule.title")}</span>
        <div className={cn("grid gap-1.5", SCHEDULES.length === 4 ? "grid-cols-2" : "grid-cols-1")} role="radiogroup" aria-label={t("pipeline.schedule.title")}>
          {SCHEDULES.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={schedule === k}
              disabled={locked || (k === "daily" && schedule !== "daily")}
              onClick={() => setSchedule(k)}
              className={cn("rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60", schedule === k ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10" : "bg-muted/30 hover:bg-accent/40")}
            >
              <span className="block text-sm font-medium">{t(`pipeline.schedule.${k}`)}</span>
              <span className="block text-[11px] leading-snug text-muted-foreground">{t(`pipeline.schedule.${k}Hint`)}</span>
            </button>
          ))}
        </div>
        {schedule === "recurring" && <RecurrenceEditor value={v.recurrence} disabled={locked} onChange={(recurrence) => recurrence && set({ recurrence })} />}
        {schedule === "continuous" && (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("pipeline.remind")} icon={Repeat}>
              <select className={selectCls} disabled={locked} value={v.remindEveryDays ?? ""} onChange={(e) => set({ remindEveryDays: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t("pipeline.remindNone")}</option>
                {[1, 2, 5, 10].map((n) => (
                  <option key={n} value={n}>
                    {t("pipeline.remindEvery", { count: n })}
                  </option>
                ))}
              </select>
            </Field>
            {task && v.remindEveryDays && editable && (
              <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => void sub(() => api.post(`/pipeline/tasks/${task.id}/check`, {}))}>
                <CheckCircle2 className="size-4" /> {t("pipeline.checkNow")}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("pipeline.startDate")} icon={PlayCircle}>
          <Input type="date" disabled={locked} value={v.startDate ?? ""} onChange={(e) => set({ startDate: e.target.value || null })} />
        </Field>
        {schedule !== "continuous" && schedule !== "daily" && (
          <Field label={schedule === "recurring" ? t("pipeline.firstDue") : t("pipeline.due")} icon={CalendarClock}>
            <Input type="date" disabled={locked} value={v.dueDate ?? ""} onChange={(e) => set({ dueDate: e.target.value || null })} />
          </Field>
        )}
        <Field label={t("pipeline.checkpoint")} icon={CalendarClock}>
          <Input type="date" disabled={locked} value={v.checkpointDate ?? ""} onChange={(e) => set({ checkpointDate: e.target.value || null })} />
        </Field>
        <Field label={t("pipeline.checkpointTime")}>
          <Input type="time" disabled={locked || !v.checkpointDate} value={v.checkpointTime ?? ""} onChange={(e) => set({ checkpointTime: e.target.value || null })} />
        </Field>
        {schedule !== "continuous" && (
          <Field label={t("pipeline.estimate")} icon={Clock3}>
            <Input disabled={locked} value={estimate} onChange={(e) => setEstimate(e.target.value)} onBlur={commitEstimate} placeholder="1:30" inputMode="text" />
          </Field>
        )}
      </div>

      {/* who */}
      <Field label={t("pipeline.assignee")} icon={UserRound}>
        <PeoplePick value={v.assigneeIds} people={people.data ?? []} disabled={locked} onChange={(assigneeIds) => set({ assigneeIds })} />
      </Field>
      <div className="space-y-1">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Eye className="size-3" /> {t("pipeline.whoSees")}
        </span>
        <VisibilityEditor
          value={v.visibility}
          viewerIds={v.viewerIds}
          people={people.data ?? []}
          meId={me.id}
          disabled={locked || Boolean(task && task.createdById !== me.id && !task.assignees.some((x) => x.id === me.id))}
          onChange={(visibility, viewerIds) => set({ visibility, viewerIds })}
        />
      </div>

      <Field label={t("pipeline.priority.label")}>
        <div className="flex gap-1">
          {PRIORITIES.map((p) => (
            <button key={p} type="button" disabled={locked} onClick={() => p !== v.priority && set({ priority: p })} className={cn("flex-1 rounded-md border px-1 py-1.5 text-[11px] font-medium transition-colors", v.priority === p ? PRIORITY_STYLE[p].chip : "border-transparent text-muted-foreground hover:bg-accent/50")}>
              {t(`pipeline.priority.${p}`)}
            </button>
          ))}
        </div>
      </Field>

      <div className="space-y-1">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Tag className="size-3" /> {t("pipeline.tags")}
        </span>
        <TagsEditor value={v.tags} disabled={locked} onChange={(tags) => set({ tags })} />
      </div>

      <Field label={t("pipeline.waitsFor")} icon={Lock}>
        <select className={selectCls} disabled={locked} value={task ? (task.blockedById ?? "") : f.waitsOn} onChange={(e) => (task ? patch.mutate({ blockedById: e.target.value || null }) : setF((old) => ({ ...old, waitsOn: e.target.value })))}>
          <option value="">{t("pipeline.noWait")}</option>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <span className="block text-[11px] text-muted-foreground">{t("pipeline.waitsHint")}</span>
      </Field>

      {task?.ticketNumber ? (
        <div className="rounded-xl border bg-background/40 p-3 text-sm">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <TicketIcon className="size-3" /> {t("pipeline.ticket")}
          </p>
          <p className="mt-1 font-mono text-xs text-primary">{task.ticketNumber}</p>
          <p className="truncate text-xs text-muted-foreground">{task.ticketTitle}</p>
          {editable && (
            <button type="button" className="mt-1 text-xs text-muted-foreground hover:text-destructive" onClick={() => patch.mutate({ ticketId: null })}>
              {t("pipeline.unlink")}
            </button>
          )}
        </div>
      ) : null}

      {task && (
        <div className="space-y-0.5 border-t pt-3 text-[11px] text-muted-foreground">
          {task.createdBy && <p>{t("pipeline.createdBy", { name: task.createdBy })}</p>}
          {task.completedAt && <p>{t("pipeline.completedOn", { date: new Date(task.completedAt).toLocaleDateString() })}</p>}
          {task.dueDate && <p>{dayLabel(task.dueDate)}</p>}
          {task.estimateMinutes ? <p>{hm(task.estimateMinutes)}</p> : null}
        </div>
      )}
    </aside>
  );

  // ── a new task ──
  if (isNew) {
    return shell(
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() && !create.isPending) create.mutate();
        }}
      >
        <div className="flex items-center gap-2 border-b px-7 pb-4 pt-5">
          <Workflow className="size-5 shrink-0 text-primary" />
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("pipeline.titlePlaceholder")} className="h-12 flex-1 text-lg font-medium" maxLength={200} />
        </div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_400px]">
          {left}
          {aside}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-7 py-3">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!title.trim() || create.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
            {create.isPending && <Loader2 className="size-4 animate-spin" />} {t("pipeline.create")}
          </Button>
        </div>
      </form>,
    );
  }

  // ── an open task ──
  const t0 = task!;
  return shell(
    <>
      <div className="space-y-3 border-b px-7 pb-4 pt-5">
        <div className="flex items-start gap-3 pr-8">
          <Input
            value={title}
            disabled={locked}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())}
            maxLength={200}
            className={cn("h-11 border-transparent bg-transparent px-1 text-xl font-semibold shadow-none focus-visible:border-input", t0.status === "done" && "text-muted-foreground line-through")}
          />
          <div className="flex shrink-0 items-center gap-1">
            {editable && (
              <Button variant="outline" size="sm" className="h-9" onClick={() => setNotifying(true)}>
                <BellRing className="size-4" /> {t("pipeline.notify")}
              </Button>
            )}
            {can("pipeline.edit") && t0.status !== "done" && (
              <Button variant="outline" size="sm" className="h-9" onClick={() => setAddingDay(true)}>
                <CalendarPlus className="size-4" /> {t("tickets.addDay.title")}
              </Button>
            )}
            {editable && canDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="size-9 text-muted-foreground hover:text-destructive"
                aria-label={t("pipeline.delete")}
                title={t("pipeline.delete")}
                onClick={() => void confirm({ title: t("pipeline.deleteTitle"), description: t("pipeline.deleteText"), confirmLabel: t("common.delete"), destructive: true }).then((ok) => ok && remove.mutate())}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {STATUSES.map((s) => {
              const blockedDone = s === "done" && openSteps > 0 && t0.status !== "done";
              return (
                <button
                  key={s}
                  type="button"
                  disabled={locked || patch.isPending || blockedDone}
                  title={blockedDone ? t("pipeline.errors.checklist_open") : undefined}
                  onClick={() => s !== t0.status && patch.mutate({ status: s })}
                  className={cn("flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50", t0.status === s ? STATUS_STYLE[s] : "border-transparent text-muted-foreground hover:bg-accent/50")}
                >
                  {s === "done" ? <CheckCircle2 className="size-3.5" /> : s === "blocked" ? <Lock className="size-3.5" /> : <CircleDashed className="size-3.5" />}
                  {t(`pipeline.status.${s}`)}
                </button>
              );
            })}
            {t0.waiting && (
              <span className="ml-1 flex items-center gap-1 rounded-full border border-fuchsia-400/40 bg-fuchsia-400/10 px-2.5 py-1 text-xs text-fuchsia-300">
                <Lock className="size-3" /> {t("pipeline.waitingFor", { title: t0.blockedByTitle ?? "" })}
              </span>
            )}
          </div>
          {total > 0 && (
            <div className="flex min-w-56 items-center gap-2 text-xs text-muted-foreground">
              <span className="h-2 w-40 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-grad-gold transition-all" style={{ width: `${pct}%` }} />
              </span>
              <span className="font-mono">{pct}%</span>
              <span>{t("pipeline.steps.progress", { done: doneCount, total })}</span>
            </div>
          )}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_400px]">
        {left}
        {aside}
      </div>
      {addingDay && <AddToDayDialog open onOpenChange={(o) => !o && setAddingDay(false)} tk={{ id: t0.id, title: t0.title }} kind="task" />}
      {notifying && <TaskNotify task={{ id: t0.id, title: t0.title }} people={people.data ?? []} onClose={() => setNotifying(false)} />}
    </>,
  );
}

/** One or several people for a task: a list with a tick for each; the first one ticked is the main one */
function PeoplePick({ value, people, disabled, onChange }: { value: string[]; people: { id: string; name: string }[]; disabled: boolean; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const names = value.map((id) => people.find((p) => p.id === id)?.name ?? "—");
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" disabled={disabled} className="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border bg-transparent px-2 py-1 text-left text-sm disabled:opacity-60">
          {names.length === 0 ? (
            <span className="text-muted-foreground">{t("pipeline.unassigned")}</span>
          ) : (
            names.map((n, i) => (
              <span key={value[i]} className={cn("rounded-full border px-2 py-0.5 text-xs", i === 0 ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-primary" : "text-muted-foreground")}>
                {n}
              </span>
            ))
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        <ul className="max-h-64 overflow-y-auto">
          {people.map((p) => {
            const on = value.includes(p.id);
            return (
              <li key={p.id}>
                <button type="button" onClick={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
                  <span className={cn("flex size-4 items-center justify-center rounded border", on ? "border-[color:var(--gold)] bg-[color:var(--gold)]/30" : "border-muted-foreground/40")}>{on && <Check className="size-3" />}</span>
                  {p.name}
                </button>
              </li>
            );
          })}
        </ul>
        {value.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent">
            {t("pipeline.unassigned")}
          </button>
        )}
        <p className="px-2 pb-1 pt-1.5 text-[10px] text-muted-foreground">{t("pipeline.manyHint")}</p>
      </PopoverContent>
    </Popover>
  );
}
