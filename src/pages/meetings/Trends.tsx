import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Inbox, LineChart, ListChecks, Timer, TimerReset, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";

type Measure = {
  from: string;
  to: string;
  created: number;
  resolved: number;
  avgHours: number | null;
  medianHours: number | null;
  within24h: number | null;
  backlog: number;
};
type Trends = { demo: boolean; generatedAt: string; weeks: (Measure & { monday: string; current: boolean })[]; live: Measure; past: Measure[] };

type MetricKey = "created" | "resolved" | "backlog" | "avgHours" | "medianHours" | "within24h";
/** What "better" means for each figure: up (more is better) or down */
const METRICS: { key: MetricKey; icon: LucideIcon; better: "up" | "down" }[] = [
  { key: "created", icon: Inbox, better: "down" },
  { key: "resolved", icon: ListChecks, better: "up" },
  { key: "backlog", icon: LineChart, better: "down" },
  { key: "avgHours", icon: Timer, better: "down" },
  { key: "medianHours", icon: TimerReset, better: "down" },
  { key: "within24h", icon: Zap, better: "up" },
];
const RANGES = [12, 26, 52];

const locale = () => (currentLocale() === "en" ? "en-CA" : "fr-CA");
/** "12 oct." / "Oct 12" */
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short" }).format(new Date(iso.length === 10 ? `${iso}T12:00:00` : iso));
const num = (v: number, digits = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(v);

/** Change between now and then, in % (null when it cannot be told) */
const change = (now: number | null, then: number | null) =>
  now == null || then == null ? null : then === 0 ? (now === 0 ? 0 : null) : ((now - then) / then) * 100;

/** Weekly meeting: are tickets going up or down, and how fast are they resolved. */
export function TrendsSection() {
  const { t } = useTranslation();
  const [weeks, setWeeks] = useState(12);
  // compare the last 7 days with the same 7 days `ago` weeks earlier
  const [ago, setAgo] = useState(1);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meetings", "trends", weeks],
    queryFn: () => api.get<Trends>(`/meetings/trends?weeks=${weeks}`),
    refetchInterval: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  const offset = Math.min(ago, weeks);
  const past = data?.past[offset - 1];

  const hours = (h: number | null) =>
    h == null ? "—" : h < 24 ? t("meetings.trends.hours", { value: num(h, 1) }) : t("meetings.trends.days", { value: num(h / 24, 1) });
  const show = (k: MetricKey, m: Measure) =>
    k === "avgHours" || k === "medianHours" ? hours(m[k]) : k === "within24h" ? (m.within24h == null ? "—" : `${m.within24h} %`) : num(m[k]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <LineChart className="size-5 text-primary" /> {t("meetings.trends.title")}
            {data?.demo && (
              <span className="rounded-full border px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                {t("meetings.trends.sample")}
              </span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground">{t("meetings.trends.subtitle")}</p>
        </div>
        <div className="flex rounded-lg border p-0.5" role="group" aria-label={t("meetings.trends.range")}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={weeks === r}
              onClick={() => {
                setWeeks(r);
                setAgo((v) => Math.min(v, r));
              }}
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                weeks === r ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("meetings.trends.weeks", { count: r })}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : isError || !data || !past ? (
        <p className="py-12 text-center text-muted-foreground">{t("common.error")}</p>
      ) : (
        <div className="space-y-4">
          {/* Live against the past: pick how far back */}
          <div className="rounded-2xl border bg-card/80 p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <p className="text-sm">
                <span className="font-medium">{t("meetings.trends.live")}</span>{" "}
                <span className="text-muted-foreground">
                  ({shortDate(data.live.from)} – {shortDate(data.live.to)})
                </span>{" "}
                {t("meetings.trends.versus")} <span className="font-medium text-primary">{t("meetings.trends.weeksAgo", { count: offset })}</span>{" "}
                <span className="text-muted-foreground">
                  ({shortDate(past.from)} – {shortDate(past.to)})
                </span>
              </p>
              <div className="ml-auto flex flex-wrap gap-1">
                {[1, 4, 13, 26, 52]
                  .filter((n) => n <= weeks)
                  .map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setAgo(n)}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                        offset === n ? "border-primary/50 bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(`meetings.trends.quick.${n}`)}
                    </button>
                  ))}
              </div>
            </div>
            <input
              type="range"
              min={1}
              max={weeks}
              value={offset}
              onChange={(e) => setAgo(Number(e.target.value))}
              className="mt-3 w-full accent-[color:var(--gold)]"
              aria-label={t("meetings.trends.compareTo")}
            />
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
              {METRICS.map((m) => (
                <Metric
                  key={m.key}
                  icon={m.icon}
                  label={t(`meetings.trends.metric.${m.key}`)}
                  now={show(m.key, data.live)}
                  then={show(m.key, past)}
                  delta={change(data.live[m.key], past[m.key])}
                  better={m.better}
                />
              ))}
            </div>
          </div>

          {/* Week by week: chart, then the table (a click compares with that week) */}
          <div className="rounded-2xl border bg-card/80 p-4">
            <Chart weeks={data.weeks} picked={offset} onPick={(k) => k > 0 && setAgo(k)} />
          </div>
          <div className="overflow-x-auto rounded-2xl border bg-card/80">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="px-4 py-2.5 text-left font-medium">{t("meetings.trends.col.week")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("meetings.trends.metric.created")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("meetings.trends.metric.resolved")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("meetings.trends.col.net")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("meetings.trends.metric.backlog")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("meetings.trends.metric.avgHours")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("meetings.trends.metric.medianHours")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("meetings.trends.metric.within24h")}</th>
                  <th className="px-4 py-2.5 text-center font-medium">{t("meetings.trends.col.trend")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.weeks.map((w, k) => {
                  const prev = data.weeks[k + 1];
                  const net = w.created - w.resolved;
                  return (
                    <tr
                      key={w.monday}
                      onClick={() => k > 0 && setAgo(k)}
                      className={cn("transition-colors", k > 0 && "cursor-pointer hover:bg-muted/40", k === offset && "bg-primary/10")}
                    >
                      <td className="px-4 py-2">
                        {w.current ? (
                          <span className="font-medium">{t("meetings.trends.thisWeek")}</span>
                        ) : (
                          t("meetings.trends.weekOf", { date: shortDate(w.monday) })
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(w.created)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(w.resolved)}</td>
                      <td
                        className={cn("px-3 py-2 text-right tabular-nums", net > 0 ? "text-red-400" : net < 0 ? "text-emerald-500" : "text-muted-foreground")}
                      >
                        {net > 0 ? `+${net}` : net}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(w.backlog)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{hours(w.avgHours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{hours(w.medianHours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{w.within24h == null ? "—" : `${w.within24h} %`}</td>
                      <td className="px-4 py-2 text-center">{prev ? <Arrow delta={change(w.backlog, prev.backlog)} better="down" /> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t("meetings.trends.tableHint")}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  now,
  then,
  delta,
  better,
}: {
  icon: LucideIcon;
  label: string;
  now: string;
  then: string;
  delta: number | null;
  better: "up" | "down";
}) {
  return (
    <div className="rounded-xl border bg-background/40 p-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 text-primary" /> {label}
      </p>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="font-display text-2xl font-bold tabular-nums">{now}</span>
        <Arrow delta={delta} better={better} withValue />
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{then}</p>
    </div>
  );
}

/** Up / down / flat, green when it goes the right way */
function Arrow({ delta, better, withValue }: { delta: number | null; better: "up" | "down"; withValue?: boolean }) {
  const { t } = useTranslation();
  if (delta == null) return <span className="text-xs text-muted-foreground">—</span>;
  const flat = Math.abs(delta) < 3;
  const up = delta > 0;
  const good = flat ? null : up === (better === "up");
  const Icon = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium tabular-nums",
        good == null ? "text-muted-foreground" : good ? "text-emerald-500" : "text-red-400",
      )}
      title={flat ? t("meetings.trends.flat") : up ? t("meetings.trends.up") : t("meetings.trends.down")}
    >
      <Icon className="size-4" />
      {withValue && `${up && !flat ? "+" : ""}${Math.round(delta)} %`}
    </span>
  );
}

/** Created and resolved per week (bars), average resolution time (line); oldest on the left. */
function Chart({ weeks, picked, onPick }: { weeks: Trends["weeks"]; picked: number; onPick: (k: number) => void }) {
  const { t } = useTranslation();
  const list = [...weeks].reverse();
  const n = list.length;
  const W = 900;
  const H = 220;
  const pad = { l: 34, r: 40, t: 12, b: 26 };
  const cw = (W - pad.l - pad.r) / n;
  const maxCount = Math.max(1, ...list.flatMap((w) => [w.created, w.resolved]));
  const maxHours = Math.max(1, ...list.map((w) => w.avgHours ?? 0));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / maxCount);
  const yh = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / maxHours);
  const bw = Math.max(2, Math.min(14, cw / 3));
  const line = list
    .map((w, i) => (w.avgHours == null ? null : `${pad.l + cw * i + cw / 2},${yh(w.avgHours)}`))
    .filter(Boolean)
    .join(" ");
  const every = Math.ceil(n / 13);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-sky-400/80" /> {t("meetings.trends.metric.created")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-emerald-400/80" /> {t("meetings.trends.metric.resolved")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-[color:var(--gold)]" /> {t("meetings.trends.metric.avgHours")}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={t("meetings.trends.title")}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(maxCount * f)} y2={y(maxCount * f)} className="stroke-border" strokeDasharray="3 4" />
            <text x={pad.l - 6} y={y(maxCount * f) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {Math.round(maxCount * f)}
            </text>
            <text x={W - pad.r + 6} y={yh(maxHours * f) + 4} className="fill-muted-foreground text-[10px]">
              {Math.round(maxHours * f)} h
            </text>
          </g>
        ))}
        {list.map((w, i) => {
          const k = n - 1 - i;
          const x = pad.l + cw * i;
          return (
            <g key={w.monday} className={cn(k > 0 && "cursor-pointer")} onClick={() => onPick(k)}>
              <title>
                {`${w.current ? t("meetings.trends.thisWeek") : t("meetings.trends.weekOf", { date: shortDate(w.monday) })} — ${t("meetings.trends.metric.created")}: ${w.created}, ${t("meetings.trends.metric.resolved")}: ${w.resolved}`}
              </title>
              <rect
                x={x}
                y={pad.t}
                width={cw}
                height={H - pad.t - pad.b}
                className={cn(k === picked ? "fill-[color:var(--gold)]/12" : "fill-transparent hover:fill-foreground/5")}
              />
              <rect x={x + cw / 2 - bw - 1} y={y(w.created)} width={bw} height={Math.max(0, H - pad.b - y(w.created))} rx={2} className="fill-sky-400/80" />
              <rect x={x + cw / 2 + 1} y={y(w.resolved)} width={bw} height={Math.max(0, H - pad.b - y(w.resolved))} rx={2} className="fill-emerald-400/80" />
              {(i % every === 0 || i === n - 1) && (
                <text x={x + cw / 2} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {shortDate(w.monday)}
                </text>
              )}
            </g>
          );
        })}
        <polyline points={line} fill="none" stroke="var(--gold)" strokeWidth={2} strokeLinejoin="round" className="pointer-events-none" />
      </svg>
    </div>
  );
}
