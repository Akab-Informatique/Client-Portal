import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link, useNavigate } from "react-router-dom";
import { AlarmClock, ArrowRight, BellRing, CalendarCheck, CheckCircle2, Clock3, Filter, Loader2, Lock, MessageSquareText, MousePointer2 } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCan } from "@/lib/session";
import { useTicketWorkspace } from "@/pages/tickets/workspace";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { PointsSection } from "./Points";
import { ProjectsSection } from "./Projects";
import { TrendsSection } from "./Trends";
import { WeekSection } from "./Week";
import { PRIORITY_STYLE, STATUS_STYLE, useChoiceText, type PriorityKind, type StatusKind, type TicketDetail } from "@/pages/tickets/shared";

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
};
/** A ticket with whose it is (the team lists) */
type Row = OverdueTicket & { who?: string };
type Person = { id: string; name: string; count: number; tickets: Row[] };
type Overdue = {
  demo: boolean;
  total: number;
  dueThisWeek: number;
  until: string;
  untilDate: string;
  technicians: { id: string; name: string; tickets: OverdueTicket[] }[];
  unassigned: OverdueTicket[];
  /** Open, nobody assigned, status past "new" */
  stray: { total: number; byStatus: { label: string; kind: string; count: number }[]; tickets: OverdueTicket[] };
  /** The queues the gauges count (custom: chosen; otherwise every queue but alerts) */
  queues: { all: { value: string; label: string }[]; counted: string[]; custom: boolean };
  /** Open monitoring alerts (alert queue or monitoring source), the newest first */
  alerts: (OverdueTicket & { createdAt: string })[];
  /** The status given when an alert is marked resolved (null: none known) */
  completeStatus: string | null;
};

/** Every open status but "complete" (the tickets list shows completed ones in "all" otherwise) */
const OPEN_KINDS = ["new", "inProgress", "needsAttention", "waitingCustomer", "waitingVendor", "scheduled", "other"];
/** The tickets page with a filter; a person picked under a gauge narrows it to them */
const ticketsUrl = (q: Record<string, string>, who: string | null, queues: Overdue["queues"]) => {
  const p = new URLSearchParams(q);
  // no monitoring alerts (they have their own gauge)
  p.set("alerts", "0");
  // the same queues as the gauges (none named when they all count)
  if (queues.counted.length < queues.all.length) p.set("queue", queues.counted.join(","));
  if (who) p.set("assignee", who === "unassigned" ? "none" : who);
  return `/tickets?${p.toString()}`;
};

/** "ven. 17 oct." / "Fri, Oct 17" */
const dayDate = (iso: string) =>
  new Intl.DateTimeFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));

/** Red from `red` tickets, critical from `critical` (the gauge's end) */
type Scale = { red: number; critical: number };
/** Technicians' tickets: red at 25, critical at 35 */
const WORKLOAD: Scale = { red: 25, critical: 35 };
/** Unassigned tickets past "new": every one is a ticket nobody follows */
const STRAY: Scale = { red: 5, critical: 10 };
/** Monitoring alerts still open */
const ALERTS: Scale = { red: 10, critical: 20 };
/** Green (0) → yellow → red */
const heat = (n: number, s: Scale, alpha = 1) =>
  n >= s.critical ? `hsl(0 85% 45% / ${alpha})` : `hsl(${Math.round(142 * (1 - Math.min(n, s.red) / s.red))} 75% 52% / ${alpha})`;

