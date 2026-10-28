import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DndContext, KeyboardSensor, PointerSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, ArrowRight, Columns3, LayoutList, MoreHorizontal, Pencil, Plus, Rows3, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { cn, initials } from "@/lib/utils";
import { dueState, PRIORITY_STYLE, shortDate, shortDateTime, STATUS_STYLE, ticketErrorText, useChoiceText, type TicketSummary } from "./shared";

// ── The three ways to look at the list ───────────────────────────────────────────
/** standard: the table as it always was · kanban: boards the team sorts tickets on · compact: one short line per ticket */
export const LAYOUTS = ["standard", "kanban", "compact"] as const;
export type Layout = (typeof LAYOUTS)[number];
const KEY = "akab.tickets.layout";
const ICON = { standard: LayoutList, kanban: Columns3, compact: Rows3 } as const;

/** The view chosen on this computer (remembered). */
export function useTicketLayout(): [Layout, (l: Layout) => void] {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const v = localStorage.getItem(KEY);
      return (LAYOUTS as readonly string[]).includes(v ?? "") ? (v as Layout) : "standard";
    } catch {
      return "standard";
    }
  });
  return [
    layout,
    (l) => {
      setLayout(l);
      try {
        localStorage.setItem(KEY, l);
      } catch {
        /* the choice just is not remembered */
      }
    },
  ];
}

