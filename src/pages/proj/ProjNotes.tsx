import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { hm } from "@shared/duration";
import type { ProjDetail, ProjNote, ProjTimeEntry } from "./shared";
import { projError } from "./ProjComposer";

type Filter = "all" | "replies" | "internal" | "time";
type Item = { key: string; at: number } & ({ kind: "note"; note: ProjNote } | { kind: "time"; entry: ProjTimeEntry });

/**
 * The project's conversation, newest first: public replies (gold, right), internal notes (violet), and the time
 * entries of the project (blue). Tags on a note open its task.
 */
export function ProjNotes({ project, onOpenTask }: { project: ProjDetail; onOpenTask: (taskId: string) => void }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const can = useCan();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const lang = i18n.language === "en" ? "en-CA" : "fr-CA";

  const time = useQuery({
    queryKey: ["proj", "time", project.id],
    queryFn: () => api.get<ProjTimeEntry[]>(`/proj/${project.id}/time`),
    staleTime: 15_000,
  });

  const titles = useMemo(() => new Map(project.tasks.map((k) => [k.id, k.title])), [project.tasks]);

  const items = useMemo(() => {
    const list: Item[] = [];
    if (filter !== "time") {
      for (const note of project.notes) {
        if (filter === "replies" && note.internal) continue;
        if (filter === "internal" && !note.internal) continue;
        list.push({ kind: "note", key: `n:${note.id}`, at: Date.parse(note.createdAt) || 0, note });
      }
    }
    if (filter === "all" || filter === "time") {
      for (const entry of time.data ?? []) list.push({ kind: "time", key: `t:${entry.id}`, at: Date.parse(`${entry.date}T12:00:00`) || 0, entry });
    }
    return list.sort((a, b) => b.at - a.at);
  }, [filter, project.notes, time.data]);

  const remove = useMutation({
    mutationFn: (noteId: string) => api.del(`/proj/${project.id}/notes/${noteId}`),
    onSuccess: () => {
      toast.success(t("projWork.notes.deleted"));
      void qc.invalidateQueries({ queryKey: ["proj"] });
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const askRemove = async (noteId: string) => {
    const ok = await confirm({ title: t("projWork.notes.deleteTitle"), description: t("projWork.notes.deleteText"), confirmLabel: t("projWork.delete"), destructive: true });
    if (ok) remove.mutate(noteId);
  };

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: t("projWork.notes.all") },
    { key: "replies", label: t("projWork.notes.replies") },
    { key: "internal", label: t("projWork.notes.internal") },
    { key: "time", label: t("projWork.notes.time") },
  ];

  return (
    <section className="space-y-3" aria-label={t("projWork.notes.title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("projWork.notes.title")}</h3>
        <div role="group" aria-label={t("projWork.notes.title")} className="flex flex-wrap gap-1">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                filter === f.key ? (f.key === "time" ? "border-sky-400/60 bg-sky-500/15 text-sky-200" : "border-violet-400/60 bg-violet-500/15 text-violet-200") : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {time.isLoading && (filter === "all" || filter === "time") && items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t("projWork.loading")}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("projWork.notes.empty")}</p>
      ) : (
        <ol className="space-y-2.5">
          {items.map((it) => {
            if (it.kind === "time") {
              const e = it.entry;
              return (
                <li key={it.key} className="mr-auto max-w-[90%] space-y-1.5 rounded-2xl border border-sky-500/30 bg-sky-500/5 p-3 sm:max-w-[75%]">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="font-medium text-sky-200">{t("projWork.notes.timeLabel")}</span>
                    <span>{e.name}</span>
                    <span>·</span>
                    <span>{formatDay(e.date, lang)}</span>
                    <span className="font-mono font-semibold text-sky-200">{hm(e.hours)}</span>
                    <span className={cn("rounded-full border px-1.5 py-px", e.billable ? "border-sky-400/40" : "border-border")}>{e.billable ? t("projWork.notes.billable") : t("projWork.notes.notBillable")}</span>
                  </div>
                  {e.note && <p className="whitespace-pre-wrap text-sm">{e.note}</p>}
                  {e.taskIds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {e.taskIds.map((id) =>
                        titles.has(id) ? (
                          <TaskChip key={id} title={titles.get(id) ?? ""} onClick={() => onOpenTask(id)} />
                        ) : null,
                      )}
                    </div>
                  )}
                </li>
              );
            }
            const n = it.note;
            const mine = n.author?.id === me.id;
            const canDelete = (mine && can("proj.edit")) || project.canManage;
            return (
              <li
                key={it.key}
                className={cn(
                  "max-w-[90%] space-y-1.5 rounded-2xl border p-3 sm:max-w-[75%]",
                  n.internal ? "mr-auto border-violet-500/30 bg-violet-500/5" : "ml-auto border-[color:var(--gold)]/40 bg-[color:var(--gold)]/5",
                )}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span className={cn("font-medium", n.internal ? "text-violet-200" : "text-[color:var(--gold)]")}>{n.internal ? t("projWork.notes.internalLabel") : t("projWork.notes.reply")}</span>
                  <span>·</span>
                  <span>{n.author?.name ?? "—"}</span>
                  <span>·</span>
                  <time dateTime={n.createdAt}>{formatStamp(n.createdAt, lang)}</time>
                </div>
                <p className="whitespace-pre-wrap text-sm">{n.text}</p>
                {!n.internal && n.emailedTo.length > 0 && <p className="text-xs text-muted-foreground">{t("projWork.notes.sentTo", { to: n.emailedTo.join(", ") })}</p>}
                {n.tasks.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <span className="sr-only">{t("projWork.notes.tagged")}</span>
                    {n.tasks.map((k) => (
                      <TaskChip key={k.id} title={k.title} onClick={() => onOpenTask(k.id)} />
                    ))}
                  </div>
                )}
                {canDelete && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => void askRemove(n.id)}
                      disabled={remove.isPending}
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive"
                      aria-label={t("projWork.delete")}
                    >
                      <Trash2 className="size-3.5" aria-hidden /> {t("projWork.delete")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function TaskChip({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="max-w-full truncate rounded-full border border-violet-400/40 bg-violet-500/10 px-2 py-0.5 text-xs text-violet-200 hover:bg-violet-500/20">
      {title}
    </button>
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
