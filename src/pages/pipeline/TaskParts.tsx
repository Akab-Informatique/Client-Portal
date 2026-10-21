import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Download, Eye, EyeOff, Lock, Paperclip, Repeat, Trash2, Upload, Users, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { MAX_FILE, WEEKDAYS, fileSize, type Person, type Recurrence, type Visibility } from "./shared";

const selectCls = "h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40";

/** Every n days / weeks (on chosen weekdays) / months / years, until a day */
export function RecurrenceEditor({ value, onChange, disabled }: { value: Recurrence | null; onChange: (r: Recurrence | null) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const freq = value?.freq ?? "none";
  const set = (patch: Partial<Recurrence>) => value && onChange({ ...value, ...patch });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Repeat className="size-3.5 shrink-0 text-muted-foreground" />
        <select
          className={selectCls}
          disabled={disabled}
          value={freq}
          onChange={(e) => (e.target.value === "none" ? onChange(null) : onChange({ freq: e.target.value as Recurrence["freq"], interval: value?.interval ?? 1, weekdays: e.target.value === "weekly" ? (value?.weekdays ?? []) : undefined, until: value?.until ?? null }))}
        >
          <option value="none">{t("pipeline.repeat.none")}</option>
          {(["daily", "weekly", "monthly", "yearly"] as const).map((f) => (
            <option key={f} value={f}>
              {t(`pipeline.repeat.${f}`)}
            </option>
          ))}
        </select>
      </div>
      {value && (
        <div className="space-y-2 rounded-lg border bg-background/40 p-2.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("pipeline.repeat.every")}
            <Input type="number" min={1} max={365} disabled={disabled} value={value.interval} onChange={(e) => set({ interval: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })} className="h-8 w-16 text-foreground" />
            {t(`pipeline.repeat.unit.${value.freq}`, { count: value.interval })}
          </div>
          {value.freq === "weekly" && (
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((d) => {
                const on = value.weekdays?.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={disabled}
                    onClick={() => set({ weekdays: on ? (value.weekdays ?? []).filter((x) => x !== d) : [...(value.weekdays ?? []), d].sort() })}
                    className={cn("size-8 rounded-full border text-[11px] font-medium transition-colors", on ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:bg-accent/50")}
                    aria-pressed={on}
                  >
                    {t(`pipeline.repeat.day.${d}`)}
                  </button>
                );
              })}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("pipeline.repeat.until")}
            <Input type="date" disabled={disabled} value={value.until ?? ""} onChange={(e) => set({ until: e.target.value || null })} className="h-8 w-40 text-foreground" />
          </label>
          <p className="text-[11px] text-muted-foreground">{t("pipeline.repeat.hint")}</p>
        </div>
      )}
    </div>
  );
}

/** Who can see the task: the team, only the one who made it and the one who has it, or people chosen */
export function VisibilityEditor({ value, viewerIds, people, meId, onChange, disabled }: { value: Visibility; viewerIds: string[]; people: Person[]; meId: string; onChange: (v: Visibility, viewers: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const options = [
    ["team", Users],
    ["private", Lock],
    ["selected", Eye],
  ] as const;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1">
        {options.map(([k, Icon]) => (
          <button
            key={k}
            type="button"
            disabled={disabled}
            onClick={() => k !== value && onChange(k, viewerIds)}
            className={cn("flex flex-col items-center gap-0.5 rounded-md border px-1 py-1.5 text-[11px] font-medium transition-colors", value === k ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/15 text-primary" : "border-transparent text-muted-foreground hover:bg-accent/50")}
          >
            <Icon className="size-3.5" /> {t(`pipeline.visibility.${k}`)}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{t(`pipeline.visibility.${value}Hint`)}</p>
      {value === "selected" && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border bg-background/40 p-1.5">
          {people
            .filter((p) => p.id !== meId)
            .map((p) => (
              <li key={p.id}>
                <label className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/30">
                  <Checkbox disabled={disabled} checked={viewerIds.includes(p.id)} onCheckedChange={(v) => onChange(value, v === true ? [...viewerIds, p.id] : viewerIds.filter((x) => x !== p.id))} />
                  {p.name}
                </label>
              </li>
            ))}
        </ul>
      )}
      {value !== "team" && (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <EyeOff className="size-3" /> {t("pipeline.visibility.managers")}
        </p>
      )}
    </div>
  );
}

export function TagsEditor({ value, onChange, disabled }: { value: string[]; onChange: (t: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const add = () => {
    const v = text.trim().replace(/,$/, "").slice(0, 30);
    setText("");
    if (v && !value.includes(v) && value.length < 8) onChange([...value, v]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5">
      {value.map((tag) => (
        <span key={tag} className="flex items-center gap-1 rounded-full bg-[color:var(--gold)]/12 px-2 py-0.5 text-[11px] text-primary">
          {tag}
          {!disabled && (
            <button type="button" onClick={() => onChange(value.filter((x) => x !== tag))} aria-label={t("common.delete")}>
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={value.length ? "" : t("pipeline.tagsPlaceholder")}
          className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          maxLength={30}
        />
      )}
    </div>
  );
}

type Stored = { id: string; name: string; size: number; by?: string | null };

/**
 * Files on a task: the ones stored (download, remove) and a drop zone. `onAdd` gets each new file (a task that
 * exists uploads it at once; a new task keeps them until it is created).
 */
export function FilesBox({ stored, staged, onAdd, onRemoveStaged, onRemove, downloadUrl, disabled }: { stored?: Stored[]; staged?: File[]; onAdd: (f: File) => void; onRemoveStaged?: (f: File) => void; onRemove?: (id: string) => void; downloadUrl?: (id: string) => string; disabled?: boolean }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (list: FileList | null) => {
    for (const f of Array.from(list ?? [])) {
      if (f.size > MAX_FILE) toast.error(t("pipeline.files.tooBig", { name: f.name }));
      else onAdd(f);
    }
  };
  return (
    <div className="space-y-2">
      {(stored?.length || staged?.length) ? (
        <ul className="space-y-1">
          {(stored ?? []).map((f) => (
            <li key={f.id} className="group flex items-center gap-2 rounded-lg border bg-background/40 px-2.5 py-1.5 text-sm">
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{fileSize(f.size)}</span>
              {downloadUrl && (
                <a href={downloadUrl(f.id)} className="text-muted-foreground hover:text-primary" aria-label={t("pipeline.files.download")} download>
                  <Download className="size-3.5" />
                </a>
              )}
              {!disabled && onRemove && (
                <button type="button" onClick={() => onRemove(f.id)} className="text-muted-foreground hover:text-destructive" aria-label={t("common.delete")}>
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
          {(staged ?? []).map((f) => (
            <li key={`${f.name}${f.size}`} className="flex items-center gap-2 rounded-lg border border-dashed bg-background/40 px-2.5 py-1.5 text-sm">
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{fileSize(f.size)}</span>
              {onRemoveStaged && (
                <button type="button" onClick={() => onRemoveStaged(f)} className="text-muted-foreground hover:text-destructive" aria-label={t("common.delete")}>
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {!disabled && (
        <div
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            take(e.dataTransfer.files);
          }}
          onClick={() => input.current?.click()}
          className={cn("flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground transition-colors hover:border-[color:var(--gold)]/50 hover:text-foreground", over && "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/[0.06]")}
        >
          <Upload className="size-4" /> {t("pipeline.files.drop")}
          <input
            ref={input}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              take(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}
