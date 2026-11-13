import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, FolderOpen, Lock, Plus, Workflow } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { TaskCard } from "./shared";
import { ManageLists, inSpace, useTaskLists } from "./lists";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { TaskRow } from "./TeamList";
import { taskError } from "./TaskDialog";

/**
 * To do: a private tool of the person. A to-do is a task on its own, or grouped in one of their personal lists. Nobody else sees
 * it, it is never assigned to anyone else and it has no timer (shared tasks, with a timer, are in the Tasks tab).
 * Opens on the loose to-dos and the personal lists; a list opens with a small arrow to come back.
 */
export function TodoTab({ onOpenTask, view = "all", compact }: { onOpenTask: (id: string) => void; /** only the to-dos, only the personal lists, or both */ view?: "all" | "todos" | "lists"; compact?: boolean }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const lists = useTaskLists();
  const [list, setList] = useState<string>("");
  const [manage, setManage] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["pipeline", "tasks", "todo"], queryFn: () => api.get<TaskCard[]>("/pipeline/tasks?status=open&space=todo"), refetchInterval: 30_000 });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["pipeline"] });
  const patch = useMutation({
    mutationFn: (p: { id: string; patch: Record<string, unknown> }) => api.patch(`/pipeline/tasks/${p.id}`, p.patch),
    onSuccess: refresh,
    onError: (e) => {
      toast.error(taskError(t, e));
      refresh();
    },
  });
  const editable = can("pipeline.edit");
  const mine = inSpace(lists.data, "todo");
  const current = mine.find((l) => l.id === list);
  const all = data ?? [];
  const byDue = (a: TaskCard, b: TaskCard) => (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99") || a.title.localeCompare(b.title);
  const shown = (current ? all.filter((x) => x.listId === current.id) : all.filter((x) => !x.listId)).sort(byDue);
  const rows = (items: TaskCard[]) => (
    <ul className="glass divide-y divide-[color:var(--glass-border)] overflow-hidden rounded-2xl border">
      {items.map((task) => (
        <li key={task.id}>
          <TaskRow task={task} todo editable={editable} onOpen={() => onOpenTask(task.id)} onPatch={(p) => patch.mutate({ id: task.id, patch: p })} people={[]} />
        </li>
      ))}
    </ul>
  );
  return (
    <div className="space-y-3">
      {manage && <ManageLists space="todo" onClose={() => setManage(false)} onCreated={(id) => setList(id)} />}
      <div className="flex flex-wrap items-center gap-2">
        {current ? (
          <>
            <button type="button" onClick={() => setList("")} aria-label={t("pipeline.todo.back")} title={t("pipeline.todo.back")} className="flex size-9 items-center justify-center rounded-xl border text-muted-foreground transition-colors hover:border-[color:var(--gold)]/50 hover:text-foreground">
              <ArrowLeft className="size-4" />
            </button>
            <FolderOpen className="size-5 text-violet-300" />
            <h2 className="text-lg font-semibold">{current.name}</h2>
          </>
        ) : (
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Lock className="size-4 text-violet-300" /> {t("pipeline.todo.title")}
            <span className="text-xs font-normal text-muted-foreground">{t("pipeline.todo.private")}</span>
          </h2>
        )}
        {editable && (
          <button type="button" onClick={() => setManage(true)} className="ml-auto flex h-9 items-center gap-1.5 rounded-xl bg-grad-gold px-4 text-sm font-semibold text-[#1a1204]">
            <Plus className="size-4" /> {t("pipeline.lists.new")}
          </button>
        )}
      </div>

      {editable && !(view === "lists" && !current) && <TaskQuickAdd space="todo" listId={current?.id ?? (undefined as string | undefined)} className={compact ? "border-0 bg-transparent p-0" : ""} />}

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          {!current && mine.length > 0 && view !== "todos" && (
            <ul className="glass divide-y divide-[color:var(--glass-border)] overflow-hidden rounded-2xl border">
              {mine.map((l) => (
                <li key={l.id}>
                  <button type="button" onClick={() => setList(l.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[linear-gradient(90deg,rgba(255,206,26,0.06),transparent_60%)]">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-violet-400/40 bg-violet-500/10 text-violet-300">
                      <Lock className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{l.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t("pipeline.lists.open", { count: all.filter((x) => x.listId === l.id).length })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!current && view === "lists" ? null : shown.length === 0 ? (
            <div className={cn("glass flex flex-col items-center gap-2 rounded-2xl border px-6 py-10 text-center text-sm text-muted-foreground", !current && mine.length > 0 && "py-6")}>
              <Workflow className="size-7 opacity-50" />
              {t("pipeline.todo.none")}
            </div>
          ) : (
            <>
              {!current && <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("pipeline.todo.loose")}</h3>}
              {rows(shown)}
            </>
          )}
        </>
      )}
    </div>
  );
}