/** Weekly team meeting dashboard (meetings.view). */
export function MeetingsPage() {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meetings", "overdue"],
    queryFn: () => api.get<Overdue>("/meetings/overdue"),
    refetchInterval: 60_000,
  });

  // Each person (and the unassigned tickets) with their count for each gauge
  const people = data
    ? [
        ...data.technicians.map((p) => ({ id: p.id, name: p.name, tickets: p.tickets })),
        ...(data.unassigned.length ? [{ id: "unassigned", name: t("meetings.overdue.unassigned"), tickets: data.unassigned }] : []),
      ]
    : [];
  const pick = (keep: (x: OverdueTicket) => boolean): Person[] =>
    people.map((p) => {
      const tickets = p.tickets.filter(keep).map((x) => ({ ...x, who: p.name }));
      return { id: p.id, name: p.name, count: tickets.length, tickets };
    });
  const late = pick((x) => x.overdue);
  const week = pick((x) => !x.overdue);

  return (
    <div className="relative isolate space-y-6">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <CalendarCheck className="size-6 text-primary" /> {t("meetings.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("meetings.subtitle")}</p>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <PointsSection />
        <WeekSection />
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <AlarmClock className="size-5 text-red-400" /> {t("meetings.overdue.title")}
          </h2>
          {data && <QueuesPicker queues={data.queues} />}
        </div>
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[22rem] rounded-2xl" />
            ))}
          </div>
        ) : isError || !data ? (
          <p className="py-16 text-center text-muted-foreground">{t("common.error")}</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
            <GaugeCard
              title={t("meetings.overdue.gaugeLate")}
              total={data.total}
              people={late}
              url={(who) => ticketsUrl({ view: "due", due: "overdue" }, who, data.queues)}
            />
            <GaugeCard
              title={t("meetings.overdue.gaugeWeek", { date: dayDate(`${data.untilDate}T12:00:00`) })}
              total={data.dueThisWeek}
              people={week}
              url={(who) => ticketsUrl({ view: "all", statusKind: OPEN_KINDS.join(","), due: "week" }, who, data.queues)}
            />
            <StrayCard stray={data.stray} queues={data.queues} />
            <AlertsCard alerts={data.alerts} completeStatus={data.completeStatus} />
          </div>
        )}
      </section>

      <ProjectsSection />
      <TrendsSection />
    </div>
  );
}

