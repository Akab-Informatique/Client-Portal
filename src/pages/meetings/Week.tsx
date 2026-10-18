import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, FolderKanban, PartyPopper, Ticket, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { holidaysBetween } from "@shared/holidays";

type Block = {
  id: string;
  technicianId: string;
  technicianName: string;
  kind: "work" | "onsite" | "slot";
  title: string;
  ticketId: number | null;
  ticketNumber: string | null;
  companyName: string | null;
  startsAt: string;
  endsAt: string;
  busy: boolean;
};
type Absence = { id: string; userId: string; name: string; startDate: string; endDate: string; kind: string; note: string | null };
type Week = {
  from: string;
  to: string;
  blocks: Block[];
  absences: Absence[];
  projects: { id: string; title: string; client: string | null; dueDate: string }[];
  tickets: { id: number; number: string; title: string; company: string; dueAt: string; assignee: string | null }[];
  ticketsError: boolean;
};

/** Local calendar day as YYYY-MM-DD */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const loc = () => (currentLocale() === "en" ? "en-CA" : "fr-CA");
const time = (iso: string) => new Intl.DateTimeFormat(loc(), { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

const KIND_STYLE: Record<Block["kind"], string> = {
  work: "border-l-primary",
  onsite: "border-l-emerald-400",
  slot: "border-l-sky-400",
};

/** Weekly meeting: the team's week, day by day; a day opens everything planned on it. */
export function WeekSection() {
  const { t } = useTranslation();
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [selected, setSelected] = useState(() => ymd(new Date()));
  const from = ymd(monday);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const holidays = useMemo(() => holidaysBetween(from, ymd(addDays(monday, 6))), [from, monday]);
  const today = ymd(new Date());
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meetings", "week", from],
    queryFn: () => api.get<Week>(`/meetings/week?from=${from}`),
    refetchInterval: 30_000,
  });

  /** Everything on one day */
  const on = (day: string) => ({
    blocks: (data?.blocks ?? []).filter((b) => ymd(new Date(b.startsAt)) === day),
    absences: (data?.absences ?? []).filter((x) => x.startDate <= day && x.endDate >= day),
    tickets: (data?.tickets ?? []).filter((x) => ymd(new Date(x.dueAt)) === day),
    projects: (data?.projects ?? []).filter((x) => x.dueDate === day),
  });
  const go = (weeks: number) => {
    const m = addDays(monday, weeks * 7);
    setMonday(m);
    setSelected(weeks === 0 ? today : ymd(m));
  };
  const day = on(selected);
  const selDate = new Date(`${selected}T12:00:00`);
  const range = `${new Intl.DateTimeFormat(loc(), { day: "numeric", month: "short" }).format(monday)} – ${new Intl.DateTimeFormat(loc(), { day: "numeric", month: "short", year: "numeric" }).format(addDays(monday, 6))}`;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <CalendarDays className="size-5 text-primary" /> {t("meetings.week.title")}
        </h2>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-sm text-muted-foreground">{range}</span>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("meetings.week.previous")} onClick={() => go(-1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={() => go(0)}>
            {t("meetings.week.thisWeek")}
          </Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("meetings.week.next")} onClick={() => go(1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border bg-card/80">
        <div className="grid grid-cols-7 divide-x border-b">
          {days.map((d) => {
            const key = ymd(d);
            const x = on(key);
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={selected === key}
                onClick={() => setSelected(key)}
                className={cn(
                  "flex min-h-24 min-w-0 flex-col items-stretch gap-1 p-1.5 text-left transition-colors hover:bg-accent/50",
                  weekend && "bg-teal-400/[0.05]",
                  selected === key && "bg-primary/10 ring-1 ring-inset ring-primary/60",
                )}
              >
                <span className="flex items-baseline justify-between gap-1">
                  <span className="truncate text-[11px] uppercase text-muted-foreground">{new Intl.DateTimeFormat(loc(), { weekday: "short" }).format(d)}</span>
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                      key === today && "bg-primary text-primary-foreground",
                    )}
                  >
                    {d.getDate()}
                  </span>
                </span>
                {holidays.get(key) && (
                  <span className="truncate text-[10px] text-amber-300" title={t(`meetings.absences.holiday.${holidays.get(key)}`)}>
                    {t(`meetings.absences.holiday.${holidays.get(key)}`)}
                  </span>
                )}
                {data && (
                  <span className="mt-auto flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
                    <Count icon={CalendarClock} n={x.blocks.length} label={t("meetings.week.blocks")} />
                    <Count icon={UserX} n={x.absences.length} label={t("meetings.week.absences")} className="text-sky-300" />
                    <Count icon={Ticket} n={x.tickets.length} label={t("meetings.week.tickets")} className="text-orange-300" />
                    <Count icon={FolderKanban} n={x.projects.length} label={t("meetings.week.projects")} className="text-violet-300" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="max-h-[26rem] space-y-4 overflow-y-auto p-4">
          <h3 className="font-semibold first-letter:uppercase">
            {new Intl.DateTimeFormat(loc(), { weekday: "long", day: "numeric", month: "long" }).format(selDate)}
          </h3>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : isError || !data ? (
            <p className="text-sm text-muted-foreground">{t("common.error")}</p>
          ) : (
            <>
              {holidays.get(selected) && (
                <p className="flex items-center gap-2 text-sm text-amber-300">
                  <PartyPopper className="size-4" /> {t(`meetings.absences.holiday.${holidays.get(selected)}`)}
                </p>
              )}
              {!day.blocks.length && !day.absences.length && !day.tickets.length && !day.projects.length && !holidays.get(selected) && (
                <p className="text-sm text-muted-foreground">{t("meetings.week.nothing")}</p>
              )}
              {day.absences.length > 0 && (
                <Group icon={UserX} title={t("meetings.week.absences")} className="text-sky-300">
                  {day.absences.map((x) => (
                    <li key={x.id} className="text-sm">
                      <span className="font-medium">{x.name}</span>
                      <span className="text-muted-foreground"> · {t(`meetings.absences.kind.${x.kind}`)}</span>
                      {x.note && <span className="text-muted-foreground"> — {x.note}</span>}
                    </li>
                  ))}
                </Group>
              )}
              {day.blocks.length > 0 && (
                <Group icon={CalendarClock} title={t("meetings.week.blocks")} className="text-primary">
                  {day.blocks.map((b) => (
                    <li key={b.id} className={cn("rounded-md border-l-2 bg-muted/40 px-2.5 py-1.5 text-sm", KIND_STYLE[b.kind])}>
                      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          {time(b.startsAt)} – {time(b.endsAt)}
                        </span>
                        <span className="truncate">{b.technicianName}</span>
                      </div>
                      {b.busy ? (
                        <p className="italic text-muted-foreground">{t("planning.busy")}</p>
                      ) : (
                        <p className="truncate">
                          <span className="text-muted-foreground">{t(`planning.kind.${b.kind}`)} · </span>
                          {b.ticketId ? (
                            <Link to={`/tickets?ticket=${b.ticketId}`} className="hover:underline">
                              {b.ticketNumber && <span className="font-mono text-xs">{b.ticketNumber} </span>}
                              {b.title}
                            </Link>
                          ) : (
                            b.title
                          )}
                          {b.companyName && <span className="text-muted-foreground"> — {b.companyName}</span>}
                        </p>
                      )}
                    </li>
                  ))}
                </Group>
              )}
              {(day.tickets.length > 0 || data.ticketsError) && (
                <Group icon={Ticket} title={t("meetings.week.tickets")} className="text-orange-300">
                  {data.ticketsError && <li className="text-sm text-muted-foreground">{t("meetings.week.ticketsError")}</li>}
                  {day.tickets.map((x) => (
                    <li key={x.id} className="text-sm">
                      <Link to={`/tickets?ticket=${x.id}`} className="flex items-baseline gap-2 hover:underline">
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{x.number}</span>
                        <span className="min-w-0 truncate">{x.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{x.assignee ?? t("meetings.overdue.unassigned")}</span>
                      </Link>
                    </li>
                  ))}
                </Group>
              )}
              {day.projects.length > 0 && (
                <Group icon={FolderKanban} title={t("meetings.week.projects")} className="text-violet-300">
                  {day.projects.map((x) => (
                    <li key={x.id} className="text-sm">
                      <span className="font-medium">{x.title}</span>
                      {x.client && <span className="text-muted-foreground"> — {x.client}</span>}
                    </li>
                  ))}
                </Group>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Count({ icon: Icon, n, label, className }: { icon: typeof Ticket; n: number; label: string; className?: string }) {
  if (!n) return null;
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} title={`${n} · ${label}`}>
      <Icon className="size-3" /> {n}
    </span>
  );
}

function Group({ icon: Icon, title, className, children }: { icon: typeof Ticket; title: string; className?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className={cn("flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide", className)}>
        <Icon className="size-3.5" /> {title}
      </h4>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}
