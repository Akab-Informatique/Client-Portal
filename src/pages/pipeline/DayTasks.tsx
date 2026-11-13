import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock, Workflow } from "lucide-react";
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
 * Ma journée › the two kinds of task side by side, the width of each dragged with the mouse:
 * left, **Tâches** (tasks of the shared lists: every one by default, or only mine, or a partner's, or one list), right, **À faire**
 * (the person's private to-dos). Every row has the edge button to put it on the day's plan. Both are sorted by due day.
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
  const [todoList, setTodoList] = useState("");
  const [manage, setManage] = useState<"tasks" | "todo" | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["pipeline"] });

  // the width of the left pane (percent), dragged and kept on this computer
  const box = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(() => {
    const v = Number(localStorage.getItem("akab.pipeline.tasksSplit"));
    return v >= 25 && v <= 80 ? v : 62;
  });
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    let last = split;
    const move = (ev: PointerEvent) => {
      last = Math.min(80, Math.max(25, ((ev.clientX - rect.left) / rect.width) * 100));
      setSplit(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem("akab.pipeline.tasksSplit", String(last));
      } catch {
        /* not kept */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

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
  const todos = useQuery({ queryKey: ["pipeline", "tasks", "todo"], queryFn: () => api.get<TaskCard[]>("/pipeline/tasks?status=open&space=todo"), enabled: own, refetchInterval: 60_000 });
  const done = useMutation({
    mutationFn: (id: string) => api.patch(`/pipeline/tasks/${id}`, { status: "done" }),
    onSuccess: refresh,
    onError: (e) => toast.error(taskError(t, e)),
  });
  const editable = can("pipeline.edit");
  const today = todayYmd();
  const taskRows = [...(tasks.data ?? [])].sort(byDue);
  const todoRows = [...(todos.data ?? [])].filter((x) => !todoList || (todoList === "none" ? !x.listId : x.listId === todoList)).sort(byDue);

  const row = (k: TaskCard, kind: "tasks" | "todo") => {
    const late = k.dueDate && k.dueDate < today;
    return (
      <li key={k.id} className="flex items-center gap-2 py-1.5">
        <DayEdge kind="task" id={k.id} number={null} title={k.title} urgent={k.priority === "urgent"} onOpen={() => onOpenTask(k.id)} />
        {editable && <Checkbox disabled={k.waiting} onCheckedChange={() => done.mutate(k.id)} aria-label={t("pipeline.complete")} />}
        <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_STYLE[k.priority].dot)} title={t(`pipeline.priority.${k.priority}`)} />
        <button type="button" onClick={() => onOpenTask(k.id)} className="min-w-0 flex-1 truncate text-left text-sm font-medium">
          {k.title}
        </button>
        {kind === "tasks" && <ListBadge name={k.listName} shared={k.listShared} className="hidden max-w-36 shrink-0 md:inline-flex" />}
        {kind === "todo" && k.listName && <ListBadge name={k.listName} shared={false} className="hidden max-w-32 shrink-0 md:inline-flex" />}
        <span className={cn("hidden w-24 shrink-0 text-right font-mono text-[11px] sm:block", late ? "text-red-300" : "text-muted-foreground")}>{k.dueDate ? dayLabel(k.dueDate) : "—"}</span>
        {kind === "tasks" && (
          <span className="hidden w-16 shrink-0 -space-x-1.5 lg:flex" title={k.assignees.map((a) => a.name).join(", ")}>
            {k.assignees.slice(0, 2).map((a) => (
              <span key={a.id} className="flex size-5 items-center justify-center rounded-full bg-grad-gold text-[9px] font-bold text-[#1a1204] ring-2 ring-background">
                {initials(a.name)}
              </span>
            ))}
          </span>
        )}
        <span className={cn("hidden shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium sm:inline", STATUS_STYLE[k.status])}>{t(`pipeline.status.${k.status}`)}</span>
      </li>
    );
  };
  const head = (icon: React.ReactNode, title: string, count: number) => (
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {icon} {title} <span className="font-mono normal-case opacity-70">{count}</span>
    </h3>
  );

  return (
    <div ref={box} className={cn("grid items-start gap-3", own ? "xl:[grid-template-columns:var(--split)_8px_minmax(0,1fr)]" : "")} style={{ ["--split" as string]: `minmax(0,${split}%)` }}>
      {manage && <ManageLists space={manage} onClose={() => setManage(null)} />}
      {/* Tâches: the shared lists */}
      <section className="glass min-w-0 rounded-2xl border p-4">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {head(<Workflow className="size-3.5" />, t("pipeline.tabs.tasks"), taskRows.length)}
          <div className="ml-auto flex items-center gap-0.5 rounded-lg border bg-background/40 p-0.5">
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
            <button type="button" onClick={() => setManage("tasks")} className="h-7 rounded-md border px-2 text-xs text-muted-foreground hover:text-foreground">
              {t("pipeline.lists.manage")}
            </button>
          )}
        </div>
        {tasks.isLoading ? <Skeleton className="h-20 w-full" /> : taskRows.length === 0 ? <p className="py-3 text-sm text-muted-foreground">{t("pipeline.tasksSection.none")}</p> : <ul className="divide-y divide-[color:var(--glass-border)]">{taskRows.map((k) => row(k, "tasks"))}</ul>}
        {editable && own && <TaskQuickAdd space="tasks" defaultDue={todayYmd()} className="mt-3 border-0 bg-transparent p-0" />}
      </section>

      {own && (
        <div onPointerDown={startDrag} onDoubleClick={() => (setSplit(62), localStorage.removeItem("akab.pipeline.tasksSplit"))} role="separator" aria-orientation="vertical" title={t("pipeline.day.resize")} className="group hidden cursor-col-resize touch-none items-stretch justify-center xl:flex">
          <span className="my-2 w-0.5 rounded-full bg-[color:var(--glass-border)] transition-colors group-hover:bg-[color:var(--gold)]/60 group-active:bg-[color:var(--gold)]" />
        </div>
      )}

      {/* À faire: the person's private to-dos */}
      {own && (
        <section className="glass min-w-0 rounded-2xl border p-4">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {head(<Lock className="size-3.5 text-violet-300" />, t("pipeline.tabs.todo"), todoRows.length)}
            <select value={todoList} onChange={(e) => setTodoList(e.target.value)} aria-label={t("pipeline.quick.list")} className="ml-auto h-7 rounded-md border bg-transparent px-2 text-xs">
              <option value="">{t("pipeline.lists.all")}</option>
              <option value="none">{t("pipeline.todo.loose")}</option>
              {inSpace(lists.data, "todo").map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            {editable && (
              <button type="button" onClick={() => setManage("todo")} className="h-7 rounded-md border px-2 text-xs text-muted-foreground hover:text-foreground">
                {t("pipeline.lists.manage")}
              </button>
            )}
          </div>
          {todos.isLoading ? <Skeleton className="h-20 w-full" /> : todoRows.length === 0 ? <p className="py-3 text-sm text-muted-foreground">{t("pipeline.todo.none")}</p> : <ul className="divide-y divide-[color:var(--glass-border)]">{todoRows.map((k) => row(k, "todo"))}</ul>}
          {editable && <TaskQuickAdd space="todo" className="mt-3 border-0 bg-transparent p-0" />}
        </section>
      )}
    </div>
  );
}