/** A gauge for the whole team, or the person picked under it. */
function GaugeCard({ title, total, people, url }: { title: string; total: number; people: Person[]; url: (who: string | null) => string }) {
  const { t } = useTranslation();
  const [who, setWho] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const picked = people.find((p) => p.id === who);
  const value = picked ? picked.count : total;
  const tickets = (picked ? picked.tickets : people.flatMap((p) => p.tickets)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return (
    <GaugePanel glow={heat(value, WORKLOAD, 0.28)} title={title} aside={<span className="truncate text-sm text-muted-foreground">{picked ? picked.name : t("meetings.overdue.everyone")}</span>}>
      <GaugeButton onClick={() => setListOpen(true)}>
        <Gauge value={value} scale={WORKLOAD} />
      </GaugeButton>
      {listOpen && (
        <TicketsDialog
          title={title}
          subtitle={picked ? picked.name : t("meetings.overdue.everyone")}
          tickets={tickets}
          showWho={!picked}
          to={url(who)}
          onClose={() => setListOpen(false)}
        />
      )}
      <div className="flex max-h-28 flex-wrap content-start justify-center gap-1.5 overflow-y-auto scrollbar-thin">
        <Chip active={who === null} onClick={() => setWho(null)} label={t("meetings.overdue.everyone")} count={total} scale={WORKLOAD} />
        {[...people]
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .map((p) => (
            <Chip key={p.id} active={who === p.id} onClick={() => setWho(who === p.id ? null : p.id)} label={p.name} count={p.count} scale={WORKLOAD} />
          ))}
      </div>
    </GaugePanel>
  );
}

/**
 * The frame of every gauge: a glass panel with a soft light in the gauge's
 * color behind it; all four stretch to the same height.
 */
function GaugePanel({ title, aside, glow, children }: { title: React.ReactNode; aside?: React.ReactNode; glow: string; children: React.ReactNode }) {
  return (
    <div className="glass group/gauge relative flex h-full min-h-[22rem] flex-col gap-4 overflow-hidden rounded-2xl border p-5 transition-shadow duration-500 hover:shadow-[0_24px_60px_-30px_rgba(255,206,26,0.35)]">
      {/* the gauge's color, as a light behind the glass */}
      <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 -z-10 size-64 -translate-x-1/2 rounded-full blur-3xl transition-colors duration-700" style={{ background: glow }} />
      <span aria-hidden className="pointer-events-none absolute inset-x-[15%] top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
      <div className="flex h-6 items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-1.5 truncate font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** Half circle from green to red; its end is critical. */
function Gauge({ value, scale }: { value: number; scale: Scale }) {
  const { t } = useTranslation();
  const r = 80;
  const len = Math.PI * r;
  const { red: RED, critical: CRITICAL } = scale;
  const share = Math.min(value, CRITICAL) / CRITICAL;
  const critical = value >= CRITICAL;
  const gradient = `gauge-${RED}-${CRITICAL}`;
  // the needle: 180° (0) to 0° (35)
  const angle = Math.PI * (1 - share);
  const nx = 100 + (r - 22) * Math.cos(angle);
  const ny = 100 - (r - 22) * Math.sin(angle);
  const mark = (n: number) => {
    const a = Math.PI * (1 - n / CRITICAL);
    return {
      x1: 100 + (r - 14) * Math.cos(a),
      y1: 100 - (r - 14) * Math.sin(a),
      x2: 100 + (r + 14) * Math.cos(a),
      y2: 100 - (r + 14) * Math.sin(a),
      tx: 100 + (r + 24) * Math.cos(a),
      ty: 100 - (r + 24) * Math.sin(a),
    };
  };
  const arc = `M ${100 - r} 100 A ${r} ${r} 0 0 1 ${100 + r} 100`;
  return (
    <div className="relative mx-auto w-full max-w-xs">
      <svg viewBox="-14 -14 228 130" className="w-full" role="img" aria-label={String(value)}>
        <defs>
          <linearGradient id={gradient} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={heat(0, scale)} />
            <stop offset={String(RED / CRITICAL / 2)} stopColor={heat(RED / 2, scale)} />
            <stop offset={String(RED / CRITICAL)} stopColor={heat(RED, scale)} />
            <stop offset="1" stopColor={heat(CRITICAL, scale)} />
          </linearGradient>
        </defs>
        {/* the scale, faint, then the value over it */}
        <path d={arc} fill="none" stroke={`url(#${gradient})`} strokeOpacity={0.22} strokeWidth={16} strokeLinecap="round" />
        {value > 0 && (
          <path
            d={arc}
            fill="none"
            stroke={heat(value, scale)}
            strokeWidth={16}
            strokeLinecap="round"
            strokeDasharray={`${share * len} ${len}`}
            className={cn("transition-[stroke-dasharray] duration-700", critical && "animate-pulse")}
          />
        )}
        {[RED, CRITICAL].map((n) => {
          const m = mark(n);
          return (
            <g key={n} className="text-muted-foreground">
              <line x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} stroke="currentColor" strokeOpacity={0.5} strokeWidth={1.5} />
              <text x={m.tx} y={m.ty} fontSize={9} textAnchor="middle" dominantBaseline="middle" fill="currentColor">
                {n}
              </text>
            </g>
          );
        })}
        <line
          x1={100}
          y1={100}
          x2={nx}
          y2={ny}
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          className="text-foreground/70 transition-all duration-700"
        />
        <circle cx={100} cy={100} r={4} className="fill-foreground/70" />
      </svg>
      <div className="-mt-3 text-center">
        <span className="font-display text-4xl font-bold tabular-nums" style={{ color: heat(value, scale) }}>
          {value}
        </span>
        {critical && <span className="ml-2 align-middle text-xs font-semibold uppercase tracking-wide text-red-400">{t("meetings.overdue.critical")}</span>}
      </div>
    </div>
  );
}

/** A person, colored by how many tickets they have (green → red, then critical). */
function Chip({ label, count, active, onClick, scale }: { label: string; count: number; active: boolean; onClick: () => void; scale: Scale }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-[box-shadow,opacity]",
        active ? "ring-2 ring-offset-1 ring-offset-background" : "opacity-85 hover:opacity-100",
        count >= scale.critical && "animate-pulse",
      )}
      style={{
        color: heat(count, scale),
        borderColor: heat(count, scale, 0.5),
        background: heat(count, scale, 0.12),
        ["--tw-ring-color" as string]: heat(count, scale, 0.8),
      }}
    >
      {label}
      <span className="rounded-full px-1.5 tabular-nums" style={{ background: heat(count, scale, 0.2) }}>
        {count}
      </span>
    </button>
  );
}