/** Standard · Kanban · Compact, in the filters box. */
export function LayoutSwitch({ value, onChange }: { value: Layout; onChange: (l: Layout) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center rounded-xl border bg-background/40 p-0.5" role="group" aria-label={t("tickets.layout.title")}>
      {LAYOUTS.map((l) => {
        const Icon = ICON[l];
        const on = value === l;
        return (
          <button
            key={l}
            type="button"
            aria-pressed={on}
            title={t(`tickets.layout.${l}Hint`)}
            onClick={() => onChange(l)}
            className={cn("flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors", on ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}
          >
            <Icon className="size-3.5" />
            <span className="hidden sm:inline">{t(`tickets.layout.${l}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Compact: one short line per ticket ───────────────────────────────────────────
const COMPACT_GRID = "grid grid-cols-[minmax(0,1fr)_5.5rem_4.5rem_6.5rem_9rem] items-center gap-x-3";

/** Name, priority, milestone, due date and status — nothing else, one line each. */
export function CompactList({ items, activeIds, onOpen }: { items: TicketSummary[]; activeIds: Set<number>; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const today = new Date().toLocaleDateString("en-CA");
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[44rem]">
        <div className={cn(COMPACT_GRID, "border-b border-[color:var(--glass-border)] bg-white/[0.02] px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground")}>
          <span>{t("tickets.fields.ticket")}</span>
          <span>{t("tickets.fields.priority")}</span>
          <span>{t("tickets.fields.milestone")}</span>
          <span>{t("tickets.fields.due")}</span>
          <span>{t("tickets.fields.status")}</span>
        </div>
        <ul className="divide-y divide-[color:var(--glass-border)]">
          {items.map((tk) => {
            const due = dueState(tk.dueAt, tk.statusKind);
            const open = tk.statusKind !== "complete";
            return (
              <li key={tk.id}>
                <button
                  type="button"
                  onClick={() => onOpen(tk.id)}
                  className={cn(COMPACT_GRID, "w-full px-4 py-1 text-left text-sm transition-colors hover:bg-[linear-gradient(90deg,rgba(255,206,26,0.07),transparent_60%)]", activeIds.has(tk.id) && "bg-[linear-gradient(90deg,rgba(255,206,26,0.1),transparent_70%)]")}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{tk.number}</span>
                    <span className="truncate font-medium" title={`${tk.title} · ${tk.company.name}`}>
                      {tk.title}
                    </span>
                  </span>
                  <span className={cn("flex items-center gap-1.5 text-xs font-medium", PRIORITY_STYLE[tk.priorityKind].text)}>
                    <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_STYLE[tk.priorityKind].dot)} />
                    <span className="truncate">{txt.priority({ label: tk.priorityLabel, kind: tk.priorityKind })}</span>
                  </span>
                  <span className={cn("whitespace-nowrap font-mono text-xs tabular-nums", tk.milestoneDate && open && tk.milestoneDate < today ? "text-destructive" : "text-muted-foreground")}>{tk.milestoneDate ? shortDate(tk.milestoneDate) : "—"}</span>
                  <span className={cn("whitespace-nowrap font-mono text-xs font-medium tabular-nums", due === "overdue" ? "text-destructive" : due === "today" ? "text-orange-400" : due === "soon" ? "text-primary" : "text-muted-foreground")}>{shortDateTime(tk.dueAt)}</span>
                  <span className={cn("inline-flex max-w-full items-center gap-1.5 truncate rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight", STATUS_STYLE[tk.statusKind])}>
                    <span className="size-1.5 shrink-0 rounded-full bg-current" />
                    <span className="truncate">{txt.status({ label: tk.statusLabel, kind: tk.statusKind })}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ── Kanban: boards the team shares ───────────────────────────────────────────────
type Board = { id: string; name: string; position: number };
type Card = { ticketId: number; boardId: string; position: number };
type BoardData = { boards: Board[]; cards: Card[] };
const BOARDS_KEY = ["ticket-boards"];
const NONE = "none";

/** What the server does when a ticket is dropped on a board, so the card moves at once. */
function moveCard(cards: Card[], ticketId: number, boardId: string | null, before: number | null): Card[] {
  const rest = cards.filter((c) => c.ticketId !== ticketId);
  if (!boardId) return rest;
  const target = rest.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position).map((c) => c.ticketId);
  const at = before != null ? target.indexOf(before) : -1;
  target.splice(at >= 0 ? at : target.length, 0, ticketId);
  return [...rest.filter((c) => c.boardId !== boardId), ...target.map((id, i) => ({ ticketId: id, boardId, position: i }))];
}

/**
 * The tickets of the list on boards (columns) made by the team. A board only
 * sorts tickets here, in this view: nothing is written on the ticket and the
 * other views show no board. What is not on a board stays in "Not sorted".
 */
export function KanbanBoard({ items, canEdit, onOpen }: { items: TicketSummary[]; canEdit: boolean; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const { data } = useQuery({ queryKey: BOARDS_KEY, queryFn: () => api.get<BoardData>("/ticket-boards"), refetchInterval: 30_000 });
  const boards = useMemo(() => [...(data?.boards ?? [])].sort((a, b) => a.position - b.position), [data]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  // the columns: "not sorted", then each board; a board's tickets in its order, only the ones the filters show
  const columns = useMemo(() => {
    const cardOf = new Map((data?.cards ?? []).map((c) => [c.ticketId, c]));
    const known = new Set(boards.map((b) => b.id));
    const sorted = (id: string) =>
      items
        .filter((tk) => cardOf.get(tk.id)?.boardId === id)
        .sort((a, b) => (cardOf.get(a.id)!.position - cardOf.get(b.id)!.position));
    return [
      { id: NONE, board: null as Board | null, items: items.filter((tk) => !cardOf.has(tk.id) || !known.has(cardOf.get(tk.id)!.boardId)) },
      ...boards.map((b) => ({ id: b.id, board: b as Board | null, items: sorted(b.id) })),
    ];
  }, [items, boards, data]);

  const refresh = (next: BoardData) => qc.setQueryData(BOARDS_KEY, next);
  const fail = (e: unknown) => {
    toast.error(ticketErrorText(t, e));
    void qc.invalidateQueries({ queryKey: BOARDS_KEY });
  };
  const place = useMutation({
    mutationFn: (p: { ticketId: number; boardId: string | null; before: number | null }) => api.put<BoardData>(`/ticket-boards/cards/${p.ticketId}`, { boardId: p.boardId, before: p.before }),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: BOARDS_KEY });
      const prev = qc.getQueryData<BoardData>(BOARDS_KEY);
      if (prev) qc.setQueryData(BOARDS_KEY, { ...prev, cards: moveCard(prev.cards, p.ticketId, p.boardId, p.before) });
    },
    onSuccess: refresh,
    onError: fail,
  });
  const add = useMutation({
    mutationFn: (name: string) => api.post<Board>("/ticket-boards", { name }),
    onSuccess: () => {
      setAdding(false);
      void qc.invalidateQueries({ queryKey: BOARDS_KEY });
    },
    onError: fail,
  });
  const rename = useMutation({
    mutationFn: (p: { id: string; name: string }) => api.patch(`/ticket-boards/${p.id}`, { name: p.name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: BOARDS_KEY }),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/ticket-boards/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: BOARDS_KEY }),
    onError: fail,
  });
  const order = useMutation({
    mutationFn: (ids: string[]) => api.put<BoardData>("/ticket-boards/order", { ids }),
    onSuccess: refresh,
    onError: fail,
  });
  const shift = (id: string, by: -1 | 1) => {
    const ids = boards.map((b) => b.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    order.mutate(ids);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || !canEdit) return;
    const ticketId = Number(String(active.id).slice(1));
    const overId = String(over.id);
    let boardId: string | null;
    let before: number | null = null;
    if (overId.startsWith("col:")) {
      boardId = overId === `col:${NONE}` ? null : overId.slice(4);
    } else {
      const overTicket = Number(overId.slice(1));
      const col = columns.find((c) => c.items.some((x) => x.id === overTicket));
      if (!col) return;
      boardId = col.id === NONE ? null : col.id;
      const list = col.items;
      const oi = list.findIndex((x) => x.id === overTicket);
      const ai = list.findIndex((x) => x.id === ticketId);
      // dragged down inside the same column: it lands after the one it was dropped on
      before = ai !== -1 && ai < oi ? (list[oi + 1]?.id ?? null) : overTicket;
    }
    if (before === ticketId) return;
    place.mutate({ ticketId, boardId, before });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
      <div className="flex items-start gap-3 overflow-x-auto p-3 scrollbar-thin">
        {columns.map((col, i) => (
          <Column
            key={col.id}
            id={col.id}
            board={col.board}
            items={col.items}
            canEdit={canEdit}
            onOpen={onOpen}
            onRename={(name) => col.board && rename.mutate({ id: col.board.id, name })}
            onDelete={() =>
              col.board &&
              void confirm({ title: t("tickets.kanban.deleteTitle", { name: col.board.name }), description: t("tickets.kanban.deleteText"), confirmLabel: t("common.delete"), destructive: true }).then((ok) => ok && remove.mutate(col.board!.id))
            }
            onShift={(by) => col.board && shift(col.board.id, by)}
            first={i === 1}
            last={i === columns.length - 1}
          />
        ))}
        {canEdit && (
          <div className="w-72 shrink-0">
            {adding ? (
              <NewBoard onSave={(name) => add.mutate(name)} onCancel={() => setAdding(false)} busy={add.isPending} />
            ) : (
              <Button variant="outline" className="w-full justify-start border-dashed" onClick={() => setAdding(true)}>
                <Plus className="size-4" /> {t("tickets.kanban.add")}
              </Button>
            )}
          </div>
        )}
      </div>
    </DndContext>
  );
}

function NewBoard({ onSave, onCancel, busy }: { onSave: (name: string) => void; onCancel: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  return (
    <form
      className="space-y-2 rounded-xl border bg-card/60 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && !busy) onSave(name.trim());
      }}
    >
      <Input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onCancel()} placeholder={t("tickets.kanban.name")} className="h-8" />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim() || busy}>
          {t("common.create")}
        </Button>
      </div>
    </form>
  );
}

function Column({
  id,
  board,
  items,
  canEdit,
  onOpen,
  onRename,
  onDelete,
  onShift,
  first,
  last,
}: {
  id: string;
  board: Board | null;
  items: TicketSummary[];
  canEdit: boolean;
  onOpen: (id: number) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onShift: (by: -1 | 1) => void;
  first: boolean;
  last: boolean;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `col:${id}` });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(board?.name ?? "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setName(board?.name ?? ""), [board?.name]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const save = () => {
    setEditing(false);
    if (board && name.trim() && name.trim() !== board.name) onRename(name.trim());
    else setName(board?.name ?? "");
  };
  return (
    <section className={cn("flex max-h-[70vh] w-72 shrink-0 flex-col rounded-xl border bg-card/40", isOver && "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/[0.04]")}>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {editing && board ? (
          <Input ref={input} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={save} onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" && (setName(board.name), setEditing(false)))} className="h-7" />
        ) : (
          <h3 className={cn("min-w-0 flex-1 truncate text-sm font-semibold", !board && "text-muted-foreground")} onDoubleClick={() => canEdit && board && setEditing(true)}>
            {board ? board.name : t("tickets.kanban.notSorted")}
          </h3>
        )}
        <span className="rounded-full bg-foreground/[0.07] px-1.5 font-mono text-[11px] text-muted-foreground">{items.length}</span>
        {canEdit && board && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={t("tickets.kanban.menu")} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil className="size-4" /> {t("tickets.kanban.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={first} onSelect={() => onShift(-1)}>
                <ArrowLeft className="size-4" /> {t("tickets.kanban.left")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={last} onSelect={() => onShift(1)}>
                <ArrowRight className="size-4" /> {t("tickets.kanban.right")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 className="size-4" /> {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <div ref={setNodeRef} className="min-h-24 flex-1 space-y-2 overflow-y-auto p-2 scrollbar-thin">
        <SortableContext items={items.map((x) => `t${x.id}`)} strategy={verticalListSortingStrategy}>
          {items.map((tk) => (
            <KanbanCard key={tk.id} tk={tk} canEdit={canEdit} onOpen={() => onOpen(tk.id)} />
          ))}
        </SortableContext>
        {!items.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{board ? t("tickets.kanban.emptyBoard") : t("tickets.kanban.emptyNotSorted")}</p>}
      </div>
    </section>
  );
}

function KanbanCard({ tk, canEdit, onOpen }: { tk: TicketSummary; canEdit: boolean; onOpen: () => void }) {
  const txt = useChoiceText();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `t${tk.id}`, disabled: !canEdit });
  const due = dueState(tk.dueAt, tk.statusKind);
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      className="cursor-pointer touch-none select-none rounded-lg border bg-background/70 p-2.5 text-left shadow-sm transition-colors hover:border-[color:var(--gold)]/40"
    >
      <p className="flex items-baseline gap-1.5 text-sm">
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{tk.number}</span>
        <span className="line-clamp-2 font-medium">{tk.title}</span>
      </p>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{tk.company.name}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className={cn("flex items-center gap-1 font-medium", PRIORITY_STYLE[tk.priorityKind].text)}>
          <span className={cn("size-1.5 rounded-full", PRIORITY_STYLE[tk.priorityKind].dot)} />
          {txt.priority({ label: tk.priorityLabel, kind: tk.priorityKind })}
        </span>
        <span className={cn("font-mono tabular-nums", due === "overdue" ? "text-destructive" : due === "today" ? "text-orange-400" : "text-muted-foreground")}>{shortDateTime(tk.dueAt)}</span>
        {tk.assignee && <span className="ml-auto flex size-5 items-center justify-center rounded-full border bg-background/60 text-[9px] font-semibold" title={tk.assignee.name}>{initials(tk.assignee.name)}</span>}
      </div>
      <span className={cn("mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-tight", STATUS_STYLE[tk.statusKind])}>
        <span className="size-1 rounded-full bg-current" />
        {txt.status({ label: tk.statusLabel, kind: tk.statusKind })}
      </span>
    </div>
  );
}
