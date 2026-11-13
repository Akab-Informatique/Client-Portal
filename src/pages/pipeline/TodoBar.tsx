import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ListTree, SquareCheckBig } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { inSpace, useTaskLists } from "./lists";
import type { TaskCard } from "./shared";
import { TaskDialog } from "./TaskDialog";
import { TodoTab } from "./TodoTab";

/**
 * The To do mini bar: two small icons floating at the right edge of every page (no bar across the page), one for the private
 * to-dos and one for the personal lists, each with its count. A click slides the private To do panel in; a to-do opens in the
 * usual task window. Private to the person: nobody else sees it, no timer.
 */
export function TodoBar() {
  const { t } = useTranslation();
  const can = useCan();
  const [open, setOpen] = useState<"todos" | "lists" | null>(null);
  const [task, setTask] = useState<string | null>(null);
  const lists = useTaskLists();
  const todos = useQuery({ queryKey: ["pipeline", "tasks", "todo"], queryFn: () => api.get<TaskCard[]>("/pipeline/tasks?status=open&space=todo"), enabled: can("pipeline.view"), refetchInterval: 60_000 });
  if (!can("pipeline.view")) return null;
  const button = (key: "todos" | "lists", Icon: typeof ListTree, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setOpen(open === key ? null : key)}
      aria-label={label}
      title={label}
      className={cn("group flex w-11 flex-col items-center gap-0.5 rounded-xl py-2 text-muted-foreground transition-colors hover:bg-[color:var(--gold)]/15 hover:text-primary", open === key && "bg-[color:var(--gold)]/15 text-primary")}
    >
      <Icon className="size-5" />
      <span className="rounded-full bg-foreground/10 px-1.5 font-mono text-[10px] leading-4 text-foreground">{count}</span>
    </button>
  );
  return (
    <>
      <div className="fixed right-0 top-1/3 z-40 flex flex-col gap-0.5 rounded-l-2xl border border-r-0 border-[color:var(--glass-border)] bg-background/70 p-1 shadow-lg backdrop-blur-xl">
        {button("todos", SquareCheckBig, t("pipeline.todo.title"), todos.data?.length ?? 0)}
        {button("lists", ListTree, t("pipeline.todo.myLists"), inSpace(lists.data, "todo").length)}
      </div>
      <Sheet open={open !== null && task === null} onOpenChange={(v) => !v && setOpen(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="text-base">{t(open === "lists" ? "pipeline.todo.myLists" : "pipeline.todo.title")}</SheetTitle>
            <SheetDescription className="text-xs">{t("pipeline.todo.private")}</SheetDescription>
          </SheetHeader>
          <div className="p-4">{open && <TodoTab key={open} view={open} compact onOpenTask={(id) => setTask(id)} />}</div>
        </SheetContent>
      </Sheet>
      {task && <TaskDialog key={task} taskId={task} onClose={() => setTask(null)} onOpenTask={(id) => setTask(id)} />}
    </>
  );
}
