import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PRIORITY_STYLE, hm, type DayData } from "./shared";

type Row = { key: string; kind: "ticket" | "task" | "ptask"; projectId?: string; refId: string; title: string; ticketNumber?: string | null; priority: string; given: number; need: number; overflow: boolean; manual: boolean };

/**
 * The time given to each item of the day, in the order of the grid: one slider per ticket or task, in quarter hours.
 * Giving less than what an item needs is fine (some time goes in, the checkpoint is moved later when it is done).
 * The grid is laid out again at each change, so one sees at once whether everything fits.
 */
export function TimeShare({ data, canEdit, forUser, onOpen, onSaved }: { data: DayData; canEdit: boolean; forUser?: string; onOpen: (kind: "ticket" | "task" | "ptask", id: string, projectId?: string) => void; onSaved: () => void }) {
  const { t } = useTranslation();
  // the items in the order of the grid (the first block of each), then the ones that did not fit
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const b of [...data.plan.blocks.filter((x) => !x.overflow), ...data.plan.blocks.filter((x) => x.overflow)]) {
    if ((b.kind !== "ticket" && b.kind !== "task" && b.kind !== "ptask") || !b.refId || b.done) continue;
    const key = `${b.kind}:${b.refId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = data.items.find((i) => i.key === key);
    if (!item) continue;
    rows.push({ key, kind: b.kind, projectId: b.projectId, refId: b.refId, title: item.masked ? "" : item.title, ticketNumber: item.ticketNumber, priority: item.priority, given: b.allocated ?? item.minutes, need: b.need ?? item.minutes, overflow: Boolean(b.overflow), manual: data.allocations[key]?.source === "manual" });
  }
  if (!rows.length) return null;
  const total = rows.reduce((n, r) => n + r.given, 0);
  const cap = data.plan.capacityMinutes;
  const over = Math.max(0, total - cap);
  return (
    <div className="mt-4 space-y-2 border-t border-[color:var(--glass-border)] pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("pipeline.day.share.title")}</h4>
        <span className={cn("font-mono text-[11px]", over ? "text-orange-300" : "text-emerald-300")}>
          {hm(total)} / {hm(cap)} {over ? t("pipeline.day.share.over", { time: hm(over) }) : t("pipeline.day.share.fits")}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", over ? "bg-orange-400" : "bg-emerald-400")} style={{ width: `${cap > 0 ? Math.min(100, (total / cap) * 100) : 100}%` }} />
      </div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <ShareRow key={r.key} r={r} date={data.date} canEdit={canEdit && !data.items.find((i) => i.key === r.key)?.masked} forUser={forUser} onOpen={onOpen} onSaved={onSaved} />
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">{t("pipeline.day.share.hint")}</p>
    </div>
  );
}

function ShareRow({ r, date, canEdit, forUser, onOpen, onSaved }: { r: Row; date: string; canEdit: boolean; forUser?: string; onOpen: (kind: "ticket" | "task" | "ptask", id: string, projectId?: string) => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(r.given);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragging = useRef(false);
  // follow the server (a replan, another change) unless the slider is being moved
  useEffect(() => {
    if (!dragging.current) setValue(r.given);
  }, [r.given]);
  const save = useMutation({
    mutationFn: (minutes: number | null) => api.put("/pipeline/day/alloc", { date, key: r.key, minutes, ...(forUser ? { userId: forUser } : {}) }),
    onSuccess: onSaved,
    onError: () => toast.error(t("common.error")),
  });
  const commit = (m: number | null) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(m), 350);
  };
  const partial = value < r.need;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-lg px-1.5 py-1 hover:bg-muted/30 sm:grid-cols-[minmax(0,1.2fr)_minmax(120px,1fr)_auto]">
      <button type="button" onClick={() => onOpen(r.kind, r.refId, r.projectId)} className="flex min-w-0 items-baseline gap-2 text-left">
        <span className={cn("size-2 shrink-0 translate-y-px rounded-full", PRIORITY_STYLE[r.priority as keyof typeof PRIORITY_STYLE]?.dot)} />
        {r.kind === "ptask" && <span className="shrink-0 rounded-full bg-teal-400/15 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-teal-300">{t("pipeline.day.share.project")}</span>}
        {r.ticketNumber && <span className={cn("shrink-0 font-mono text-[11px]", r.kind === "ptask" ? "text-teal-300" : "text-primary")}>{r.ticketNumber}</span>}
        <span className={cn("truncate text-[13px]", r.overflow && "text-muted-foreground")}>{r.title || t("pipeline.private")}</span>
      </button>
      <input
        type="range"
        min={15}
        max={480}
        step={15}
        value={value}
        disabled={!canEdit}
        aria-label={t("pipeline.day.share.slider", { title: r.title })}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onChange={(e) => {
          setValue(Number(e.target.value));
          commit(Number(e.target.value));
        }}
        className="order-last col-span-2 h-1.5 w-full cursor-pointer accent-[color:var(--gold)] disabled:cursor-default disabled:opacity-50 sm:order-none sm:col-span-1"
      />
      <span className="flex items-center justify-end gap-1.5 font-mono text-[11px]">
        <span className={cn(partial ? "text-orange-300" : "text-foreground")}>{hm(value)}</span>
        {partial && (
          <span className="text-muted-foreground" title={t("pipeline.day.share.needs")}>
            / {hm(r.need)}
          </span>
        )}
        {r.manual && canEdit && (
          <button type="button" onClick={() => commit(null)} className="text-muted-foreground hover:text-foreground" title={t("pipeline.day.share.auto")} aria-label={t("pipeline.day.share.auto")}>
            <RotateCcw className="size-3" />
          </button>
        )}
      </span>
    </li>
  );
}
