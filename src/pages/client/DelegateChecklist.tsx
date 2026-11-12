import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Pane } from "./ui";
import { DELEGATE_API, type DelegateChecklistItem, useDelegateError } from "./delegateShared";

/** The steps of the ticket: add, tick, rename in place, delete. Every change reloads the ticket. */
export function ChecklistCard({ ticketId, items, onChanged }: { ticketId: number; items: DelegateChecklistItem[]; onChanged: () => void }) {
  const { t } = useTranslation();
  const errorText = useDelegateError();
  const [text, setText] = useState("");
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const fail = (e: unknown) => toast.error(errorText(e));

  const add = useMutation({
    mutationFn: (value: string) => api.post(`${DELEGATE_API}/tickets/${ticketId}/checklist`, { text: value }),
    onSuccess: () => {
      setText("");
      onChanged();
    },
    onError: (e) => {
      fail(e);
      onChanged();
    },
  });
  const patch = useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: { text?: string; done?: boolean } }) =>
      api.patch(`${DELEGATE_API}/tickets/${ticketId}/checklist/${itemId}`, body),
    onSuccess: onChanged,
    onError: (e) => {
      fail(e);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: (itemId: string) => api.del(`${DELEGATE_API}/tickets/${ticketId}/checklist/${itemId}`),
    onSuccess: onChanged,
    onError: (e) => {
      fail(e);
      onChanged();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (value && !add.isPending) add.mutate(value);
  };

  return (
    <Pane className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("selfManaged.delegate.ticket.checklist.title")}</h3>
        {items.length > 0 && <span className="text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.checklist.progress", { done, total: items.length })}</span>}
      </div>

      {items.length > 0 && (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
          <div className="h-full rounded-full bg-[color:var(--gold)] transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      )}

      {items.length === 0 && <p className="text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.checklist.empty")}</p>}

      {items.length > 0 && (
        <ul className="space-y-0.5">
          {items.map((i) => (
            <ChecklistRow
              key={i.id}
              item={i}
              onToggle={() => patch.mutate({ itemId: i.id, body: { done: !i.done } })}
              onRename={(value) => patch.mutate({ itemId: i.id, body: { text: value } })}
              onDelete={() => remove.mutate(i.id)}
            />
          ))}
        </ul>
      )}

      <form className="flex items-center gap-2" onSubmit={submit}>
        <Input
          value={text}
          maxLength={200}
          placeholder={t("selfManaged.delegate.ticket.checklist.placeholder")}
          aria-label={t("selfManaged.delegate.ticket.checklist.placeholder")}
          onChange={(e) => setText(e.target.value)}
          className="h-9"
        />
        <Button type="submit" size="sm" variant="outline" className="h-9 gap-1.5" disabled={!text.trim() || add.isPending}>
          <Plus className="size-3.5" aria-hidden />
          {t("selfManaged.delegate.ticket.checklist.add")}
        </Button>
      </form>
    </Pane>
  );
}

function ChecklistRow({
  item,
  onToggle,
  onRename,
  onDelete,
}: {
  item: DelegateChecklistItem;
  onToggle: () => void;
  onRename: (text: string) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  const start = () => {
    setDraft(item.text);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== item.text) onRename(next);
  };

  return (
    <li className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-foreground/[0.03]">
      <button
        type="button"
        role="checkbox"
        aria-checked={item.done}
        aria-label={t("selfManaged.delegate.ticket.checklist.toggle", { text: item.text })}
        onClick={onToggle}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors",
          item.done ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : "border-[color:var(--glass-border)] hover:border-[color:var(--gold)]/60",
        )}
      >
        {item.done && <Check className="size-3.5" aria-hidden />}
      </button>

      {editing ? (
        <Input
          autoFocus
          value={draft}
          maxLength={200}
          aria-label={t("selfManaged.delegate.ticket.checklist.rename")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-8 flex-1"
        />
      ) : (
        <button
          type="button"
          onDoubleClick={start}
          className={cn("min-w-0 flex-1 truncate rounded-md text-left text-sm", item.done && "text-muted-foreground line-through")}
        >
          {item.text}
        </button>
      )}

      {!editing && (
        <>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={start} aria-label={t("selfManaged.delegate.ticket.checklist.rename")} title={t("selfManaged.delegate.ticket.checklist.rename")}>
            <Pencil className="size-3.5" aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground hover:text-destructive" onClick={onDelete} aria-label={t("selfManaged.delegate.ticket.checklist.delete")} title={t("selfManaged.delegate.ticket.checklist.delete")}>
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </>
      )}
    </li>
  );
}
