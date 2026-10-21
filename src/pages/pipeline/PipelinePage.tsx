import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { CalendarCheck, Plus, Settings2, Users, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { MyDay } from "./MyDay";
import { TaskDialog } from "./TaskDialog";
import { TeamList } from "./TeamList";

type Tab = "day" | "team";

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
            <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setParams((p) => (p.set("admin", "pipeline"), p))}>
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
    </div>
  );
}
