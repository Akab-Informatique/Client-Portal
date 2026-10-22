import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ChevronDown, CornerDownRight, ListChecks, Loader2, Lock, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ticketErrorText, type ChecklistItem, type TicketDetail } from "./shared";

/**
 * The checklist of a ticket: tasks to complete before the ticket can be. An item may wait for another one (it
 * cannot be ticked before). Shown above the activity, folded away or open as the person likes; open by itself
 * while something is left to do.
 */
export function ChecklistCard({ tk, editable }: { tk: TicketDetail; editable: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const items = tk.checklist ?? [];
  const left = items.filter((x) => !x.done).length;
  const done = items.length - left;
  // open while something is left to do; a choice made here stays
  const [adding, setAdding] = useState(false);
  const [openChoice, setOpenChoice] = useState<boolean | null>(null);
  const open = openChoice ?? (left > 0 || adding);
  const [text, setText] = useState("");
  const [after, setAfter] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tickets", "detail", tk.id] });
    void qc.invalidateQueries({ queryKey: ["tickets"], exact: false });
  };
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (e) => {
      toast.error(ticketErrorText(t, e));
      refresh();
    },
  });
  const base = `/tickets/${tk.id}/checklist`;
  const add = () => {
    const v = text.trim();
    if (!v) return;
    run.mutate(() => api.post(base, { text: v, dependsOnId: after || null }));
    setText("");
    setAfter("");
  };
  if (!editable && items.length === 0) return null;
  // nothing yet: a quiet line to start one
  if (items.length === 0 && !adding) {
    return (
      <button type="button" onClick={() => setAdding(true)} className="flex w-full shrink-0 items-center gap-2 rounded-xl border border-dashed px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-[color:var(--gold)]/50 hover:text-foreground">
        <ListChecks className="size-4 text-primary" /> {t("tickets.checklist.start")}
        <Plus className="ml-auto size-4" />
      </button>
    );
  }
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  return (
    <section className="glass shrink-0 overflow-hidden rounded-2xl border" aria-label={t("tickets.checklist.title")}>
      <button type="button" onClick={() => setOpenChoice(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-2.5 text-left">
        <ListChecks className="size-4 shrink-0 text-primary" />
        <span className="text-sm font-semibold">{t("tickets.checklist.title")}</span>
        {items.length > 0 && (
          <>
            <span className={cn("rounded-full border px-2 py-0.5 font-mono text-[11px]", left === 0 ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary")}>
              {done}/{items.length}
            </span>
            <span className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-muted sm:block" aria-hidden>
              <span className={cn("block h-full rounded-full transition-all", left === 0 ? "bg-emerald-400" : "bg-grad-gold")} style={{ width: `${pct}%` }} />
            </span>
          </>
        )}
        {left > 0 && <span className="hidden text-[11px] text-muted-foreground md:inline">{t("tickets.checklist.blocksClose", { count: left })}</span>}
        <ChevronDown className={cn("ml-auto size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="space-y-2 border-t px-4 py-3">
          {items.length > 0 && (
            <ul className="space-y-1">
              {items.map((it, i) => (
                <Row key={it.id} it={it} items={items} first={i === 0} last={i === items.length - 1} editable={editable} busy={run.isPending} onPatch={(p) => run.mutate(() => api.patch(`${base}/${it.id}`, p))} onDelete={() => run.mutate(() => api.del(`${base}/${it.id}`))} onMove={(dir) => {
                  const ids = items.map((x) => x.id);
                  const j = i + dir;
                  [ids[i], ids[j]] = [ids[j], ids[i]];
                  run.mutate(() => api.post(`${base}/reorder`, { ids }));
                }} />
              ))}
            </ul>
          )}
          {editable && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder={t("tickets.checklist.add")} aria-label={t("tickets.checklist.add")} className="h-8 min-w-48 flex-1 text-sm" autoFocus={adding && items.length === 0} />
              {items.length > 0 && (
                <select value={after} onChange={(e) => setAfter(e.target.value)} aria-label={t("tickets.checklist.after")} className="h-8 max-w-56 rounded-md border bg-transparent px-2 text-xs text-muted-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
                  <option value="">{t("tickets.checklist.noDependency")}</option>
                  {items.map((x) => (
                    <option key={x.id} value={x.id}>
                      {t("tickets.checklist.afterItem", { text: x.text.slice(0, 40) })}
                    </option>
                  ))}
                </select>
              )}
              <Button type="submit" size="sm" variant="outline" disabled={!text.trim() || run.isPending} className="h-8">
                {run.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} {t("tickets.checklist.addButton")}
              </Button>
            </form>
          )}
          {left > 0 && <p className="text-[11px] text-muted-foreground">{t("tickets.checklist.rule")}</p>}
        </div>
      )}
    </section>
  );
}

function Row({
  it,
  items,
  first,
  last,
  editable,
  busy,
  onPatch,
  onDelete,
  onMove,
}: {
  it: ChecklistItem;
  items: ChecklistItem[];
  first: boolean;
  last: boolean;
  editable: boolean;
  busy: boolean;
  onPatch: (p: { text?: string; done?: boolean; dependsOnId?: string | null }) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(it.text);
  const dep = it.dependsOnId ? items.find((x) => x.id === it.dependsOnId) : null;
  const blocked = Boolean(it.blockedBy);
  const save = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== it.text) onPatch({ text: v });
    else setDraft(it.text);
  };
  return (
    <li className={cn("group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 hover:bg-accent/30", blocked && "opacity-80")}>
      <Checkbox checked={it.done} disabled={!editable || busy || (blocked && !it.done)} onCheckedChange={(v) => onPatch({ done: v === true })} aria-label={it.text} title={blocked ? t("tickets.checklist.waiting", { text: it.blockedBy!.text }) : undefined} />
      {editing ? (
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" ? (setDraft(it.text), setEditing(false)) : undefined)} maxLength={300} autoFocus className="h-7 min-w-48 flex-1 text-sm" />
      ) : (
        <span
          onDoubleClick={() => editable && setEditing(true)}
          className={cn("min-w-0 flex-1 break-words text-sm", it.done && "text-muted-foreground line-through", editable && "cursor-text")}
          title={editable ? t("tickets.checklist.editHint") : undefined}
        >
          {it.text}
        </span>
      )}
      {blocked ? (
        <span className="flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200" title={t("tickets.checklist.waiting", { text: it.blockedBy!.text })}>
          <Lock className="size-3" /> {t("tickets.checklist.afterItem", { text: it.blockedBy!.text.slice(0, 28) })}
        </span>
      ) : dep ? (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <CornerDownRight className="size-3" /> {t("tickets.checklist.afterItem", { text: dep.text.slice(0, 28) })}
        </span>
      ) : null}
      {it.done && it.doneBy && <span className="hidden text-[10px] text-muted-foreground md:inline">{t("tickets.checklist.doneBy", { name: it.doneBy })}</span>}
      {editable && (
        <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <select
            value={it.dependsOnId ?? ""}
            onChange={(e) => onPatch({ dependsOnId: e.target.value || null })}
            aria-label={t("tickets.checklist.after")}
            className="h-6 max-w-32 rounded border bg-transparent px-1 text-[10px] text-muted-foreground outline-none"
          >
            <option value="">{t("tickets.checklist.noDependency")}</option>
            {items
              .filter((x) => x.id !== it.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {t("tickets.checklist.afterItem", { text: x.text.slice(0, 30) })}
                </option>
              ))}
          </select>
          <button type="button" disabled={first || busy} onClick={() => onMove(-1)} aria-label={t("tickets.checklist.up")} className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">
            <ArrowUp className="size-3" />
          </button>
          <button type="button" disabled={last || busy} onClick={() => onMove(1)} aria-label={t("tickets.checklist.down")} className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">
            <ArrowDown className="size-3" />
          </button>
          <button type="button" disabled={busy} onClick={onDelete} aria-label={t("tickets.checklist.delete")} className="rounded p-1 text-muted-foreground hover:text-destructive">
            <Trash2 className="size-3" />
          </button>
        </span>
      )}
    </li>
  );
}

