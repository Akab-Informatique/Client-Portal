import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, CheckCircle2, CircleDashed, Clock3, ListChecks, Loader2, Lock, MessageSquare, Plus, Trash2, UserRound, Workflow, Ticket as TicketIcon, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { hm as hmHours, parseHm } from "@shared/duration";
import { PRIORITIES, PRIORITY_STYLE, STATUSES, STATUS_STYLE, dayLabel, hm, type Person, type TaskCard, type TaskFull, type TaskPriority } from "./shared";

const selectCls = "h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40";

export function usePeople() {
  return useQuery({ queryKey: ["pipeline", "people"], queryFn: () => api.get<Person[]>("/pipeline/people"), staleTime: 60_000 });
}
/** Every open task, for the parent / waiting-for pickers */
export function useOpenTasks() {
  return useQuery({ queryKey: ["pipeline", "tasks", "pick"], queryFn: () => api.get<TaskCard[]>("/pipeline/tasks?status=open"), staleTime: 15_000 });
}

export function taskError(t: (k: string, o?: Record<string, unknown>) => string, e: unknown): string {
  if (e instanceof ApiError && ["task_blocked", "task_open_children", "task_cycle", "invalid_assignee", "invalid_ticket", "forbidden"].includes(e.code)) return t(`pipeline.errors.${e.code}`);
  return t("common.error");
}

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

/**
 * A task, full screen over the page: its title, status, who has it, when it is due and how long it takes, the
 * instructions, the checklist, the subtasks, the task it waits for, the ticket it is about, and the comments.
 * Everything saves as it is changed. With no id it is the form of a new task.
 */
