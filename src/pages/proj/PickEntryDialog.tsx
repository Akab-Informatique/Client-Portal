import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AiTextarea } from "@/components/AiPolish";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { hm, parseHm } from "@shared/duration";
import type { ProjDetail, ProjTask, ProjTimeEntry } from "./shared";
import { projError, todayYmd } from "./ProjComposer";

/**
 * Ticking a task done asks in which time entry it was done: one of my entries on this project (last 45 days),
 * a new entry, or no time at all (the quiet link).
 */
export function PickEntryDialog({ project, task, onClose }: { project: ProjDetail; task: ProjTask; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const canTime = can("timesheets.use");
  const lang = i18n.language === "en" ? "en-CA" : "fr-CA";

  const mine = useQuery({
    queryKey: ["proj", "time", "mine", project.id],
    queryFn: () => api.get<ProjTimeEntry[]>(`/proj/${project.id}/time/mine`),
    enabled: canTime,
    staleTime: 10_000,
  });
  const entries = mine.data ?? [];

  // the most recent entry is chosen first; "new" when there is none
  const [choice, setChoice] = useState<string | null>(null);
  const selected = choice ?? (entries[0]?.id ?? "new");
  const [date, setDate] = useState(todayYmd());
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const parsed = parseHm(hours);
  const newOk = canTime && parsed !== null && parsed > 0 && parsed <= 24;

  const finish = useMutation({
    mutationFn: async (how: "entry" | "new" | "none") => {
      if (how === "entry") return api.patch(`/proj/${project.id}/tasks/${task.id}`, { status: "done", entryId: selected });
      if (how === "new") return api.post(`/proj/${project.id}/time`, { date, hours: parsed, note: note.trim(), taskIds: [task.id], doneTaskIds: [task.id] });
      return api.patch(`/proj/${project.id}/tasks/${task.id}`, { status: "done" });
    },
    onSuccess: () => {
      toast.success(t("projWork.pick.done"));
      void qc.invalidateQueries({ queryKey: ["proj"] });
      onClose();
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const submit = () => {
    if (selected === "new") {
      if (!newOk) return toast.error(t("projWork.composer.hoursInvalid"));
      return finish.mutate("new");
    }
    finish.mutate("entry");
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("projWork.pick.title")}</DialogTitle>
          <DialogDescription>{t("projWork.pick.description")}</DialogDescription>
        </DialogHeader>

        <p className="truncate text-sm font-medium">{task.title}</p>

        {!canTime ? (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">{t("projWork.pick.noTimeRight")}</p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">{t("projWork.pick.mine")}</legend>
            {mine.isLoading ? null : entries.length === 0 ? <p className="text-sm text-muted-foreground">{t("projWork.pick.none")}</p> : null}
            {entries.map((e) => (
              <label
                key={e.id}
                className={cn("flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 text-sm transition-colors", selected === e.id ? "border-violet-400/60 bg-violet-500/10" : "border-border hover:bg-accent/40")}
              >
                <input type="radio" name={`pick-${task.id}`} value={e.id} checked={selected === e.id} onChange={() => setChoice(e.id)} className="mt-1 accent-violet-500" />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium">{formatDay(e.date, lang)}</span>
                    <span className="font-mono text-violet-200">{hm(e.hours)}</span>
                  </span>
                  {e.note && <span className="block truncate text-xs text-muted-foreground">{e.note}</span>}
                </span>
              </label>
            ))}

            <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 text-sm transition-colors", selected === "new" ? "border-violet-400/60 bg-violet-500/10" : "border-border hover:bg-accent/40")}>
              <input type="radio" name={`pick-${task.id}`} value="new" checked={selected === "new"} onChange={() => setChoice("new")} className="mt-1 accent-violet-500" />
              <span className="font-medium">{t("projWork.pick.newEntry")}</span>
            </label>

            {selected === "new" && (
              <div className="space-y-3 rounded-xl border border-dashed border-violet-400/40 p-3">
                <p className="text-xs text-muted-foreground">{t("projWork.pick.newHint")}</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">{t("projWork.composer.date")}</span>
                    <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 w-full rounded-md border bg-background/60 px-2 text-sm" />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">{t("projWork.composer.hours")}</span>
                    <input
                      value={hours}
                      onChange={(e) => setHours(e.target.value)}
                      placeholder={t("projWork.composer.hoursHint")}
                      inputMode="numeric"
                      aria-invalid={hours.trim() !== "" && !newOk}
                      className={cn("h-9 w-full rounded-md border bg-background/60 px-2 font-mono text-sm", hours.trim() !== "" && !newOk && "border-destructive")}
                    />
                  </label>
                </div>
                <AiTextarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("projWork.pick.note")} aria-label={t("projWork.pick.note")} />
              </div>
            )}
          </fieldset>
        )}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" onClick={() => finish.mutate("none")} disabled={finish.isPending} className="self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {t("projWork.pick.withoutTime")}
          </button>
          {canTime && (
            <Button type="button" onClick={submit} disabled={finish.isPending || (selected === "new" && !newOk)} className="bg-violet-600 hover:bg-violet-500">
              {selected === "new" ? t("projWork.pick.confirmNew") : t("projWork.pick.confirm")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatDay(ymd: string, lang: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short" }).format(d);
}
