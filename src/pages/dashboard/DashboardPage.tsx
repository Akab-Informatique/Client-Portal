import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import type { DashboardWidget } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DEFAULT_LAYOUT, WIDGETS } from "./widgets";
import { DashboardMenu, DashboardPicker, useDashboards, type DashboardInfo } from "./DashboardPicker";

const SPAN: Record<DashboardWidget["size"], string> = {
  sm: "md:col-span-3 xl:col-span-4",
  md: "md:col-span-6 xl:col-span-8",
  lg: "md:col-span-6 xl:col-span-12",
};

/** Opens the person's default dashboard (Akab unless they chose another one). */
export function DashboardPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: list, isLoading } = useDashboards();
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = list?.find((d) => d.id === chosen) ?? list?.find((d) => d.isDefault) ?? list?.[0] ?? null;

  if (isLoading) return null;
  const picker = <DashboardPicker current={selected} onSelect={setChosen} />;
  if (!selected) {
    return (
      <div className="space-y-6">
        {picker}
        <div className="rounded-2xl border border-dashed p-12 text-center text-muted-foreground">{t("dashboards.none")}</div>
      </div>
    );
  }
  return (
    <DashboardBoard
      key={selected.id}
      dashboard={selected}
      header={picker}
      onDeleted={() => setChosen(null)}
      onSave={async (layout) => {
        await api.patch(`/dashboards/${selected.id}`, { layout });
        await qc.invalidateQueries({ queryKey: ["dashboards"] });
      }}
    />
  );
}

function DashboardBoard({
  dashboard,
  header,
  onDeleted,
  onSave,
}: {
  dashboard: DashboardInfo;
  header: React.ReactNode;
  onDeleted: () => void;
  onSave: (layout: DashboardWidget[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const can = useCan();
  const allowed = useMemo(() => WIDGETS.filter((w) => !w.permission || can(w.permission)), [can]);
  const sanitize = (l: DashboardWidget[]) => l.filter((w) => allowed.some((a) => a.type === w.type));
  const [layout, setLayout] = useState<DashboardWidget[]>(() => sanitize(dashboard.layout));
  const [editing, setEditing] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function persist(next: DashboardWidget[]) {
    try {
      await onSave(next);
    } catch {
      toast.error(t("common.error"));
    }
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setLayout((l) => arrayMove(l, l.findIndex((w) => w.id === active.id), l.findIndex((w) => w.id === over.id)));
  }

  const missing = allowed.filter((w) => !layout.some((l) => l.type === w.type));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {header}
          <AnimatePresence>
            {editing && (
              <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="text-sm text-muted-foreground">
                {t("dashboard.customizeHint")}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-2">
          {editing && (
            <>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" disabled={!missing.length}>
                    <Plus className="size-4" /> {t("dashboard.addWidget")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-1.5">
                  {missing.map((w) => (
                    <button
                      key={w.type}
                      type="button"
                      onClick={() => setLayout((l) => [...l, { id: `w-${w.type}-${Date.now()}`, type: w.type, size: w.defaultSize }])}
                      className="flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-accent"
                    >
                      <w.icon className="mt-0.5 size-4 text-primary" />
                      <span>
                        <span className="block text-sm font-medium">{t(`dashboard.widgets.${w.type}`)}</span>
                        <span className="block text-xs text-muted-foreground">{t(`dashboard.widgetDesc.${w.type}`)}</span>
                      </span>
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (!window.confirm(t("dashboard.resetConfirm"))) return;
                  setLayout(sanitize(DEFAULT_LAYOUT));
                }}
              >
                <RotateCcw className="size-4" /> {t("dashboard.reset")}
              </Button>
            </>
          )}
          {editing ? (
            <Button
              size="sm"
              className="bg-grad-gold text-[#1a1204] glow-gold"
              onClick={() => {
                void persist(layout);
                setEditing(false);
              }}
            >
              <Check className="size-4" /> {t("dashboard.done")}
            </Button>
          ) : (
            <DashboardMenu d={dashboard} onEditWidgets={() => setEditing(true)} onDeleted={onDeleted} />
          )}
        </div>
      </div>

      {layout.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-12 text-center text-muted-foreground">{t(dashboard.canEdit ? "dashboard.empty" : "dashboard.emptyReadOnly")}</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={layout.map((w) => w.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-6 xl:grid-cols-12">
              {layout.map((w) => (
                <SortableWidget
                  key={w.id}
                  widget={w}
                  editing={editing}
                  onSize={(size) => setLayout((l) => l.map((x) => (x.id === w.id ? { ...x, size } : x)))}
                  onRemove={() => setLayout((l) => l.filter((x) => x.id !== w.id))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function SortableWidget({
  widget,
  editing,
  onSize,
  onRemove,
}: {
  widget: DashboardWidget;
  editing: boolean;
  onSize: (s: DashboardWidget["size"]) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const def = WIDGETS.find((d) => d.type === widget.type);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id, disabled: !editing });
  if (!def) return null;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("relative min-h-40", SPAN[widget.size], isDragging && "z-20 opacity-80")}
    >
      <div className={cn("h-full transition-all", editing && "rounded-2xl ring-1 ring-dashed ring-[color:var(--gold)]/50 ring-offset-4 ring-offset-background")}>
        <div className={cn("h-full", editing && "pointer-events-none select-none")}>{def.render()}</div>
      </div>
      <AnimatePresence>
        {editing && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="absolute -top-3 right-3 z-10 flex items-center gap-1 rounded-full border bg-popover p-1 shadow-lg"
          >
            <button
              type="button"
              {...attributes}
              {...listeners}
              className="flex size-7 cursor-grab items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
              aria-label="Drag"
            >
              <GripVertical className="size-4" />
            </button>
            {(["sm", "md", "lg"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSize(s)}
                title={t(`dashboard.size.${s}`)}
                className={cn(
                  "h-7 rounded-full px-2 text-[11px] font-semibold uppercase",
                  widget.size === s ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {s === "sm" ? "S" : s === "md" ? "M" : "L"}
              </button>
            ))}
            <button
              type="button"
              onClick={onRemove}
              title={t("dashboard.remove")}
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
            >
              <X className="size-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
