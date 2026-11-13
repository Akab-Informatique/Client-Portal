import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ConfirmDialog";
import { ApiError, api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { usePeople } from "@/pages/pipeline/TaskDialog";
import { PROJ_PRIORITY_ORDER, type PersonRef, type ProjDetail, type ProjPriority, type ProjTask, type ProjTaskStatus } from "./shared";

const KNOWN_ERRORS = ["dates", "contact_invalid", "quote_invalid", "quote_forbidden", "person_invalid", "project_closed", "not_found", "task_invalid", "forbidden", "timesheet_locked"];

/** A readable message for a failed call of the project API (the code is shown when it is not a known one) */
export function projError(t: (k: string, o?: Record<string, unknown>) => string, e: unknown): string {
  if (e instanceof ApiError && KNOWN_ERRORS.includes(e.code)) return t(`proj.errors.${e.code}`);
  if (e instanceof ApiError && e.code && e.code !== "error") return `${t("common.error")} (${e.code})`;
  return t("common.error");
}

const selectCls = "h-8 rounded-md border bg-transparent px-2 text-xs outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-60";

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** The task list of an opened project: checkbox (asks for the time entry), title, assignee, priority, status, date. */
export function ProjTasks({ project, onOpenTask, onAskDone }: { project: ProjDetail; onOpenTask: (taskId: string) => void; onAskDone: (task: ProjTask) => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const people = usePeople();
  const [draft, setDraft] = useState("");
  const readOnly = !can("proj.edit") || project.status === "done" || project.status === "cancelled";
  const base = `/proj/${project.id}/tasks`;

  const refresh = () => qc.invalidateQueries({ queryKey: ["proj"] });
  const onError = (e: unknown) => toast.error(projError(t, e));

  const patch = useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: Record<string, unknown> }) => api.patch<ProjTask>(`${base}/${taskId}`, body),
    onSuccess: refresh,
    onError,
  });
  const add = useMutation({
    mutationFn: (title: string) => api.post<ProjTask>(base, { title, priority: "medium" }),
    onSuccess: () => {
      setDraft("");
      void refresh();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (taskId: string) => api.del<{ deleted: boolean }>(`${base}/${taskId}`),
    onSuccess: refresh,
    onError,
  });

  const sorted = [...project.tasks].sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.position - b.position);
  const pct = project.taskTotal > 0 ? Math.round((project.taskDone / project.taskTotal) * 100) : 0;
  const personList: PersonRef[] = people.data ?? [];

  const askRemove = async (task: ProjTask) => {
    const ok = await confirm({ title: t("proj.tasks.deleteTitle"), description: t("proj.tasks.deleteText", { title: task.title }), confirmLabel: t("common.delete"), destructive: true });
    if (ok) remove.mutate(task.id);
  };

  return (
    <section aria-labelledby="proj-tasks-title" className="glass space-y-3 rounded-2xl border border-violet-500/25 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="proj-tasks-title" className="text-sm font-semibold uppercase tracking-wide text-violet-300">
          {t("proj.tasks.title")}
        </h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t("proj.tasks.progress", { done: project.taskDone, total: project.taskTotal })}</span>
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10" aria-hidden>
            <span className="block h-full rounded-full bg-violet-400" style={{ width: `${pct}%` }} />
          </span>
        </div>
      </header>

      {readOnly && <p className="text-xs text-muted-foreground">{t("proj.tasks.readOnly")}</p>}

      {sorted.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{t("proj.tasks.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((task) => {
            const done = task.status === "done";
            const knownAssignee = !task.assignee || personList.some((p) => p.id === task.assignee?.id);
            return (
              <li
                key={task.id}
                className={cn("grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 md:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto]", done && "opacity-60")}
              >
                <input
                  type="checkbox"
                  className="size-4 accent-violet-500"
                  checked={done}
                  disabled={readOnly}
                  aria-label={t("proj.tasks.toggle", { title: task.title })}
                  onChange={() => (done ? patch.mutate({ taskId: task.id, body: { status: "todo" } }) : onAskDone(task))}
                />
                <div className="min-w-0 space-y-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenTask(task.id)}
                      aria-label={`${t("proj.tasks.open")}: ${task.title}`}
                      className={cn("min-w-0 truncate text-left text-sm font-medium hover:text-violet-200 hover:underline", done && "line-through")}
                    >
                      {task.title}
                    </button>
                    <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      title={task.assignee?.name ?? t("proj.tasks.unassigned")}
                      className="grid size-5 shrink-0 place-items-center rounded-full bg-violet-500/20 text-[10px] font-semibold text-violet-200"
                    >
                      {initials(task.assignee?.name)}
                    </span>
                    <select
                      aria-label={t("proj.tasks.assignee")}
                      className={cn(selectCls, "max-w-[12rem]")}
                      value={task.assignee?.id ?? ""}
                      disabled={readOnly}
                      onChange={(e) => patch.mutate({ taskId: task.id, body: { assigneeId: e.target.value || null } })}
                    >
                      <option value="">{t("proj.tasks.unassigned")}</option>
                      {!knownAssignee && task.assignee && <option value={task.assignee.id}>{task.assignee.name}</option>}
                      {personList.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <select
                  aria-label={t("proj.tasks.col.priority")}
                  className={selectCls}
                  value={task.priority}
                  disabled={readOnly}
                  onChange={(e) => patch.mutate({ taskId: task.id, body: { priority: e.target.value as ProjPriority } })}
                >
                  {PROJ_PRIORITY_ORDER.map((p) => (
                    <option key={p} value={p}>
                      {t(`proj.priority.${p}`)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t("proj.tasks.col.status")}
                  className={selectCls}
                  value={task.status}
                  disabled={readOnly}
                  onChange={(e) => {
                    const v = e.target.value as ProjTaskStatus;
                    // reaching done always goes through the time entry question
                    if (v === "done") onAskDone(task);
                    else patch.mutate({ taskId: task.id, body: { status: v } });
                  }}
                >
                  {(["todo", "doing", "done"] as ProjTaskStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {t(`proj.taskStatus.${s}`)}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  aria-label={t("proj.tasks.col.date")}
                  className={cn(selectCls, "w-36")}
                  value={task.dueDate ?? ""}
                  disabled={readOnly}
                  onChange={(e) => patch.mutate({ taskId: task.id, body: { dueDate: e.target.value || null } })}
                />
                <button
                  type="button"
                  aria-label={t("proj.tasks.delete")}
                  title={t("proj.tasks.delete")}
                  disabled={readOnly || remove.isPending}
                  onClick={() => void askRemove(task)}
                  className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const title = draft.trim();
          if (!title || readOnly || add.isPending) return;
          add.mutate(title);
        }}
      >
        <Input
          value={draft}
          maxLength={300}
          disabled={readOnly}
          placeholder={t("proj.tasks.addPlaceholder")}
          aria-label={t("proj.tasks.add")}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" variant="outline" size="icon" disabled={readOnly || !draft.trim() || add.isPending} aria-label={t("proj.tasks.add")}>
          <Plus className="size-4" aria-hidden />
        </Button>
      </form>
    </section>
  );
}
