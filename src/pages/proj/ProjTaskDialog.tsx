import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AiTextarea } from "@/components/AiPolish";
import { usePeople } from "@/pages/pipeline/TaskDialog";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { useDraft } from "@/lib/useDraft";
import { cn } from "@/lib/utils";
import { hm } from "@shared/duration";
import type { ProjDetail, ProjNote, ProjPriority, ProjTask, ProjTaskStatus, ProjTimeEntry } from "./shared";
import { PickEntryDialog } from "./PickEntryDialog";
import { projError } from "./ProjComposer";

type TaskTime = Pick<ProjTimeEntry, "id" | "userId" | "name" | "date" | "hours" | "note" | "billable" | "taskIds"> & { done: boolean };
type TaskDetail = { task: ProjTask; notes: ProjNote[]; time: TaskTime[] };

const PRIORITIES: ProjPriority[] = ["urgent", "high", "medium", "low"];
const STATUSES: ProjTaskStatus[] = ["todo", "doing", "done"];

/**
 * One task of a project, in its own window: title, description, priority, status, assignee and day, the notes that
 * tag it and the time that covered it, and a note box. Ticking it done asks which time entry it was done in.
 */
export function ProjTaskDialog({ project, taskId, onClose }: { project: ProjDetail; taskId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const people = usePeople();
  const lang = i18n.language === "en" ? "en-CA" : "fr-CA";
  const closed = project.status === "done" || project.status === "cancelled";
  const canEdit = can("proj.edit") && !closed;

  const detail = useQuery({
    queryKey: ["proj", "task", project.id, taskId],
    queryFn: () => api.get<TaskDetail>(`/proj/${project.id}/tasks/${taskId}`),
    staleTime: 10_000,
  });
  const task = detail.data?.task;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [picking, setPicking] = useState(false);
  const [noteText, setNoteText, clearNote] = useDraft(`proj:${project.id}:task:${taskId}`);

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description);
  }, [task?.id, task?.title, task?.description]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = useMutation({
    mutationFn: (fields: Record<string, unknown>) => api.patch<ProjTask>(`/proj/${project.id}/tasks/${taskId}`, fields),
    onSuccess: () => {
      toast.success(t("projWork.task.saved"));
      void qc.invalidateQueries({ queryKey: ["proj"] });
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const save = (fields: Record<string, unknown>) => {
    if (!canEdit || !task) return;
    patch.mutate(fields);
  };

  const addNote = useMutation({
    mutationFn: (text: string) => api.post(`/proj/${project.id}/notes`, { text, internal: true, taskIds: [taskId] }),
    onSuccess: () => {
      toast.success(t("projWork.task.noteSaved"));
      clearNote();
      void qc.invalidateQueries({ queryKey: ["proj"] });
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const changeStatus = (value: ProjTaskStatus) => {
    if (!task || value === task.status) return;
    // done: the time it took is asked first (the pick window also ends the task without time)
    if (value === "done") return setPicking(true);
    save({ status: value });
  };

  const labelPriority = (p: ProjPriority) => t(`projWork.priority.${p}`);
  const labelStatus = (s: ProjTaskStatus) => t(`projWork.status.${s}`);
  const field = "h-9 w-full rounded-md border bg-background/60 px-2 text-sm disabled:opacity-60";

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="sr-only">{t("projWork.task.title")}</DialogTitle>
            <DialogDescription className="text-xs">
              {project.number} · {project.name}
            </DialogDescription>
          </DialogHeader>

          {!task ? (
            <p className="text-sm text-muted-foreground">{detail.isError ? projError(t, detail.error) : t("projWork.loading")}</p>
          ) : (
            <div className="space-y-5">
              <div className="space-y-1">
                <label htmlFor={`pt-title-${task.id}`} className="text-xs font-medium text-muted-foreground">
                  {t("projWork.task.titleLabel")}
                </label>
                <input
                  id={`pt-title-${task.id}`}
                  value={title}
                  disabled={!canEdit}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => {
                    const v = title.trim();
                    if (v && v !== task.title) save({ title: v });
                    else setTitle(task.title);
                  }}
                  className={cn(field, "h-10 text-base font-semibold")}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t("projWork.task.status")}</span>
                  <select className={field} value={task.status} disabled={!canEdit} onChange={(e) => changeStatus(e.target.value as ProjTaskStatus)}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {labelStatus(s)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t("projWork.task.priority")}</span>
                  <select className={field} value={task.priority} disabled={!canEdit} onChange={(e) => save({ priority: e.target.value })}>
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {labelPriority(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t("projWork.task.assignee")}</span>
                  <select className={field} value={task.assignee?.id ?? ""} disabled={!canEdit} onChange={(e) => save({ assigneeId: e.target.value || null })}>
                    <option value="">{t("projWork.task.nobody")}</option>
                    {(people.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t("projWork.task.due")}</span>
                  <input type="date" className={field} value={task.dueDate ?? ""} disabled={!canEdit} onChange={(e) => save({ dueDate: e.target.value || null })} />
                </label>
              </div>

              <div className="space-y-1">
                <label htmlFor={`pt-desc-${task.id}`} className="text-xs font-medium text-muted-foreground">
                  {t("projWork.task.description")}
                </label>
                <AiTextarea
                  id={`pt-desc-${task.id}`}
                  rows={4}
                  maxLength={8000}
                  value={description}
                  disabled={!canEdit}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => {
                    if (description !== task.description) save({ description });
                  }}
                />
              </div>

              {canEdit && (
                <div className="space-y-2 rounded-xl border bg-background/40 p-3">
                  <p className="text-xs font-medium text-muted-foreground">{t("projWork.task.noteBox")}</p>
                  <AiTextarea rows={3} maxLength={8000} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder={t("projWork.task.notePlaceholder")} aria-label={t("projWork.task.noteBox")} />
                  <div className="flex justify-end">
                    <Button type="button" size="sm" disabled={!noteText.trim() || addNote.isPending} onClick={() => addNote.mutate(noteText.trim())} className="bg-violet-600 hover:bg-violet-500">
                      {t("projWork.task.sendNote")}
                    </Button>
                  </div>
                </div>
              )}

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t("projWork.task.notes")}</h3>
                {detail.data && detail.data.notes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("projWork.task.noNotes")}</p>
                ) : (
                  <ul className="space-y-2">
                    {detail.data?.notes.map((n) => (
                      <li key={n.id} className={cn("rounded-xl border p-3 text-sm", n.internal ? "border-violet-500/30 bg-violet-500/5" : "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/5")}>
                        <div className="mb-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                          <span>{n.author?.name ?? "—"}</span>
                          <time dateTime={n.createdAt}>{formatStamp(n.createdAt, lang)}</time>
                        </div>
                        <p className="whitespace-pre-wrap">{n.text}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t("projWork.task.time")}</h3>
                {detail.data && detail.data.time.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("projWork.task.noTime")}</p>
                ) : (
                  <ul className="divide-y rounded-xl border">
                    {detail.data?.time.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                        <span className="font-medium">{e.name}</span>
                        <span className="text-xs text-muted-foreground">{formatDay(e.date, lang)}</span>
                        <span className="font-mono text-violet-200">{hm(e.hours)}</span>
                        {e.done && <span className="rounded-full border border-emerald-400/40 px-1.5 py-px text-xs text-emerald-300">{t("projWork.task.done")}</span>}
                        {e.note && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{e.note}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {picking && task && <PickEntryDialog project={project} task={task} onClose={() => setPicking(false)} />}
    </>
  );
}

function formatStamp(iso: string, lang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

function formatDay(ymd: string, lang: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(d);
}
