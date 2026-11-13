import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { CalendarCheck, ListChecks, Loader2, Ticket, Workflow } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { cn } from "@/lib/utils";
import { MyDay } from "./MyDay";
import { TaskDialog } from "./TaskDialog";
import { TeamList } from "./TeamList";

// the Tickets page, shown here as a tab too (its own page and links keep working)
const TicketsPage = lazy(() => import("@/pages/tickets/TicketsPage").then((m) => ({ default: m.TicketsPage })));

type Tab = "day" | "tickets" | "tasks";
const TABS: Tab[] = ["day", "tickets", "tasks"];

/**
 * Mon travail (was "Pipeline"): everything a technician works on, in one place. "Ma journée" is the dashboard (the AI's
 * summary of the day, the hours laid out as a suggestion, what is due); "Billets" and "Projets" are the Tickets and
 * Projects pages; "À faire" is the shared to-do list where tasks are assigned. A task opens full screen. Every morning
 * the day is planned again and texted to each technician. The tab is in the address (`?section=`).
 */
export function PipelinePage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  // (`?tab=team` was the old link to the team list)
  // (`?tab=team` and the old `?section=todo` were the team's list: it is now the Tasks tab)
  const asked = params.get("section") ?? (params.get("tab") === "team" ? "tasks" : null);
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
      </div>

      <div className="flex w-fit items-center gap-0.5 rounded-xl border bg-background/40 p-0.5">
        {(
          [
            ["day", CalendarCheck, t("pipeline.tabs.day")],
            ["tickets", Ticket, t("pipeline.tabs.tickets")],
            ["tasks", ListChecks, t("pipeline.tabs.tasks")],
          ] as const
        ).map(([k, Icon, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn("flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors", tab === k ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "day" && <MyDay onOpenTask={(id) => setOpen(id)} />}
      {tab === "tasks" && <TeamList onOpenTask={(id) => setOpen(id)} />}
      {tab === "tickets" && (
        <Suspense fallback={<Loader2 className="mx-auto mt-12 size-6 animate-spin text-muted-foreground" />}>
          <TicketsPage />
        </Suspense>
      )}

      {open && <TaskDialog key={open} taskId={open === "new" ? null : open} onClose={() => setOpen(null)} onOpenTask={(id) => setOpen(id)} />}
    </div>
  );
}
