import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlarmClock, ArrowRight, CalendarCheck } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { PointsSection } from "./Points";
import { ProjectsSection } from "./Projects";
import { WeekSection } from "./Week";
import { STATUS_STYLE, useChoiceText, type StatusKind } from "@/pages/tickets/shared";

type OverdueTicket = { id: number; overdue: boolean };
type Overdue = {
  demo: boolean;
  total: number;
  dueThisWeek: number;
  until: string;
  untilDate: string;
  technicians: { id: string; name: string; tickets: OverdueTicket[] }[];
  unassigned: OverdueTicket[];
  /** Open, nobody assigned, status past "new" */
  stray: { total: number; byStatus: { label: string; kind: string; count: number }[] };
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
  const late = people.map((p) => ({ id: p.id, name: p.name, count: p.tickets.filter((x) => x.overdue).length }));
  const week = people.map((p) => ({ id: p.id, name: p.name, count: p.tickets.filter((x) => !x.overdue).length }));

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
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <AlarmClock className="size-5 text-red-400" /> {t("meetings.overdue.title")}
        </h2>
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-72 rounded-2xl" />
            ))}
          </div>
        ) : isError || !data ? (
          <p className="py-16 text-center text-muted-foreground">{t("common.error")}</p>
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
            <GaugeCard title={t("meetings.overdue.gaugeLate")} total={data.total} people={late} />
            <GaugeCard title={t("meetings.overdue.gaugeWeek", { date: dayDate(`${data.untilDate}T12:00:00`) })} total={data.dueThisWeek} people={week} />
            <StrayCard stray={data.stray} />
          </div>
        )}
      </section>

      <ProjectsSection />
    </div>
  );
}

/** A gauge for the whole team, or the person picked under it. */
function GaugeCard({ title, total, people }: { title: string; total: number; people: { id: string; name: string; count: number }[] }) {
  const { t } = useTranslation();
  const [who, setWho] = useState<string | null>(null);
  const picked = people.find((p) => p.id === who);
  const value = picked ? picked.count : total;
  return (
    <div className="space-y-4 rounded-2xl border bg-card/80 p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold">{title}</h3>
        <span className="truncate text-sm text-muted-foreground">{picked ? picked.name : t("meetings.overdue.everyone")}</span>
      </div>
      <Gauge value={value} scale={WORKLOAD} />
      <div className="flex flex-wrap justify-center gap-1.5">
        <Chip active={who === null} onClick={() => setWho(null)} label={t("meetings.overdue.everyone")} count={total} scale={WORKLOAD} />
        {[...people]
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .map((p) => (
            <Chip key={p.id} active={who === p.id} onClick={() => setWho(who === p.id ? null : p.id)} label={p.name} count={p.count} scale={WORKLOAD} />
          ))}
      </div>
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
function StrayCard({ stray }: { stray: Overdue["stray"] }) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  return (
    <div className="space-y-4 rounded-2xl border bg-card/80 p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold">{t("meetings.overdue.gaugeStray")}</h3>
        <Link to="/tickets?view=unassigned" className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          {t("meetings.overdue.seeTickets")} <ArrowRight className="size-3.5" />
        </Link>
      </div>
      <Gauge value={stray.total} scale={STRAY} />
      <div className="flex flex-wrap justify-center gap-1.5">
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
    </div>
  );
}
