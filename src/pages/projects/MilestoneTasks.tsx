import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useDroppable, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDownUp, Check, ChevronDown, Folder, FolderInput, FolderOpen, FolderPlus, GripVertical, Lock, Pencil, Trash2, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { byCustom, useCustomOrder, useSortDefault } from "@/lib/sortPrefs";
import { cn } from "@/lib/utils";
import { shortDate } from "@/pages/tickets/shared";
import { hoursText, PRIORITY_DOT, TASK_STYLE, type Milestone } from "./shared";
import { useTaskDnd } from "./taskDnd";

const SORTS = ["checkpoint", "due", "status", "custom"] as const;
type Sort = (typeof SORTS)[number];
type Task = NonNullable<Milestone["tasks"]>[number];
type Group = NonNullable<Milestone["groups"]>[number];
const STATUS_RANK = { doing: 0, todo: 1, blocked: 2, done: 3 } as const;
const CLOSED_KEY = "akab.projects.groups.closed";
const readClosed = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

/**
 * The tasks of a phase. The order is the technician's own choice: by checkpoint (the default), due day, status, or
 * their custom order (dragged by hand, kept for them only). The sort they pick is their default for every project.
 * Tasks can also be kept together in simple groups (an option: a folder with an arrow to fold it; not subtasks).
 */
