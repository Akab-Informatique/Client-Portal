import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { FolderKanban, Star, Ticket as TicketIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CompactList } from "@/pages/tickets/Layouts";
import { shortDate, type TicketList } from "@/pages/tickets/shared";
import type { Project } from "@/pages/projects/shared";
import type { DayItem } from "./shared";

/**
 * A technician's tickets, as the compact view of the Tickets page with the "My tickets" filter (all of them, not only today's);
 * for someone else's day, their tickets (the Tickets page filtered on them).
 */
export function MyTickets({ userId, mine, onOpen }: { userId: string; mine: boolean; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ["tickets", "pipeline", mine ? "mine" : userId],
    queryFn: () => api.get<TicketList>(mine ? "/tickets?view=mine" : `/tickets?view=all&assignee=${userId}`),
    refetchInterval: 60_000,
  });
  const items = (data?.items ?? []).filter((x) => x.statusKind !== "complete");
  return (
    <section className="glass rounded-2xl border">
      <h3 className="flex items-center gap-1.5 px-4 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <TicketIcon className="size-3.5" /> {t("pipeline.day.myTickets")} <span className="font-mono normal-case opacity-70">{items.length}</span>
      </h3>
      {isLoading ? <Skeleton className="m-4 h-20" /> : items.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t("pipeline.day.noTickets")}</p> : <div className="max-h-[32rem] overflow-y-auto"><CompactList items={items} activeIds={new Set()} onOpen={onOpen} /></div>}
    </section>
  );
}

/** The priorities pinned in Planning: of the day (beside the blocks) or of the week (beside the tickets). */
export function Priorities({ items, horizon, onOpen }: { items: DayItem[]; horizon: "day" | "week"; onOpen: (i: DayItem) => void }) {
  const { t } = useTranslation();
  const list = items.filter((i) => i.pin === horizon);
  return (
    <section className="glass rounded-2xl border p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Star className={cn("size-3.5 fill-current", horizon === "day" ? "text-primary" : "")} /> {t(`pipeline.day.priorities.${horizon}`)} <span className="font-mono normal-case opacity-70">{list.length}</span>
      </h3>
      {list.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">{t(`pipeline.day.priorities.none${horizon === "day" ? "Day" : "Week"}`)}</p>
      ) : (
        <ul className="divide-y divide-[color:var(--glass-border)]">
          {list.map((i) => (
            <li key={i.key}>
              <button type="button" onClick={() => onOpen(i)} className="flex w-full items-baseline gap-2 py-1.5 text-left">
                {i.ticketNumber && <span className="shrink-0 font-mono text-[11px] text-primary">{i.ticketNumber}</span>}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.title}</span>
                {i.client && <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block">{i.client}</span>}
                {i.pinNote && <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">· {i.pinNote}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
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
