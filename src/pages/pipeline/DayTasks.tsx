import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Workflow } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { DayEdge } from "./DayEdge";
import { ListBadge, ListSelect, ManageLists, inSpace, useTaskLists } from "./lists";
import { PRIORITY_STYLE, STATUS_STYLE, dayLabel, todayYmd, type TaskCard } from "./shared";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { taskError, usePeople } from "./TaskDialog";

const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
const byDue = (a: TaskCard, b: TaskCard) => (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99") || (a.dueTime ?? "").localeCompare(b.dueTime ?? "") || a.title.localeCompare(b.title);

/**
 * Ma journée › Tâches: the tasks of the shared lists, every one the person can see by default (or only mine, a partner's, or one list),
 * sorted by due day, each with its list, due day, who has it and its status, and the edge button to put it on the day's plan.
 * A button makes a new list. (The private to-dos are in the floating To do bar at the right of the page.)
 */
export function DayTasks({ userId, onOpenTask }: { userId: string; onOpenTask: (id: string) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const people = usePeople();
  const lists = useTaskLists();
  const own = userId === me.id;
  const [scope, setScope] = useState<string>("all");
  const [list, setList] = useState("");
  const [manage, setManage] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["pipeline"] });

  const tasks = useQuery({
    queryKey: ["pipeline", "tasks", "day-tasks", userId, scope, list],
    queryFn: () => {
      const q = new URLSearchParams({ status: "open", space: "tasks" });
      if (scope === "mine") {
        if (own) q.set("scope", "mine");
        else q.set("assignee", userId);
      } else if (scope !== "all") q.set("assignee", scope);
      if (list) q.set("list", list);
      return api.get<TaskCard[]>(`/pipeline/tasks?${q}`);
    },
    refetchInterval: 60_000,
  });
  const done = useMutation({
    mutationFn: (id: string) => api.patch(`/pipeline/tasks/${id}`, { status: "done" }),
    onSuccess: refresh,
    onError: (e) => toast.error(taskError(t, e)),
  });
  const editable = can("pipeline.edit");
  const today = todayYmd();
  const rows = [...(tasks.data ?? [])].sort(byDue);

  return (
    <section className="glass min-w-0 rounded-2xl border p-4">
      {manage && <ManageLists space="tasks" onClose={() => setManage(false)} onCreated={(id) => setList(id)} />}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Workflow className="size-3.5" /> {t("pipeline.tabs.tasks")} <span className="font-mono normal-case opacity-70">{rows.length}</span>
        </h3>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-lg border bg-background/40 p-0.5">
            {(
              [
                ["all", t("pipeline.tasksSection.all")],
                ["mine", own ? t("pipeline.tasksSection.mine") : (people.data?.find((p) => p.id === userId)?.name ?? t("pipeline.tasksSection.mine"))],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setScope(k)} className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", scope === k ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
                {label}
              </button>
            ))}
          </div>
          <select value={scope === "all" || scope === "mine" ? "" : scope} onChange={(e) => setScope(e.target.value || "all")} aria-label={t("pipeline.tasksSection.person")} className="h-7 rounded-md border bg-transparent px-2 text-xs">
            <option value="">{t("pipeline.tasksSection.person")}</option>
            {(people.data ?? [])
              .filter((p) => p.id !== userId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <ListSelect value={list} onChange={setList} lists={inSpace(lists.data, "tasks")} space="tasks" all={t("pipeline.lists.all")} className="h-7 text-xs" />
          {editable && own && (
            <button type="button" onClick={() => setManage(true)} className="flex h-7 items-center gap-1 rounded-md border border-[color:var(--gold)]/40 px-2 text-xs font-semibold text-primary hover:bg-[color:var(--gold)]/10">
              <Plus className="size-3.5" /> {t("pipeline.lists.new")}
            </button>
          )}
        </div>
      </div>
      {tasks.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : rows.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{t("pipeline.tasksSection.none")}</p>
      ) : (
        <ul className="divide-y divide-[color:var(--glass-border)]">
          {rows.map((k) => {
            const late = k.dueDate && k.dueDate < today;
            return (
              <li key={k.id} className="flex items-center gap-2 py-1.5">
                <DayEdge kind="task" id={k.id} number={null} title={k.title} urgent={k.priority === "urgent"} onOpen={() => onOpenTask(k.id)} />
                {editable && <Checkbox disabled={k.waiting} onCheckedChange={() => done.mutate(k.id)} aria-label={t("pipeline.complete")} />}
                <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_STYLE[k.priority].dot)} title={t(`pipeline.priority.${k.priority}`)} />
                <button type="button" onClick={() => onOpenTask(k.id)} className="min-w-0 flex-1 truncate text-left text-sm font-medium">
                  {k.title}
                </button>
                <ListBadge name={k.listName} shared={k.listShared} className="hidden max-w-44 shrink-0 md:inline-flex" />
                <span className={cn("hidden w-24 shrink-0 text-right font-mono text-[11px] sm:block", late ? "text-red-300" : "text-muted-foreground")}>{k.dueDate ? dayLabel(k.dueDate) : "—"}</span>
                <span className="hidden w-16 shrink-0 -space-x-1.5 lg:flex" title={k.assignees.map((a) => a.name).join(", ")}>
                  {k.assignees.slice(0, 2).map((a) => (
                    <span key={a.id} className="flex size-5 items-center justify-center rounded-full bg-grad-gold text-[9px] font-bold text-[#1a1204] ring-2 ring-background">
                      {initials(a.name)}
                    </span>
                  ))}
                </span>
                <span className={cn("hidden shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium sm:inline", STATUS_STYLE[k.status])}>{t(`pipeline.status.${k.status}`)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {editable && own && <TaskQuickAdd space="tasks" defaultDue={todayYmd()} className="mt-3 border-0 bg-transparent p-0" />}
    </section>
  );
}
