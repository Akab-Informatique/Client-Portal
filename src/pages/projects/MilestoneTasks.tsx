import { useTranslation } from "react-i18next";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDownUp, GripVertical, Lock } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { byCustom, useCustomOrder, useSortDefault } from "@/lib/sortPrefs";
import { cn } from "@/lib/utils";
import { shortDate } from "@/pages/tickets/shared";
import { hoursText, PRIORITY_DOT, TASK_STYLE, type Milestone } from "./shared";

const SORTS = ["checkpoint", "due", "status", "custom"] as const;
type Sort = (typeof SORTS)[number];
type Task = NonNullable<Milestone["tasks"]>[number];
const STATUS_RANK = { doing: 0, todo: 1, blocked: 2, done: 3 } as const;

/**
 * The tasks of a phase. The order is the technician's own choice: by checkpoint (the default), due day, status, or
 * their custom order (dragged by hand, kept for them only). The sort they pick is their default for every project.
 */
export function MilestoneTasks({ projectId, m, onTask }: { projectId: string; m: Milestone; onTask: (id: string) => void }) {
  const { t } = useTranslation();
  const [sort, setSort] = useSortDefault<Sort>("projects.tasks", "checkpoint", SORTS);
  const { keys, save } = useCustomOrder(`project:${projectId}:ms:${m.id}`, sort === "custom");
  const tasks = m.tasks ?? [];
  const at = (k: Task) => `${k.checkpointDate ?? "9999-99-99"} ${k.checkpointDate ? (k.checkpointTime ?? "17:00") : ""}`;
  const ordered =
    sort === "custom"
      ? byCustom(tasks, (k) => k.id, keys)
      : [...tasks].sort((a, b) => {
          if (a.done !== b.done) return a.done ? 1 : -1;
          if (sort === "due") return (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || at(a).localeCompare(at(b));
          if (sort === "status") return STATUS_RANK[a.status] - STATUS_RANK[b.status] || at(a).localeCompare(at(b));
          return at(a).localeCompare(at(b)) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
        });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = ordered.map((k) => k.id);
    save(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
    // moving a task by hand in any sort puts the list in the technician's own order, starting from what they saw
    if (sort !== "custom") setSort("custom");
  };
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("projects.tasks")}</p>
        {tasks.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
              <ArrowDownUp className="size-3" /> {t(`projects.sort.${sort}`)}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {SORTS.map((s) => (
                <DropdownMenuItem key={s} onClick={() => setSort(s === "checkpoint" ? null : s)} className={cn(s === sort && "font-semibold text-primary")}>
                  {t(`projects.sort.${s}`)}
                </DropdownMenuItem>
              ))}
              <p className="max-w-56 px-2 py-1.5 text-[10px] text-muted-foreground">{t("projects.sort.hint")}</p>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {tasks.length === 0 && <p className="py-1 text-xs text-muted-foreground">{t("projects.noTasks")}</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
        <SortableContext items={ordered.map((k) => k.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1">
            {ordered.map((k) => (
              <TaskRow key={k.id} k={k} onTask={onTask} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function TaskRow({ k, onTask }: { k: Task; onTask: (id: string) => void }) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: k.id });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn(isDragging && "relative z-10 opacity-80")}>
      <div className="flex items-center gap-1">
        <button type="button" aria-label={t("projects.sort.drag")} title={t("projects.sort.drag")} className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing" {...attributes} {...listeners}>
          <GripVertical className="size-4" />
        </button>
        <button type="button" onClick={() => onTask(k.id)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border bg-background/40 px-3 py-2 text-left text-sm transition-colors hover:border-[color:var(--gold)]/40">
          <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_DOT[k.priority])} title={t(`projects.priority.${k.priority}`)} />
          {k.waiting && <Lock className="size-3.5 shrink-0 text-fuchsia-300" aria-label={t("projects.waitsFor")} />}
          <span className={cn("min-w-0 flex-1 truncate", k.status === "done" && "text-muted-foreground line-through")}>{k.title}</span>
          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium", TASK_STYLE[k.status])}>{t(`projects.taskStatus.${k.status}`)}</span>
          <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground sm:block">{k.assigneeName ?? t("projects.unassigned")}</span>
          <span className="hidden w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground sm:block">{k.hours ? hoursText(k.hours) : ""}</span>
          <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground md:block" title={t("pipeline.checkpoint")}>
            {k.checkpointDate ? `${shortDate(k.checkpointDate)} ${k.checkpointTime ?? ""}` : ""}
          </span>
          <span className={cn("w-14 shrink-0 text-right text-xs", k.late ? "text-red-400" : "text-muted-foreground")}>{k.dueDate ? shortDate(k.dueDate) : ""}</span>
        </button>
      </div>
    </li>
  );
}
