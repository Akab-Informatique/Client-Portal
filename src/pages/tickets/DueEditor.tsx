import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");
/** An instant as local date and time fields */
const split = (iso: string) => {
  const d = new Date(iso);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
};
const join = (date: string, time: string) => new Date(`${date}T${time || "17:00"}:00`).toISOString();
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};
/** The coming Monday (next week's, on a Monday) */
const nextMonday = () => {
  const d = new Date();
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return d;
};

/** ✓ (save) and ✗ (cancel), placed right under the fields being changed */
export function ConfirmRow({ onSave, onCancel, saving, disabled }: { onSave: () => void; onCancel: () => void; saving?: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end gap-1.5 border-t pt-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={saving}
        title={t("common.cancel")}
        aria-label={t("common.cancel")}
        className="flex h-7 w-7 items-center justify-center rounded-full border bg-background/60 text-muted-foreground hover:text-destructive"
      >
        <X className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving || disabled}
        title={t("common.save")}
        aria-label={t("common.save")}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
      </button>
    </div>
  );
}

/**
 * A ticket's due date and time: change the day or the time (saved when the
 * day is picked, or when the time field is left), and quick choices.
 * With `onCancel`, nothing is saved until ✓ (✗ drops the change).
 */
export function DueEditor({
  dueAt,
  onSave,
  onCancel,
  saving,
  quick,
  autoFocus,
}: {
  dueAt: string;
  onSave: (iso: string) => void;
  onCancel?: () => void;
  saving?: boolean;
  quick?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [v, setV] = useState(() => split(dueAt));
  useEffect(() => setV(split(dueAt)), [dueAt]);
  const confirmMode = Boolean(onCancel);
  const commit = (date: string, time: string) => {
    if (!date) return;
    const iso = join(date, time);
    // compared to the minute: the fields have no seconds, so leaving them unchanged saves nothing
    if (Math.floor(new Date(iso).getTime() / 60_000) !== Math.floor(new Date(dueAt).getTime() / 60_000)) onSave(iso);
    else onCancel?.();
  };
  // in the ✓ / ✗ mode the fields only change the draft
  const save = (date: string, time: string) => !confirmMode && commit(date, time);
  const picks: [string, Date][] = [
    [t("tickets.due.today"), new Date()],
    [t("tickets.due.tomorrow"), plusDays(1)],
    [t("tickets.due.monday"), nextMonday()],
    [t("tickets.due.week"), plusDays(7)],
  ];
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          type="date"
          className="h-8 min-w-0 flex-1"
          value={v.date}
          autoFocus={autoFocus}
          disabled={saving}
          aria-label={t("tickets.due.date")}
          onChange={(e) => {
            setV({ ...v, date: e.target.value });
            save(e.target.value, v.time);
          }}
        />
        <Input
          type="time"
          className="h-8 w-32 shrink-0"
          value={v.time}
          disabled={saving}
          aria-label={t("tickets.due.time")}
          onChange={(e) => setV({ ...v, time: e.target.value })}
          onBlur={() => save(v.date, v.time)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (confirmMode) commit(v.date, v.time);
              else save(v.date, v.time);
            }
          }}
        />
      </div>
      {quick && (
        <div className="flex flex-wrap gap-1">
          {picks.map(([label, d]) => (
            <button
              key={label}
              type="button"
              disabled={saving}
              onClick={() => {
                const date = ymd(d);
                setV({ ...v, date });
                save(date, v.time);
              }}
              className={cn("rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground", v.date === ymd(d) && "border-[color:var(--gold)]/60 text-foreground")}
            >
              {label}
            </button>
          ))}
          {["09:00", "12:00", "17:00"].map((time) => (
            <button
              key={time}
              type="button"
              disabled={saving}
              onClick={() => {
                setV({ ...v, time });
                save(v.date, time);
              }}
              className={cn("rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground", v.time === time && "border-[color:var(--gold)]/60 text-foreground")}
            >
              {time}
            </button>
          ))}
        </div>
      )}
      {onCancel && <ConfirmRow saving={saving} disabled={!v.date} onSave={() => commit(v.date, v.time)} onCancel={onCancel} />}
    </div>
  );
}
