import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlarmClock, CalendarCheck, CheckCircle2, UserX } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { AbsencesSection } from "./Absences";
import { PointsSection } from "./Points";
import { ProjectsSection } from "./Projects";
import { PRIORITY_STYLE, STATUS_STYLE, shortDate, useChoiceText, type PriorityKind, type StatusKind } from "@/pages/tickets/shared";

type OverdueTicket = {
  id: number;
  number: string;
  title: string;
  company: string;
  statusLabel: string | null;
  statusKind: StatusKind;
  priorityLabel: string | null;
  priorityKind: PriorityKind;
  dueAt: string;
  overdue: boolean;
  secondary: string[];
};
type Overdue = {
  demo: boolean;
  total: number;
  dueThisWeek: number;
  until: string;
  untilDate: string;
  technicians: { id: string; name: string; tickets: OverdueTicket[] }[];
  unassigned: OverdueTicket[];
};

/** "ven. 17 oct." / "Fri, Oct 17" */
const dayDate = (iso: string) =>
  new Intl.DateTimeFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** Weekly team meeting dashboard (meetings.view). */
export function MeetingsPage() {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meetings", "overdue"],
    queryFn: () => api.get<Overdue>("/meetings/overdue"),
    refetchInterval: 60_000,
  });

  return (
    <div className="relative isolate space-y-6">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <CalendarCheck className="size-6 text-primary" /> {t("meetings.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("meetings.subtitle")}</p>
      </div>

      <PointsSection />

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <AlarmClock className="size-5 text-red-400" /> {t("meetings.overdue.title")}
          </h2>
          {data && (
            <span className={cn("text-sm", data.total ? "text-red-400" : data.dueThisWeek ? "text-orange-300" : "text-emerald-400")}>
              {data.total || data.dueThisWeek
                ? [data.total && t("meetings.overdue.total", { count: data.total }), data.dueThisWeek && t("meetings.overdue.weekTotal", { count: data.dueThisWeek, date: dayDate(`${data.untilDate}T12:00:00`) })].filter(Boolean).join(" · ")
                : t("meetings.overdue.none")}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-48 rounded-2xl" />
            ))}
          </div>
        ) : isError || !data ? (
          <p className="py-16 text-center text-muted-foreground">{t("common.error")}</p>
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.technicians.map((p) => (
              <TechCard key={p.id} name={p.name} tickets={p.tickets} />
            ))}
            {data.unassigned.length > 0 && <TechCard name={t("meetings.overdue.unassigned")} tickets={data.unassigned} unassigned />}
          </div>
        )}
      </section>

      <ProjectsSection />

      <AbsencesSection />
    </div>
  );
}

function TechCard({ name, tickets, unassigned }: { name: string; tickets: OverdueTicket[]; unassigned?: boolean }) {
  const { t } = useTranslation();
  const late = tickets.filter((x) => x.overdue).length;
  return (
    <div className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
          {unassigned ? <UserX className="size-4 text-muted-foreground" /> : initials(name)}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
        {tickets.length ? (
          <span className="flex shrink-0 gap-1.5">
            {late > 0 && (
              <span className="rounded-full border border-red-500/50 bg-red-500/15 px-2.5 py-0.5 text-xs font-semibold text-red-300">
                {t("meetings.overdue.count", { count: late })}
              </span>
            )}
            {tickets.length - late > 0 && (
              <span className="rounded-full border border-orange-500/40 bg-orange-500/10 px-2.5 py-0.5 text-xs font-semibold text-orange-300">
                {t("meetings.overdue.weekCount", { count: tickets.length - late })}
              </span>
            )}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
            <CheckCircle2 className="size-3.5" /> {t("meetings.overdue.upToDate")}
          </span>
        )}
      </div>
      {tickets.length > 0 && (
        <ul className="divide-y">
          {tickets.map((x) => (
            <TicketRow key={x.id} ticket={x} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TicketRow({ ticket: x }: { ticket: OverdueTicket }) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const days = Math.max(1, Math.floor((Date.now() - new Date(x.dueAt).getTime()) / 86_400_000));
  return (
    <li>
      <Link to={`/tickets?ticket=${x.id}`} className="block px-4 py-2.5 transition-colors hover:bg-accent/50">
        <div className="flex items-center gap-2 text-xs">
          <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_STYLE[x.priorityKind].dot)} title={txt.priority({ label: x.priorityLabel, kind: x.priorityKind })} />
          <span className="font-mono text-muted-foreground">{x.number}</span>
          {x.overdue ? (
            <span className="ml-auto shrink-0 font-semibold text-red-400" title={shortDate(x.dueAt)}>
              {t("meetings.overdue.late", { count: days })}
            </span>
          ) : (
            <span className="ml-auto shrink-0 font-semibold text-orange-300">{t("meetings.overdue.dueOn", { date: dayDate(x.dueAt) })}</span>
          )}
        </div>
        <p className="mt-0.5 truncate text-sm font-medium">{x.title}</p>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{x.company}</span>
          <span className={cn("ml-auto shrink-0 rounded-full border px-2 py-px text-[11px]", STATUS_STYLE[x.statusKind])}>
            {txt.status({ label: x.statusLabel, kind: x.statusKind })}
          </span>
        </div>
      </Link>
    </li>
  );
}
