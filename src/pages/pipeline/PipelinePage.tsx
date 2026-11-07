import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { CalendarCheck, FolderKanban, ListTodo, Loader2, Plus, Settings2, Ticket, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { MyDay } from "./MyDay";
import { TaskDialog } from "./TaskDialog";
import { TeamList } from "./TeamList";

// the Tickets and Projects pages, shown here as tabs too (their own pages and links keep working)
const TicketsPage = lazy(() => import("@/pages/tickets/TicketsPage").then((m) => ({ default: m.TicketsPage })));
const ProjectsPage = lazy(() => import("@/pages/projects/ProjectsPage").then((m) => ({ default: m.ProjectsPage })));

type Tab = "day" | "tickets" | "projects" | "todo";
const TABS: Tab[] = ["day", "tickets", "projects", "todo"];

/**
 * Mon travail (was "Pipeline"): everything a technician works on, in one place. "Ma journée" is the dashboard (the AI's
 * summary of the day, the hours laid out as a suggestion, what is due); "Billets" and "Projets" are the Tickets and
 * Projects pages; "À faire" is the shared to-do list where tasks are assigned. A task opens full screen. Every morning
 * the day is planned again and texted to each technician. The tab is in the address (`?section=`).
 */
export function PipelinePage() {
  const { t } = useTranslation();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  // (`?tab=team` was the old link to the team list)
  const asked = params.get("section") ?? (params.get("tab") === "team" ? "todo" : null);
  const tab: Tab = TABS.includes(asked as Tab) ? (asked as Tab) : "day";
  // switching tab starts the new tab's own filters from scratch (Tickets and Projects keep theirs in the address)
  const setTab = (k: Tab) => setParams(k === "day" ? {} : { section: k });
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
            ["tickets", Ticket, t("pipeline.tabs.tickets")],
            ["projects", FolderKanban, t("pipeline.tabs.projects")],
            ["todo", ListTodo, t("pipeline.tabs.todo")],
          ] as const
        ).map(([k, Icon, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn("flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors", tab === k ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "day" && <MyDay onOpenTask={(id) => setOpen(id)} />}
      {tab === "todo" && <TeamList onOpenTask={(id) => setOpen(id)} />}
      {(tab === "tickets" || tab === "projects") && (
        <Suspense fallback={<Loader2 className="mx-auto mt-12 size-6 animate-spin text-muted-foreground" />}>{tab === "tickets" ? <TicketsPage /> : <ProjectsPage />}</Suspense>
      )}

      {open && <TaskDialog key={open} taskId={open === "new" ? null : open} onClose={() => setOpen(null)} onOpenTask={(id) => setOpen(id)} />}
    </div>
  );
}
