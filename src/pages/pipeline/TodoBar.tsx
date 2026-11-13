import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { SquareCheckBig } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { PersonalNotes } from "./PersonalNotes";
import type { TaskCard } from "./shared";
import { TaskDialog } from "./TaskDialog";
import { TodoTab } from "./TodoTab";

const KEY = "akab.todobar.top";
const HEIGHT = 56;
const clamp = (y: number) => Math.min(Math.max(y, 72), Math.max(72, window.innerHeight - HEIGHT - 16));

/**
 * The To do icon: one small icon floating at the right edge of every page (no bar across the page). Drag it up or down to put it
 * where it suits you (it stays on the edge; the height is kept on this computer); a click slides in the private panel: the
 * to-dos on top and the personal lists under, and a Notes tab for private notes and quick reminders. Nobody else sees any of it.
 */
export function TodoBar() {
  const { t } = useTranslation();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"todo" | "notes">("todo");
  const [task, setTask] = useState<string | null>(null);
  const [top, setTop] = useState(() => {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? clamp(v) : Math.round(window.innerHeight / 3);
  });
  const drag = useRef<{ y0: number; top0: number; moved: boolean } | null>(null);
  const todos = useQuery({ queryKey: ["pipeline", "tasks", "todo"], queryFn: () => api.get<TaskCard[]>("/pipeline/tasks?status=open&space=todo"), enabled: can("pipeline.view"), refetchInterval: 60_000 });
  if (!can("pipeline.view")) return null;
  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    drag.current = { y0: e.clientY, top0: top, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientY - d.y0) < 5) return;
    d.moved = true;
    setTop(clamp(d.top0 + e.clientY - d.y0));
  };
  const onUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.moved) {
      try {
        localStorage.setItem(KEY, String(top));
      } catch {
        /* not kept */
      }
    } else setOpen((v) => !v);
  };
  return (
    <>
      <button
        type="button"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen((v) => !v))}
        aria-label={t("pipeline.todo.title")}
        title={t("pipeline.todo.drag")}
        style={{ top, height: HEIGHT }}
        className={cn("fixed right-0 z-40 flex w-11 cursor-grab touch-none select-none flex-col items-center justify-center gap-0.5 rounded-l-2xl border border-r-0 border-[color:var(--glass-border)] bg-background/70 text-muted-foreground shadow-lg backdrop-blur-xl transition-colors hover:text-primary active:cursor-grabbing", open && "text-primary")}
      >
        <SquareCheckBig className="size-5" />
        <span className="rounded-full bg-foreground/10 px-1.5 font-mono text-[10px] leading-4 text-foreground">{todos.data?.length ?? 0}</span>
      </button>
      <Sheet open={open && task === null} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="text-base">{t("pipeline.todo.title")}</SheetTitle>
            <SheetDescription className="text-xs">{t("pipeline.todo.private")}</SheetDescription>
            <div className="flex gap-1 pt-1" role="tablist">
              {(["todo", "notes"] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition-colors", tab === k ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
                  {t(k === "todo" ? "pipeline.todo.title" : "pipeline.notes.title")}
                </button>
              ))}
            </div>
          </SheetHeader>
          <div className="p-4">{tab === "todo" ? <TodoTab compact onOpenTask={(id) => setTask(id)} /> : <PersonalNotes />}</div>
        </SheetContent>
      </Sheet>
      {task && <TaskDialog key={task} taskId={task} onClose={() => setTask(null)} onOpenTask={(id) => setTask(id)} />}
    </>
  );
}