export function MilestoneTasks({ projectId, m, onTask, edit, onChanged, fail }: { projectId: string; m: Milestone; onTask: (id: string) => void; edit: boolean; onChanged: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [sort, setSort] = useSortDefault<Sort>("projects.tasks", "checkpoint", SORTS);
  const { keys, save } = useCustomOrder(`project:${projectId}:ms:${m.id}`, sort === "custom");
  const tasks = m.tasks ?? [];
  const groups = m.groups ?? [];
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
  const groupOf = (k: Task) => (k.groupId && groups.some((g) => g.id === k.groupId) ? k.groupId : null);
  const { dragging, register } = useTaskDnd();
  // a drop inside this phase (the drag area is the project's, shared by all the phases): reorder, or move to a group / out of it
  const onEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const a = ordered.find((k) => k.id === e.active.id);
    if (!a) return;
    const over = e.over.data.current as { type?: string; groupId?: string | null } | undefined;
    // on a group: that group; on the loose zone or the phase itself: out of any group; on a task: where that task is
    const zone = over?.type === "group" ? (over.groupId ?? null) : over?.type === "loose" || over?.type === "phase" ? null : undefined;
    const o = zone === undefined ? ordered.find((k) => k.id === String(e.over!.id)) : undefined;
    const target = zone !== undefined ? zone : o ? groupOf(o) : undefined;
    if (target === undefined) return;
    if (groupOf(a) !== target) {
      // dropped in another group (or out of its group): it moves there, and takes the place of the task it was dropped on
      if (!edit) return;
      moveTask.mutate({ id: a.id, groupId: target });
    }
    if (o) {
      const ids = ordered.map((k) => k.id);
      save(arrayMove(ids, ids.indexOf(a.id), ids.indexOf(o.id)));
      // moving a task by hand in any sort puts the list in the technician's own order, starting from what they saw
      if (sort !== "custom") setSort("custom");
    }
  };
  // groups: made here, folded or not (kept on this computer), renamed, deleted (their tasks stay)
  const latest = useRef(onEnd);
  latest.current = onEnd;
  useEffect(() => register(m.id, (e) => latest.current(e)), [m.id, register]);
  const [closed, setClosed] = useState(readClosed);
  const toggle = (id: string) =>
    setClosed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(CLOSED_KEY, JSON.stringify([...n]));
      } catch {
        /* not kept */
      }
      return n;
    });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const addGroup = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/milestones/${m.id}/groups`, { name: name.trim() }),
    onSuccess: () => (setName(""), setAdding(false), onChanged()),
    onError: fail,
  });
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.patch(`/projects/${projectId}/groups/${v.id}`, { name: v.name }), onSuccess: onChanged, onError: fail });
  const delGroup = useMutation({ mutationFn: (id: string) => api.del(`/projects/${projectId}/groups/${id}`), onSuccess: onChanged, onError: fail });
  const moveTask = useMutation({ mutationFn: (v: { id: string; groupId: string | null }) => api.patch(`/projects/${projectId}/tasks/${v.id}`, { groupId: v.groupId }), onSuccess: onChanged, onError: fail });
  const rows = (list: Task[]) => (
    <SortableContext items={list.map((k) => k.id)} strategy={verticalListSortingStrategy}>
      <ul className="space-y-1">
        {list.map((k) => (
          <TaskRow key={k.id} k={k} milestoneId={m.id} onTask={onTask} groups={edit ? groups : []} onGroup={(groupId) => moveTask.mutate({ id: k.id, groupId })} />
        ))}
      </ul>
    </SortableContext>
  );
  const loose = ordered.filter((k) => !groupOf(k));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("projects.tasks")}</p>
        <div className="flex items-center gap-1">
          {edit && !adding && (
            <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
              <FolderPlus className="size-3" /> {t("projects.group.new")}
            </button>
          )}
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
      </div>
      {adding && (
        <form
          className="mb-2 flex items-center gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (name.trim()) addGroup.mutate();
          }}
        >
          <FolderPlus className="size-4 text-muted-foreground" />
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("projects.group.name")} maxLength={200} className="h-8 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-[color:var(--gold)]/50" />
          <button type="submit" disabled={!name.trim() || addGroup.isPending} className="rounded-md p-1.5 text-primary hover:bg-foreground/[0.06] disabled:opacity-40" aria-label={t("common.save")}>
            <Check className="size-4" />
          </button>
          <button type="button" onClick={() => (setAdding(false), setName(""))} className="rounded-md p-1.5 text-muted-foreground hover:bg-foreground/[0.06]" aria-label={t("common.cancel")}>
            <X className="size-4" />
          </button>
        </form>
      )}
      {tasks.length === 0 && groups.length === 0 && <p className="py-1 text-xs text-muted-foreground">{t("projects.noTasks")}</p>}
      <div>
        <div className="space-y-2">
          {groups.map((g) => {
            const inside = ordered.filter((k) => groupOf(k) === g.id);
            const open = !closed.has(g.id);
            return (
              <GroupBox key={g.id} g={g} milestoneId={m.id} count={inside.length} done={inside.filter((k) => k.done).length} open={open} edit={edit} onToggle={() => toggle(g.id)} onRename={(n) => rename.mutate({ id: g.id, name: n })} onDelete={() => delGroup.mutate(g.id)}>
                {inside.length === 0 ? <p className="px-2 py-1 text-xs text-muted-foreground">{t("projects.group.empty")}</p> : rows(inside)}
              </GroupBox>
            );
          })}
          {groups.length > 0 && (loose.length > 0 || dragging) ? (
            <LooseZone milestoneId={m.id} empty={loose.length === 0} dragging={dragging}>
              {loose.length > 0 && rows(loose)}
            </LooseZone>
          ) : (
            loose.length > 0 && rows(loose)
          )}
        </div>
      </div>
    </div>
  );
}

/** One group: a folder with an arrow (folds the tasks inside), its name (renamed in place), how many are done, delete */
function GroupBox({ g, milestoneId, count, done, open, edit, onToggle, onRename, onDelete, children }: { g: Group; milestoneId: string; count: number; done: number; open: boolean; edit: boolean; onToggle: () => void; onRename: (name: string) => void; onDelete: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(g.name);
  const { setNodeRef, isOver } = useDroppable({ id: `group:${g.id}`, data: { type: "group", milestoneId, groupId: g.id } });
  const commit = () => {
    setEditing(false);
    if (text.trim() && text.trim() !== g.name) onRename(text.trim());
    else setText(g.name);
  };
  return (
    <div ref={setNodeRef} className={cn("rounded-xl border bg-violet-500/[0.04] transition-colors", isOver ? "border-violet-300/70 bg-violet-500/[0.12]" : "border-violet-400/25")}>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={t("projects.group.toggle")} title={t("projects.group.toggle")} className="rounded-md p-0.5 text-muted-foreground hover:text-foreground">
          <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
        </button>
        {open ? <FolderOpen className="size-4 shrink-0 text-violet-300" /> : <Folder className="size-4 shrink-0 text-violet-300" />}
        {editing ? (
          <input
            autoFocus
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") (setText(g.name), setEditing(false));
            }}
            className="h-6 min-w-0 flex-1 rounded border bg-transparent px-1.5 text-sm font-medium outline-none focus:border-[color:var(--gold)]/50"
          />
        ) : (
          <button type="button" onClick={onToggle} onDoubleClick={() => edit && setEditing(true)} className="min-w-0 flex-1 truncate text-left text-sm font-medium">
            {g.name}
          </button>
        )}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {done}/{count}
        </span>
        {edit && !editing && (
          <>
            <button type="button" onClick={() => setEditing(true)} title={t("projects.group.rename")} aria-label={t("projects.group.rename")} className="rounded p-1 text-muted-foreground/70 hover:text-foreground">
              <Pencil className="size-3.5" />
            </button>
            <button type="button" onClick={onDelete} title={t("projects.group.delete")} aria-label={t("projects.group.delete")} className="rounded p-1 text-muted-foreground/70 hover:text-destructive">
              <Trash2 className="size-3.5" />
            </button>
          </>
        )}
      </div>
      {open && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}

function TaskRow({ k, milestoneId, onTask, groups, onGroup }: { k: Task; milestoneId: string; onTask: (id: string) => void; groups: Group[]; onGroup: (groupId: string | null) => void }) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: k.id, data: { type: "task", milestoneId, groupId: k.groupId } });
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
        {groups.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger className={cn("rounded p-1 hover:text-foreground", k.groupId ? "text-violet-300" : "text-muted-foreground/70")} title={t("projects.group.move")} aria-label={t("projects.group.move")}>
              <FolderInput className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {groups.map((g) => (
                <DropdownMenuItem key={g.id} disabled={k.groupId === g.id} onSelect={() => onGroup(g.id)}>
                  <Folder className="size-4 text-violet-300" /> {g.name}
                </DropdownMenuItem>
              ))}
              {k.groupId && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onGroup(null)}>{t("projects.group.none")}</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}

/** The loose tasks of a milestone with groups: also a drop zone (a task dragged out of its group comes here) */
function LooseZone({ milestoneId, empty, dragging, children }: { milestoneId: string; empty: boolean; dragging: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `loose:${milestoneId}`, data: { type: "loose", milestoneId, groupId: null } });
  return (
    <div ref={setNodeRef} className={cn("rounded-xl transition-colors", isOver && "bg-foreground/[0.05] ring-1 ring-foreground/20", empty && dragging && "border border-dashed border-muted-foreground/40 px-3 py-3 text-center text-xs text-muted-foreground")}>
      {empty ? t("projects.group.none") : children}
    </div>
  );
}
