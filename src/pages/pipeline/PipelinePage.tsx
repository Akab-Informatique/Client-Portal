import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarCheck, Loader2, MessageSquareText, Plus, Settings2, Sparkles, Users, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { MyDay } from "./MyDay";
import { TaskDialog } from "./TaskDialog";
import { TeamList } from "./TeamList";

type Tab = "day" | "team";
type Settings = { auto: boolean; time: string; sms: boolean; workStart: string; workEnd: string; lunchStart: string; lunchEnd: string };

/**
 * Pipeline: the team's to-do list and each technician's day. "Ma journée" is the dashboard (the AI's summary of
 * the day, the hours laid out as a suggestion, what is due); "Équipe" is the shared list where tasks are assigned.
 * A task opens full screen. Every morning the day is planned again and texted to each technician.
 */
export function PipelinePage() {
  const { t } = useTranslation();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get("tab") === "team" ? "team" : "day");
  // a task: opened from the lists, or from a link (/pipeline?task=<id>, e.g. the notification)
  const [open, setOpen] = useState<string | "new" | null>(params.get("task"));
  const [settings, setSettings] = useState(false);
  useEffect(() => {
    const id = params.get("task");
    if (!id) return;
    setOpen(id);
    const next = new URLSearchParams(params);
    next.delete("task");
    setParams(next, { replace: true });
  }, [params, setParams]);

  return (
    <div className="relative isolate space-y-4">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Workflow className="size-6 text-primary" /> {t("pipeline.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("pipeline.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {can("pipeline.manage") && (
            <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setSettings(true)}>
              <Settings2 className="size-4" /> {t("pipeline.settings.button")}
            </Button>
          )}
          {can("pipeline.edit") && (
            <Button size="sm" className="h-9 bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105" onClick={() => setOpen("new")}>
              <Plus className="size-4" /> {t("pipeline.newTask")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex w-fit items-center gap-0.5 rounded-xl border bg-background/40 p-0.5">
        {(
          [
            ["day", CalendarCheck, t("pipeline.tabs.day")],
            ["team", Users, t("pipeline.tabs.team")],
          ] as const
        ).map(([k, Icon, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn("flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors", tab === k ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "day" ? <MyDay onOpenTask={(id) => setOpen(id)} /> : <TeamList onOpenTask={(id) => setOpen(id)} />}

      {open && <TaskDialog key={open} taskId={open === "new" ? null : open} onClose={() => setOpen(null)} onOpenTask={(id) => setOpen(id)} />}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </div>
  );
}

/** The morning plan: its time, the text to each technician, the work hours, and a button to run it now. */
function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["pipeline", "settings"], queryFn: () => api.get<Settings>("/pipeline/settings") });
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => {
    if (data) setF(data);
  }, [data]);
  const save = useMutation({
    mutationFn: (s: Settings) => api.put<Settings>("/pipeline/settings", s),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pipeline"] });
      toast.success(t("common.saved"));
      onClose();
    },
    onError: () => toast.error(t("pipeline.settings.invalid")),
  });
  const run = useMutation({
    mutationFn: (sms: boolean) => api.post<{ planned: number; texted: number; failed: number }>("/pipeline/morning/run", { sms }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["pipeline"] });
      toast.success(t("pipeline.settings.ran", { planned: r.planned, texted: r.texted, failed: r.failed }));
    },
    onError: () => toast.error(t("common.error")),
  });
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((s) => (s ? { ...s, [k]: v } : s));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="size-5 text-primary" /> {t("pipeline.settings.title")}
          </DialogTitle>
          <DialogDescription>{t("pipeline.settings.text")}</DialogDescription>
        </DialogHeader>
        {!f ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <label className="flex items-center justify-between gap-3 rounded-xl border p-3">
              <span className="space-y-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Sparkles className="size-4 text-primary" /> {t("pipeline.settings.auto")}
                </span>
                <span className="block text-xs text-muted-foreground">{t("pipeline.settings.autoHint")}</span>
              </span>
              <Switch checked={f.auto} onCheckedChange={(v) => set("auto", v)} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-xs text-muted-foreground">
                {t("pipeline.settings.time")}
                <Input type="time" value={f.time} onChange={(e) => set("time", e.target.value)} className="text-foreground" />
              </label>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <Switch checked={f.sms} onCheckedChange={(v) => set("sms", v)} />
                <span className="flex items-center gap-1">
                  <MessageSquareText className="size-4" /> {t("pipeline.settings.sms")}
                </span>
              </label>
            </div>
            <p className="-mt-2 text-[11px] text-muted-foreground">{t("pipeline.settings.smsHint")}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  ["workStart", t("pipeline.settings.workStart")],
                  ["lunchStart", t("pipeline.settings.lunchStart")],
                  ["lunchEnd", t("pipeline.settings.lunchEnd")],
                  ["workEnd", t("pipeline.settings.workEnd")],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="space-y-1 text-xs text-muted-foreground">
                  {label}
                  <Input type="time" value={f[k]} onChange={(e) => set(k, e.target.value)} className="text-foreground" />
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate(false)}>
                {run.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("pipeline.settings.runNow")}
              </Button>
              <Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate(true)}>
                <MessageSquareText className="size-3.5" /> {t("pipeline.settings.runNowSms")}
              </Button>
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!f || save.isPending} onClick={() => f && save.mutate(f)} className="bg-grad-gold font-semibold text-[#1a1204]">
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