/** Open tickets nobody has, past "new": moved on, then left without a technician. */
function StrayCard({ stray, queues }: { stray: Overdue["stray"]; queues: Overdue["queues"] }) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const [listOpen, setListOpen] = useState(false);
  const to = ticketsUrl({ view: "unassigned", statusKind: OPEN_KINDS.filter((k) => k !== "new").join(",") }, null, queues);
  return (
    <GaugePanel
      glow={heat(stray.total, STRAY, 0.28)}
      title={t("meetings.overdue.gaugeStray")}
      aside={
        <Link to={to} className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          {t("meetings.overdue.seeTickets")} <ArrowRight className="size-3.5" />
        </Link>
      }
    >
      <GaugeButton onClick={() => setListOpen(true)}>
        <Gauge value={stray.total} scale={STRAY} />
      </GaugeButton>
      {listOpen && (
        <TicketsDialog
          title={t("meetings.overdue.gaugeStray")}
          subtitle={t("meetings.overdue.unassigned")}
          tickets={stray.tickets}
          to={to}
          onClose={() => setListOpen(false)}
        />
      )}
      <div className="flex max-h-28 flex-wrap content-start justify-center gap-1.5 overflow-y-auto scrollbar-thin">
        {stray.byStatus.length ? (
          stray.byStatus.map((s) => (
            <span
              key={s.label + s.kind}
              className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", STATUS_STYLE[s.kind as StatusKind])}
            >
              {txt.status({ label: s.label || null, kind: s.kind as StatusKind })}
              <span className="tabular-nums opacity-80">{s.count}</span>
            </span>
          ))
        ) : (
          <span className="text-sm text-emerald-400">{t("meetings.overdue.noStray")}</span>
        )}
      </div>
    </GaugePanel>
  );
}

/** The gauge, clickable: opens the list of its tickets */
function GaugeButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t("meetings.overdue.openList")}
      className="block w-full rounded-xl transition-colors hover:bg-foreground/[0.04] focus-visible:outline-2"
    >
      {children}
    </button>
  );
}

const SHOWN = 12;

