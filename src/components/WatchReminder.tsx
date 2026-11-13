import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellRing, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type WatchKind = "ticket" | "task" | "proj";
/** The fields the lists and windows carry for the "no activity" reminder */
export type WatchFields = { stale?: boolean; watchDays?: number; watchOwn?: number | null };

/** The class a quiet row (open, nothing happened for its delay) wears: it flashes like a ticket that needs attention */
export const STALE_ROW = "animate-attention ring-1 ring-amber-400/60";

const base = (kind: WatchKind, id: string | number) => (kind === "ticket" ? `/tickets/${id}` : kind === "task" ? `/pipeline/tasks/${id}` : `/proj/${id}`);

/** Opening the item: the count of quiet days starts again (once per opening) */
export function useWatchOnOpen(kind: WatchKind, id: string | number | null | undefined, enabled = true) {
  const qc = useQueryClient();
  const done = useRef<string>("");
  useEffect(() => {
    if (!id || !enabled) return;
    const key = `${kind}:${id}`;
    if (done.current === key) return;
    done.current = key;
    void api
      .post(`${base(kind, id)}/watch/reset`, {})
      .then(() => qc.invalidateQueries({ queryKey: [kind === "ticket" ? "tickets" : kind === "task" ? "pipeline" : "proj"] }))
      .catch(() => undefined);
  }, [kind, id, enabled, qc]);
}

/**
 * The reminder of one item: a small reset button (starts the delay again) and the delay in working days, which can be set on the
 * item (empty = the default: 3 working days, 6 when the due day is more than 3 weeks away). The same rule for everyone.
 */
export function WatchReminder({ kind, id, info, canEdit, compact }: { kind: WatchKind; id: string | number; info: WatchFields; canEdit: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const days = info.watchDays ?? 3;
  const [value, setValue] = useState(info.watchOwn == null ? "" : String(info.watchOwn));
  useEffect(() => setValue(info.watchOwn == null ? "" : String(info.watchOwn)), [info.watchOwn]);
  const refresh = () => void qc.invalidateQueries();
  const reset = useMutation({
    mutationFn: () => api.post(`${base(kind, id)}/watch/reset`, {}),
    onSuccess: () => {
      toast.success(t("watch.resetDone"));
      refresh();
    },
    onError: () => toast.error(t("common.error")),
  });
  const save = useMutation({
    mutationFn: (d: number | null) => api.put(`${base(kind, id)}/watch`, { days: d }),
    onSuccess: refresh,
    onError: () => toast.error(t("common.error")),
  });
  const commit = () => {
    const n = value.trim() === "" ? null : Math.round(Number(value));
    if (n !== null && (!Number.isFinite(n) || n < 1 || n > 60)) return setValue(info.watchOwn == null ? "" : String(info.watchOwn));
    if (n !== (info.watchOwn ?? null)) save.mutate(n);
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs", info.stale && "text-amber-300")} role="group" aria-label={t("watch.title")}>
      <BellRing className={cn("size-3.5", info.stale && "animate-attention")} aria-hidden />
      {!compact && <span>{info.stale ? t("watch.quiet", { count: days }) : t("watch.every", { count: days })}</span>}
      {canEdit && (
        <label className="inline-flex items-center gap-1">
          <span className="sr-only">{t("watch.days")}</span>
          <input
            value={value}
            inputMode="numeric"
            placeholder={String(days)}
            title={t("watch.daysHint")}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 2))}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="h-6 w-9 rounded border bg-transparent px-1 text-center text-xs"
          />
          <span className="text-muted-foreground">{t("watch.daysUnit")}</span>
        </label>
      )}
      <button
        type="button"
        onClick={() => reset.mutate()}
        disabled={reset.isPending}
        title={t("watch.resetHint")}
        className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-white/5"
      >
        <RotateCcw className="size-3" aria-hidden /> {t("watch.reset")}
      </button>
    </div>
  );
}