export function TaskDialog({ taskId, defaults, onClose, onOpenTask }: { taskId: string | null; defaults?: { assigneeId?: string | null; dueDate?: string | null; parentId?: string | null }; onClose: () => void; onOpenTask?: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const can = useCan();
  const confirm = useConfirm();
  const editable = can("pipeline.edit");
  const people = usePeople();
  const open = useOpenTasks();
  const { data: task, isLoading } = useQuery({ queryKey: ["pipeline", "task", taskId], queryFn: () => api.get<TaskFull>(`/pipeline/tasks/${taskId}`), enabled: Boolean(taskId) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["pipeline"] });
  };
  const patch = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.patch(`/pipeline/tasks/${taskId}`, p),
    onSuccess: refresh,
    onError: (e) => {
      toast.error(taskError(t, e));
      refresh();
    },
  });
  const sub = <T,>(fn: () => Promise<T>) =>
    fn().then(
      (r) => {
        refresh();
        return r;
      },
      (e) => {
        toast.error(taskError(t, e));
        return undefined;
      },
    );
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [estimate, setEstimate] = useState("");
  const [item, setItem] = useState("");
  const [subTitle, setSubTitle] = useState("");
  const [comment, setComment] = useState("");
  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setNotes(task.notes);
    setEstimate(task.estimateMinutes ? hmHours(task.estimateMinutes / 60) : "");
  }, [task?.id, task?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── a new task ──
  const [f, setF] = useState({ title: "", notes: "", assigneeId: defaults?.assigneeId ?? me.id, dueDate: defaults?.dueDate ?? "", priority: "normal" as TaskPriority, estimate: "", parentId: defaults?.parentId ?? "", checklist: "" });
  const create = useMutation({
    mutationFn: () => {
      const minutes = f.estimate.trim() ? Math.round((parseHm(f.estimate) ?? 0) * 60) : null;
      return api.post<TaskCard>("/pipeline/tasks", {
        title: f.title,
        notes: f.notes,
        priority: f.priority,
        assigneeId: f.assigneeId || null,
        dueDate: f.dueDate || null,
        parentId: f.parentId || null,
        estimateMinutes: minutes && minutes >= 5 ? minutes : null,
        checklist: f.checklist.split("\n").map((x) => x.trim()).filter(Boolean),
      });
    },
    onSuccess: (r) => {
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

  const body = (children: ReactNode) => (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(92vh,900px)] w-[min(96vw,1100px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogTitle className="sr-only">{t("pipeline.task")}</DialogTitle>
        <DialogDescription className="sr-only">{t("pipeline.taskHint")}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );

  if (!taskId) {
    return body(
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.title.trim() && !create.isPending) create.mutate();
        }}
      >
        <div className="flex items-center gap-2 border-b px-6 py-4">
          <Workflow className="size-5 text-primary" />
          <h2 className="text-lg font-semibold">{t("pipeline.newTask")}</h2>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <Input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={t("pipeline.titlePlaceholder")} className="h-12 text-lg font-medium" maxLength={200} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("pipeline.assignee")} icon={UserRound}>
              <select className={selectCls} value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
                <option value="">{t("pipeline.unassigned")}</option>
                {(people.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("pipeline.due")} icon={CalendarClock}>
              <Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
            </Field>
            <Field label={t("pipeline.priority.label")}>
              <select className={selectCls} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as TaskPriority })}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`pipeline.priority.${p}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("pipeline.estimate")} icon={Clock3}>
              <Input value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} placeholder="1:30" inputMode="text" />
            </Field>
          </div>
          <Field label={t("pipeline.parent")} icon={Link2}>
            <select className={selectCls} value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
              <option value="">{t("pipeline.noParent")}</option>
              {(open.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("pipeline.instructions")}>
            <Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={5} placeholder={t("pipeline.instructionsPlaceholder")} maxLength={8000} />
          </Field>
          <Field label={t("pipeline.checklist")} icon={ListChecks}>
            <Textarea value={f.checklist} onChange={(e) => setF({ ...f, checklist: e.target.value })} rows={4} placeholder={t("pipeline.checklistPlaceholder")} />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!f.title.trim() || create.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
            {create.isPending && <Loader2 className="size-4 animate-spin" />} {t("pipeline.create")}
          </Button>
        </div>
      </form>,
    );
  }

  if (isLoading || !task) {
    return body(
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>,
    );
  }

  const pct = task.checklist.total ? Math.round((task.checklist.done / task.checklist.total) * 100) : 0;
  const others = (open.data ?? []).filter((x) => x.id !== task.id);
  const canDelete = task.createdById === me.id || can("pipeline.manage");
  const saveText = () => {
    const next = title.trim();
    if (next && next !== task.title) patch.mutate({ title: next });
    else setTitle(task.title);
  };

  return body(
    <>
      {/* header: the title and the status */}
      <div className="space-y-3 border-b px-6 pb-4 pt-5">
        <div className="flex items-start gap-3">
          <Input
            value={title}
            disabled={!editable}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveText}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())}
            maxLength={200}
            className={cn("h-11 border-transparent bg-transparent px-1 text-xl font-semibold shadow-none focus-visible:border-input", task.status === "done" && "text-muted-foreground line-through")}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={!editable || patch.isPending}
              onClick={() => s !== task.status && patch.mutate({ status: s })}
              className={cn("flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-all", task.status === s ? STATUS_STYLE[s] : "border-transparent text-muted-foreground hover:bg-accent/50")}
            >
              {s === "done" ? <CheckCircle2 className="size-3.5" /> : s === "blocked" ? <Lock className="size-3.5" /> : <CircleDashed className="size-3.5" />}
              {t(`pipeline.status.${s}`)}
            </button>
          ))}
          {task.waiting && (
            <span className="ml-1 flex items-center gap-1 rounded-full border border-fuchsia-400/40 bg-fuchsia-400/10 px-2.5 py-1 text-xs text-fuchsia-300">
              <Lock className="size-3" /> {t("pipeline.waitingFor", { title: task.blockedByTitle ?? "" })}
            </span>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* the work: instructions, checklist, subtasks, comments */}
        <div className="min-h-0 space-y-6 overflow-y-auto px-6 py-5">
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("pipeline.instructions")}</h3>
            <Textarea
              value={notes}
              disabled={!editable}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => notes !== task.notes && patch.mutate({ notes })}
              rows={6}
              placeholder={t("pipeline.instructionsPlaceholder")}
              maxLength={8000}
              className="resize-y bg-background/40"
            />
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <ListChecks className="size-3.5" /> {t("pipeline.checklist")}
              </h3>
              {task.checklist.total > 0 && (
                <>
                  <span className="text-xs text-muted-foreground">
                    {task.checklist.done}/{task.checklist.total}
                  </span>
                  <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full bg-grad-gold transition-all" style={{ width: `${pct}%` }} />
                  </span>
                </>
              )}
            </div>
            <ul className="space-y-1">
              {task.checklistItems.map((c) => (
                <li key={c.id} className="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-accent/30">
                  <Checkbox checked={c.done} disabled={!editable} onCheckedChange={(v) => void sub(() => api.patch(`/pipeline/tasks/${task.id}/checklist/${c.id}`, { done: v === true }))} />
                  <span className={cn("min-w-0 flex-1 text-sm", c.done && "text-muted-foreground line-through")}>{c.text}</span>
                  {editable && (
                    <button type="button" className="opacity-0 transition-opacity group-hover:opacity-100" onClick={() => void sub(() => api.del(`/pipeline/tasks/${task.id}/checklist/${c.id}`))} aria-label={t("common.delete")}>
                      <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {editable && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!item.trim()) return;
                  void sub(() => api.post(`/pipeline/tasks/${task.id}/checklist`, { text: item.trim() })).then(() => setItem(""));
                }}
              >
                <Input value={item} onChange={(e) => setItem(e.target.value)} placeholder={t("pipeline.addItem")} className="h-9" maxLength={300} />
                <Button type="submit" variant="outline" size="icon" className="size-9 shrink-0" disabled={!item.trim()} aria-label={t("pipeline.addItem")}>
                  <Plus className="size-4" />
                </Button>
              </form>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Workflow className="size-3.5" /> {t("pipeline.subtasks")}
              {task.subtasks.total > 0 && (
                <span className="font-normal normal-case">
                  {task.subtasks.done}/{task.subtasks.total}
                </span>
              )}
            </h3>
            <ul className="space-y-1">
              {task.subtaskList.map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-accent/30">
                  <Checkbox
                    checked={s.status === "done"}
                    disabled={!editable}
                    onCheckedChange={(v) => void sub(() => api.patch(`/pipeline/tasks/${s.id}`, { status: v === true ? "done" : "todo" }))}
                  />
                  <button type="button" className={cn("min-w-0 flex-1 truncate text-left text-sm hover:underline", s.status === "done" && "text-muted-foreground line-through")} onClick={() => onOpenTask?.(s.id)}>
                    {s.title}
                  </button>
                  {s.assignee && <span className="text-xs text-muted-foreground">{s.assignee}</span>}
                </li>
              ))}
            </ul>
            {editable && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!subTitle.trim()) return;
                  void sub(() => api.post("/pipeline/tasks", { title: subTitle.trim(), parentId: task.id, assigneeId: task.assigneeId, dueDate: task.dueDate })).then(() => setSubTitle(""));
                }}
              >
                <Input value={subTitle} onChange={(e) => setSubTitle(e.target.value)} placeholder={t("pipeline.addSubtask")} className="h-9" maxLength={200} />
                <Button type="submit" variant="outline" size="icon" className="size-9 shrink-0" disabled={!subTitle.trim()} aria-label={t("pipeline.addSubtask")}>
                  <Plus className="size-4" />
                </Button>
              </form>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <MessageSquare className="size-3.5" /> {t("pipeline.comments")}
            </h3>
            <ul className="space-y-2">
              {task.comments.map((c) => (
                <li key={c.id} className="rounded-xl border bg-muted/30 px-3 py-2">
                  <p className="text-xs">
                    <span className="font-semibold">{c.author}</span> <span className="text-muted-foreground">{new Date(c.createdAt).toLocaleString()}</span>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{c.text}</p>
                </li>
              ))}
            </ul>
            {editable && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!comment.trim()) return;
                  void sub(() => api.post(`/pipeline/tasks/${task.id}/notes`, { text: comment.trim() })).then(() => setComment(""));
                }}
              >
                <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder={t("pipeline.commentPlaceholder")} maxLength={4000} />
                <Button type="submit" size="sm" variant="outline" disabled={!comment.trim()}>
                  {t("pipeline.addComment")}
                </Button>
              </form>
            )}
          </section>
        </div>

        {/* the properties */}
        <aside className="min-h-0 space-y-4 overflow-y-auto border-t bg-muted/20 px-5 py-5 lg:border-l lg:border-t-0">
          <Field label={t("pipeline.assignee")} icon={UserRound}>
            <select className={selectCls} disabled={!editable} value={task.assigneeId ?? ""} onChange={(e) => patch.mutate({ assigneeId: e.target.value || null })}>
              <option value="">{t("pipeline.unassigned")}</option>
              {(people.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("pipeline.priority.label")}>
            <div className="flex gap-1">
              {PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={!editable}
                  onClick={() => p !== task.priority && patch.mutate({ priority: p })}
                  className={cn("flex-1 rounded-md border px-1 py-1.5 text-[11px] font-medium transition-colors", task.priority === p ? PRIORITY_STYLE[p].chip : "border-transparent text-muted-foreground hover:bg-accent/50")}
                >
                  {t(`pipeline.priority.${p}`)}
                </button>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("pipeline.due")} icon={CalendarClock}>
              <Input type="date" disabled={!editable} value={task.dueDate ?? ""} onChange={(e) => patch.mutate({ dueDate: e.target.value || null })} />
            </Field>
            <Field label={t("pipeline.estimate")} icon={Clock3}>
              <Input
                disabled={!editable}
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                onBlur={() => {
                  if (!estimate.trim()) return task.estimateMinutes ? patch.mutate({ estimateMinutes: null }) : undefined;
                  const h = parseHm(estimate);
                  const m = h === null ? null : Math.round(h * 60);
                  if (m === null || m < 5) return setEstimate(task.estimateMinutes ? hmHours(task.estimateMinutes / 60) : "");
                  if (m !== task.estimateMinutes) patch.mutate({ estimateMinutes: m });
                }}
                placeholder="1:30"
              />
            </Field>
          </div>
          <Field label={t("pipeline.parent")} icon={Link2}>
            <select className={selectCls} disabled={!editable} value={task.parentId ?? ""} onChange={(e) => patch.mutate({ parentId: e.target.value || null })}>
              <option value="">{t("pipeline.noParent")}</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("pipeline.waitsFor")} icon={Lock}>
            <select className={selectCls} disabled={!editable} value={task.blockedById ?? ""} onChange={(e) => patch.mutate({ blockedById: e.target.value || null })}>
              <option value="">{t("pipeline.noWait")}</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <span className="block text-[11px] text-muted-foreground">{t("pipeline.waitsHint")}</span>
          </Field>
          {task.ticketNumber ? (
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
          <div className="space-y-0.5 border-t pt-3 text-[11px] text-muted-foreground">
            {task.createdBy && <p>{t("pipeline.createdBy", { name: task.createdBy })}</p>}
            {task.completedAt && <p>{t("pipeline.completedOn", { date: new Date(task.completedAt).toLocaleDateString() })}</p>}
            {task.dueDate && <p>{dayLabel(task.dueDate)}</p>}
            {task.estimateMinutes ? <p>{hm(task.estimateMinutes)}</p> : null}
          </div>
          {editable && canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground hover:text-destructive"
              onClick={() => void confirm({ title: t("pipeline.deleteTitle"), description: t("pipeline.deleteText"), confirmLabel: t("common.delete"), destructive: true }).then((ok) => ok && remove.mutate())}
            >
              <Trash2 className="size-4" /> {t("pipeline.delete")}
            </Button>
          )}
        </aside>
      </div>
    </>,
  );
}