/** Beside a gauge's list: the hovered ticket's last two replies or notes (its rights: tickets.view). */
function LatestNotes({ ticket }: { ticket: Row | null }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useQuery({
    queryKey: ["tickets", "detail", ticket?.id],
    queryFn: () => api.get<TicketDetail>(`/tickets/${ticket!.id}`),
    enabled: Boolean(ticket),
    staleTime: 60_000,
    retry: false,
  });
  const latest = (data?.notes ?? [])
    .filter((n) => (n.kind === "time" ? n.text || n.internalText : n.text))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 2);
  return (
    <aside className="glass flex max-h-[55vh] min-h-48 flex-col overflow-hidden rounded-xl border">
      {!ticket ? (
        <p className="m-auto flex max-w-56 flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <MousePointer2 className="size-5 text-primary/70" /> {t("meetings.overdue.hoverHint")}
        </p>
      ) : (
        <>
          <div className="border-b px-4 py-2.5">
            <p className="font-mono text-[11px] text-muted-foreground">{ticket.number}</p>
            <p className="line-clamp-2 text-sm font-semibold">{ticket.title}</p>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 scrollbar-thin">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <MessageSquareText className="size-3.5 text-primary" /> {t("meetings.overdue.latestNotes")}
            </p>
            {isLoading ? (
              <>
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </>
            ) : error ? (
              <p className="text-sm text-muted-foreground">{error instanceof ApiError && error.status === 403 ? t("meetings.overdue.notesNoAccess") : t("common.error")}</p>
            ) : latest.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("meetings.overdue.noNotes")}</p>
            ) : (
              latest.map((n) => (
                <div key={n.id} className={cn("rounded-lg border p-3", n.internal && "border-amber-500/30 bg-amber-500/5")}>
                  <p className="flex flex-wrap items-center gap-x-2 text-xs">
                    <span className="font-medium">{n.author}</span>
                    <span className="text-muted-foreground">{relativeTime(n.at)}</span>
                    {n.kind === "time" ? (
                      <span className="inline-flex items-center gap-1 text-sky-400">
                        <Clock3 className="size-3" /> {t("meetings.overdue.noteTime", { hours: n.hours ?? 0 })}
                      </span>
                    ) : (
                      n.internal && (
                        <span className="inline-flex items-center gap-1 text-amber-400">
                          <Lock className="size-3" /> {t("meetings.overdue.noteInternal")}
                        </span>
                      )
                    )}
                  </p>
                  <p className="mt-1 line-clamp-6 whitespace-pre-wrap text-sm text-foreground/90">{n.kind === "time" ? n.text || n.internalText : n.text}</p>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/** A short list of a gauge's tickets; clicking it opens the tickets page with the same filter. */
function TicketsDialog({
  title,
  subtitle,
  tickets,
  showWho,
  to,
  onClose,
}: {
  title: string;
  subtitle: string;
  tickets: Row[];
  showWho?: boolean;
  to: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const navigate = useNavigate();
  const go = () => {
    onClose();
    navigate(to);
  };
  const days = (iso: string) => Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
  // the ticket under the mouse (after a short pause, so sweeping the list does not load every ticket)
  const [hovered, setHovered] = useState<Row | null>(null);
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hover = (x: Row) => {
    clearTimeout(pause.current);
    pause.current = setTimeout(() => setHovered(x), 140);
  };
  useEffect(() => () => clearTimeout(pause.current), []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {title} <span className="font-normal text-muted-foreground">({tickets.length})</span>
          </DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
        {tickets.length === 0 ? (
          <p className="py-6 text-center text-sm text-emerald-400">{t("meetings.overdue.emptyList")}</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <button
            type="button"
            onClick={go}
            title={t("meetings.overdue.openFiltered")}
            className="block w-full overflow-hidden rounded-xl border text-left transition-colors hover:border-primary/60"
          >
            <ul className="max-h-[55vh] divide-y overflow-y-auto">
              {tickets.slice(0, SHOWN).map((x) => (
                <li
                  key={x.id}
                  onMouseEnter={() => hover(x)}
                  className={cn("px-3 py-2 transition-colors hover:bg-accent/40", hovered?.id === x.id && "bg-accent/40")}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={cn("size-2 shrink-0 rounded-full", PRIORITY_STYLE[x.priorityKind].dot)}
                      title={txt.priority({ label: x.priorityLabel, kind: x.priorityKind })}
                    />
                    <span className="font-mono text-muted-foreground">{x.number}</span>
                    <span className={cn("rounded-full border px-2 py-px text-[11px]", STATUS_STYLE[x.statusKind])}>
                      {txt.status({ label: x.statusLabel, kind: x.statusKind })}
                    </span>
                    <span className={cn("ml-auto shrink-0 font-semibold", x.overdue ? "text-red-400" : "text-orange-300")}>
                      {x.overdue ? t("meetings.overdue.late", { count: days(x.dueAt) }) : t("meetings.overdue.dueOn", { date: dayDate(x.dueAt) })}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-sm font-medium">{x.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {x.company}
                    {showWho && x.who && <> · {x.who}</>}
                  </p>
                </li>
              ))}
            </ul>
            {tickets.length > SHOWN && (
              <p className="border-t px-3 py-2 text-center text-xs text-muted-foreground">{t("meetings.overdue.more", { count: tickets.length - SHOWN })}</p>
            )}
          </button>
          <LatestNotes ticket={hovered} />
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={go}>
            {t("meetings.overdue.openFiltered")} <ArrowRight className="size-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Which ticket queues the gauges count: shown to all, changed with meetings.manage. */
function QueuesPicker({ queues }: { queues: Overdue["queues"] }) {
  const { t } = useTranslation();
  const manage = useCan()("meetings.manage");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(queues.counted);
  const save = useMutation({
    mutationFn: (q: string[] | null) => api.put("/meetings/gauge-queues", { queues: q }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["meetings", "overdue"] });
      setOpen(false);
    },
    onError: () => toast.error(t("common.error")),
  });
  const names = queues.all.filter((q) => queues.counted.includes(q.value)).map((q) => q.label);
  const label = queues.counted.length === queues.all.length ? t("meetings.overdue.allQueues") : names.join(", ");
  const summary = (
    <span className="inline-flex max-w-full items-center gap-1.5 text-sm text-muted-foreground">
      <Filter className="size-3.5 shrink-0" /> <span className="truncate">{label}</span>
    </span>
  );
  if (!manage || !queues.all.length) return <span title={names.join(", ")}>{summary}</span>;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setPicked(queues.counted);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-full sm:max-w-md" title={t("meetings.overdue.queuesHint")}>
          {summary}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <div>
          <p className="text-sm font-semibold">{t("meetings.overdue.queuesTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("meetings.overdue.queuesHint")}</p>
        </div>
        <ul className="max-h-60 space-y-1.5 overflow-y-auto">
          {queues.all.map((q) => (
            <li key={q.value}>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={picked.includes(q.value)}
                  onCheckedChange={(v) => setPicked(v ? [...picked, q.value] : picked.filter((x) => x !== q.value))}
                />
                {q.label}
              </label>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => save.mutate(null)}>
            {t("meetings.overdue.queuesDefault")}
          </Button>
          <Button size="sm" className="ml-auto" disabled={!picked.length || save.isPending} onClick={() => save.mutate(picked)}>
            {t("common.save")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Open monitoring alerts: a gauge, then the list to open or resolve them. */
function AlertsCard({ alerts, completeStatus }: { alerts: Overdue["alerts"]; completeStatus: string | null }) {
  const { t } = useTranslation();
  const [listOpen, setListOpen] = useState(false);
  const newest = alerts[0];
  const ws = useTicketWorkspace();
  const qc = useQueryClient();
  // An alert opened from the list: the ticket shows over the meeting; once it is closed,
  // the meeting is back, refreshed
  const reopen = useRef(false);
  useEffect(() => {
    if (ws.openId === null && reopen.current) {
      reopen.current = false;
      void qc.invalidateQueries({ queryKey: ["meetings"] });
    }
  }, [ws.openId, qc]);
  const openTicket = (id: number) => {
    reopen.current = true;
    setListOpen(false);
    ws.open(id);
  };
  return (
    <GaugePanel
      glow={heat(alerts.length, ALERTS, 0.28)}
      title={
        <>
          <BellRing className="size-4 text-amber-300" /> {t("meetings.overdue.gaugeAlerts")}
        </>
      }
    >
      <GaugeButton onClick={() => setListOpen(true)}>
        <Gauge value={alerts.length} scale={ALERTS} />
      </GaugeButton>
      <p className="truncate text-center text-xs text-muted-foreground">
        {newest ? t("meetings.overdue.latestAlert", { title: newest.title }) : <span className="text-emerald-400">{t("meetings.overdue.noAlerts")}</span>}
      </p>
      {listOpen && <AlertsDialog alerts={alerts} completeStatus={completeStatus} onOpen={openTicket} onClose={() => setListOpen(false)} />}
    </GaugePanel>
  );
}

/** Every open alert: a click opens the ticket; "Résolu" closes it (tickets.edit). */
function AlertsDialog({
  alerts,
  completeStatus,
  onOpen,
  onClose,
}: {
  alerts: Overdue["alerts"];
  completeStatus: string | null;
  onOpen: (id: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canResolve = useCan()("tickets.edit") && completeStatus !== null;
  const [busy, setBusy] = useState<number | null>(null);
  const resolve = useMutation({
    mutationFn: (id: number) => {
      setBusy(id);
      return api.patch(`/tickets/${id}`, { status: completeStatus });
    },
    onSuccess: () => {
      toast.success(t("meetings.overdue.resolved"));
      void qc.invalidateQueries({ queryKey: ["meetings", "overdue"] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: () => toast.error(t("common.error")),
    onSettled: () => setBusy(null),
  });
  const open = onOpen;
  const when = (iso: string) =>
    new Intl.DateTimeFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(
      new Date(iso),
    );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("meetings.overdue.gaugeAlerts")} <span className="font-normal text-muted-foreground">({alerts.length})</span>
          </DialogTitle>
          <DialogDescription>{t("meetings.overdue.alertsHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onClose();
              navigate("/tickets?view=all&statusKind=new,inProgress,needsAttention,waitingCustomer,waitingVendor,scheduled,other&alerts=1");
            }}
          >
            {t("meetings.overdue.openFiltered")} <ArrowRight className="size-4" />
          </Button>
        </div>
        {alerts.length === 0 ? (
          <p className="py-6 text-center text-sm text-emerald-400">{t("meetings.overdue.noAlerts")}</p>
        ) : (
          <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-xl border">
            {alerts.map((x) => (
              <li key={x.id} className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/40">
                <button type="button" onClick={() => open(x.id)} className="min-w-0 flex-1 text-left" title={t("meetings.overdue.openTicket")}>
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={cn("size-2 shrink-0 rounded-full", PRIORITY_STYLE[x.priorityKind].dot)}
                      title={txt.priority({ label: x.priorityLabel, kind: x.priorityKind })}
                    />
                    <span className="font-mono text-muted-foreground">{x.number}</span>
                    <span className={cn("rounded-full border px-2 py-px text-[11px]", STATUS_STYLE[x.statusKind])}>
                      {txt.status({ label: x.statusLabel, kind: x.statusKind })}
                    </span>
                    <span className="ml-auto shrink-0 text-muted-foreground">{when(x.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-sm font-medium">{x.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{x.company}</p>
                </button>
                {canResolve && (
                  <Button size="sm" variant="outline" className="shrink-0" disabled={resolve.isPending} onClick={() => resolve.mutate(x.id)}>
                    {busy === x.id ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4 text-emerald-400" />}{" "}
                    {t("meetings.overdue.resolve")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