/** The checklist typed while making a ticket: items in order, each optionally after an EARLIER one. */
export type DraftItem = { text: string; dependsOn: number | null };
export function ChecklistField({ value, onChange }: { value: DraftItem[]; onChange: (v: DraftItem[]) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [after, setAfter] = useState("");
  const add = () => {
    const v = text.trim();
    if (!v) return;
    onChange([...value, { text: v, dependsOn: after === "" ? null : Number(after) }]);
    setText("");
    setAfter("");
  };
  // removing an item: the ones after it renumber, and anything that waited for it is freed
  const remove = (i: number) =>
    onChange(
      value
        .filter((_, k) => k !== i)
        .map((x) => ({ ...x, dependsOn: x.dependsOn == null || x.dependsOn === i ? null : x.dependsOn > i ? x.dependsOn - 1 : x.dependsOn })),
    );
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="space-y-1 rounded-xl border p-2">
          {value.map((x, i) => (
            <li key={i} className="flex items-center gap-2 text-sm">
              <span className="font-mono text-[10px] text-muted-foreground">{i + 1}.</span>
              <span className="min-w-0 flex-1 break-words">{x.text}</span>
              {x.dependsOn != null && (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <CornerDownRight className="size-3" /> {t("tickets.checklist.afterItem", { text: value[x.dependsOn]?.text.slice(0, 24) ?? "" })}
                </span>
              )}
              <button type="button" onClick={() => remove(i)} aria-label={t("tickets.checklist.delete")} className="rounded p-1 text-muted-foreground hover:text-destructive">
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds the item, not the whole ticket
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          maxLength={300}
          placeholder={t("tickets.checklist.add")}
          aria-label={t("tickets.checklist.add")}
          className="h-9 min-w-48 flex-1"
        />
        {value.length > 0 && (
          <select value={after} onChange={(e) => setAfter(e.target.value)} aria-label={t("tickets.checklist.after")} className="h-9 max-w-56 rounded-md border bg-transparent px-2 text-xs text-muted-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
            <option value="">{t("tickets.checklist.noDependency")}</option>
            {value.map((x, i) => (
              <option key={i} value={i}>
                {t("tickets.checklist.afterItem", { text: x.text.slice(0, 40) })}
              </option>
            ))}
          </select>
        )}
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={!text.trim()}>
          <Plus className="size-3.5" /> {t("tickets.checklist.addButton")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("tickets.checklist.newHint")}</p>
    </div>
  );
}
