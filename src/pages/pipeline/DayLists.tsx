import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { FolderKanban, Ticket as TicketIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CompactList, type CompactTicket } from "@/pages/tickets/Layouts";
import { shortDate } from "@/pages/tickets/shared";
import type { Project } from "@/pages/projects/shared";
import type { DayItem } from "./shared";

/** The tickets of the day, as the compact view of the Tickets page. */
export function DayTickets({ items, loading, onOpen }: { items: DayItem[]; loading: boolean; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const rows: CompactTicket[] = items.map((i) => ({
    id: Number(i.refId),
    number: i.ticketNumber ?? "",
    title: i.title,
    company: { id: 0, name: i.companyName ?? i.client ?? "" },
    priorityKind: (i.priorityKind ?? "medium") as CompactTicket["priorityKind"],
    priorityLabel: i.priorityLabel ?? null,
    milestoneDate: i.checkpoint ?? null,
    milestoneTime: i.checkpointTime ?? null,
    dueAt: i.dueAt ?? new Date().toISOString(),
    statusKind: (i.statusKind ?? "new") as CompactTicket["statusKind"],
    statusLabel: i.statusLabel ?? null,
  }));
  return (
    <section className="glass rounded-2xl border">
      <h3 className="flex items-center gap-1.5 px-4 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <TicketIcon className="size-3.5" /> {t("pipeline.day.ticketsToday")} <span className="font-mono normal-case opacity-70">{items.length}</span>
      </h3>
      {loading ? <Skeleton className="m-4 h-20" /> : rows.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t("pipeline.day.noTickets")}</p> : <CompactList items={rows} activeIds={new Set()} onOpen={onOpen} />}
    </section>
  );
}

const GRID = "grid grid-cols-[minmax(0,1fr)_9rem_5rem_5.5rem] items-center gap-x-3";

/** My open projects, compact: name, client, milestones done, due day. A click opens the project. */
export function DayProjects() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ["projects", "list", "mine", "open"], queryFn: () => api.get<Project[]>("/projects?view=mine&status=open") });
  const today = new Date().toLocaleDateString("en-CA");
  return (
    <section className="glass rounded-2xl border">
      <h3 className="flex items-center gap-1.5 px-4 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <FolderKanban className="size-3.5" /> {t("pipeline.day.projects")} <span className="font-mono normal-case opacity-70">{data?.length ?? 0}</span>
      </h3>
      {isLoading ? (
        <Skeleton className="m-4 h-16" />
      ) : !data?.length ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">{t("pipeline.day.noProjects")}</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[32rem]">
            <div className={cn(GRID, "border-b border-[color:var(--glass-border)] bg-white/[0.02] px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground")}>
              <span>{t("pipeline.day.project")}</span>
              <span>{t("pipeline.day.projectClient")}</span>
              <span>{t("pipeline.day.projectProgress")}</span>
              <span>{t("pipeline.day.projectDue")}</span>
            </div>
            <ul className="divide-y divide-[color:var(--glass-border)]">
              {data.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => navigate(`/projects?project=${p.id}`)} className={cn(GRID, "w-full px-4 py-1 text-left text-sm transition-colors hover:bg-[linear-gradient(90deg,rgba(255,206,26,0.07),transparent_60%)]")}>
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{p.number}</span>
                      <span className="truncate font-medium" title={p.name}>
                        {p.name}
                      </span>
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{p.client?.name ?? "—"}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {p.progress.done}/{p.progress.total}
                    </span>
                    <span className={cn("whitespace-nowrap font-mono text-xs tabular-nums", p.dueDate && p.dueDate < today ? "text-destructive" : "text-muted-foreground")}>{p.dueDate ? shortDate(p.dueDate) : "—"}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
