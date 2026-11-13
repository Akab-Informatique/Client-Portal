import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarClock, ChevronRight, Lock, Plus, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PRIORITIES, PRIORITY_STYLE, dayLabel, todayYmd, type Person, type TaskPriority } from "./shared";

/** One step of a task: the things to do. Steps are the task's subtasks — there is nothing else to open. */
export type Step = {
  id: string;
  text: string;
  done: boolean;
  priority: TaskPriority;
  assigneeId: string | null;
  dueDate: string | null;
  dependsOnId: string | null;
};

export const newStep = (id: string, text = ""): Step => ({ id, text, done: false, priority: "normal", assigneeId: null, dueDate: null, dependsOnId: null });

const selectCls = "h-8 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40 disabled:opacity-60";

/** What keeps a step from being ticked now: the step it waits for, or a start day not reached */
function holdOf(s: Step, all: Step[]): { kind: "waits"; title: string } | { kind: "starts"; date: string } | null {
  const dep = s.dependsOnId ? all.find((x) => x.id === s.dependsOnId) : null;
  if (dep && !dep.done) return { kind: "waits", title: dep.text };
  return null;
}

/**
 * The steps of a task as rows that fold: closed they show the words, the person, the days and what holds them back;
 * open they show everything (priority, person, start day, due day and time, the step it waits for). A new task keeps
 * them in memory (`creating`: nothing to tick yet, a step can only wait for an earlier one).
 */
export function TaskSteps({
  steps,
  people,
  disabled,
  creating,
  onAdd,
  onChange,
  onRemove,
}: {
  steps: Step[];
  people: Person[];
  disabled?: boolean;
  creating?: boolean;
  onAdd: (text: string) => void;
  onChange: (id: string, patch: Partial<Step>) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");
  const flip = (id: string) => setOpened((s) => (new Set(s).has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id)));
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  const allOpen = steps.length > 0 && steps.every((s) => opened.has(s.id));
  return (
    <div className="space-y-2">
      {steps.length > 1 && (
        <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setOpened(allOpen ? new Set() : new Set(steps.map((s) => s.id)))}>
          {allOpen ? t("pipeline.steps.collapseAll") : t("pipeline.steps.expandAll")}
        </button>
      )}
      <ul className="space-y-1.5">
        {steps.map((s, i) => {
          const hold = holdOf(s, steps);
          const isOpen = opened.has(s.id);
          const who = nameOf(s.assigneeId);
          const earlier = creating ? steps.slice(0, i) : steps.filter((x) => x.id !== s.id);
          return (
            <li key={s.id} className={cn("rounded-xl border bg-background/40", s.done && "opacity-70")}>
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <Checkbox
                  checked={s.done}
                  disabled={disabled || creating || Boolean(hold && !s.done)}
                  onCheckedChange={(v) => onChange(s.id, { done: v === true })}
                  aria-label={s.text}
                />
                <button type="button" onClick={() => flip(s.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className={cn("min-w-0 flex-1 text-sm", s.done && "text-muted-foreground line-through", !s.text && "italic text-muted-foreground")}>{s.text || t("pipeline.steps.untitled")}</span>
                  {hold && !s.done && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full border border-fuchsia-400/40 bg-fuchsia-400/10 px-2 py-0.5 text-[10px] text-fuchsia-300">
                      <Lock className="size-3" /> {hold.kind === "waits" ? t("pipeline.steps.waitsFor", { title: hold.title }) : t("pipeline.steps.startsOn", { date: dayLabel(hold.date) })}
                    </span>
                  )}
                  {s.priority !== "normal" && <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", PRIORITY_STYLE[s.priority].chip)}>{t(`pipeline.priority.${s.priority}`)}</span>}
                  {who && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <UserRound className="size-3" /> {who}
                    </span>
                  )}
                  {s.dueDate && (
                    <span className={cn("flex shrink-0 items-center gap-1 font-mono text-[11px]", !s.done && s.dueDate < todayYmd() ? "text-destructive" : "text-muted-foreground")}>
                      <CalendarClock className="size-3" /> {dayLabel(s.dueDate)}
                    </span>
                  )}
                  <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                </button>
              </div>
              {isOpen && (
                <div className="space-y-2 border-t px-3 py-3">
                  <StepText value={s.text} disabled={disabled} onCommit={(v) => v.trim() && v.trim() !== s.text && onChange(s.id, { text: v.trim() })} />
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    <label className="space-y-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("pipeline.priority.label")}
                      <select className={selectCls} disabled={disabled} value={s.priority} onChange={(e) => onChange(s.id, { priority: e.target.value as TaskPriority })}>
                        {PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {t(`pipeline.priority.${p}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("pipeline.itemAssignee")}
                      <select className={selectCls} disabled={disabled} value={s.assigneeId ?? ""} onChange={(e) => onChange(s.id, { assigneeId: e.target.value || null })}>
                        <option value="">{t("pipeline.itemNobody")}</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="grid gap-1.5">
                      <label className="space-y-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <CalendarClock className="size-3" /> {t("pipeline.itemDue")}
                        </span>
                        <Input type="date" className="h-8 px-2 text-xs" disabled={disabled} value={s.dueDate ?? ""} onChange={(e) => onChange(s.id, { dueDate: e.target.value || null })} />
                      </label>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="min-w-56 flex-1 space-y-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Lock className="size-3" /> {t("pipeline.steps.waits")}
                      </span>
                      <select className={selectCls} disabled={disabled} value={s.dependsOnId ?? ""} onChange={(e) => onChange(s.id, { dependsOnId: e.target.value || null })}>
                        <option value="">{t("pipeline.steps.noWait")}</option>
                        {earlier.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.text || t("pipeline.steps.untitled")}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!disabled && (
                      <button type="button" className="flex items-center gap-1 pb-1.5 text-xs text-muted-foreground hover:text-destructive" onClick={() => onRemove(s.id)}>
                        <Trash2 className="size-3.5" /> {t("common.delete")}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!disabled && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onAdd(text.trim());
            setText("");
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("pipeline.steps.add")} className="h-9" maxLength={300} />
          <Button type="submit" variant="outline" size="icon" className="size-9 shrink-0" disabled={!text.trim()} aria-label={t("pipeline.steps.add")}>
            <Plus className="size-4" />
          </Button>
        </form>
      )}
    </div>
  );
}

/** The words of a step, saved when the box is left */
function StepText({ value, disabled, onCommit }: { value: string; disabled?: boolean; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  return <Input value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => (v.trim() ? onCommit(v) : setV(value))} maxLength={300} className="h-9" />;
}
