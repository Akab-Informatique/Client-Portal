import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { CalendarRange, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The time frame of accounting work (Approbation, Éléments à facturer): a day,
 * a week (Monday to Sunday), a month (the default: this month) or chosen days.
 * Kept in the address (?period=&from=&to=); only the work of these days is
 * listed and invoiced.
 */
export type PeriodUnit = "day" | "week" | "month" | "custom";
export type Period = { unit: PeriodUnit; from: string; to: string };
const UNITS: PeriodUnit[] = ["day", "week", "month", "custom"];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const isDay = (s: string | null): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parse(s).getTime()));

/** The day, week or month around a day */
export function frame(unit: Exclude<PeriodUnit, "custom">, day: string): { from: string; to: string } {
  const d = parse(day);
  if (unit === "day") return { from: day, to: day };
  if (unit === "week") {
    const monday = addDays(day, -((d.getDay() + 6) % 7));
    return { from: monday, to: addDays(monday, 6) };
  }
  return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
}

/** The time frame in the address; this month when none */
export function usePeriod() {
  const [params, setParams] = useSearchParams();
  const unit = (UNITS.includes(params.get("period") as PeriodUnit) ? params.get("period") : "month") as PeriodUnit;
  const today = ymd(new Date());
  let from = params.get("from");
  let to = params.get("to");
  if (unit === "custom") {
    if (!isDay(from) || !isDay(to) || to < from) ({ from, to } = frame("month", today));
  } else ({ from, to } = frame(unit, isDay(from) ? from : today));
  const period: Period = { unit, from: from!, to: to! };
  const set = (p: Period) =>
    setParams(
      (q) => {
        // this month: nothing in the address
        const isDefault = p.unit === "month" && p.from === frame("month", today).from;
        for (const [k, v] of [
          ["period", isDefault ? null : p.unit],
          ["from", isDefault ? null : p.from],
          ["to", isDefault || p.unit !== "custom" ? null : p.to],
        ] as const)
          v ? q.set(k, v) : q.delete(k);
        return q;
      },
      { replace: true },
    );
  return { period, set, query: `from=${period.from}&to=${period.to}` };
}

/** The time frame picker: day / week / month / chosen days, ‹ › to step, back to this month. */
export function PeriodBar({ period, onChange, className }: { period: Period; onChange: (p: Period) => void; className?: string }) {
  const { t, i18n } = useTranslation();
  const loc = i18n.language === "en" ? "en-CA" : "fr-CA";
  const f = (s: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, o).format(parse(s));
  const label =
    period.unit === "day"
      ? f(period.from, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : period.unit === "month"
        ? f(period.from, { month: "long", year: "numeric" })
        : `${f(period.from, { day: "numeric", month: "short" })} – ${f(period.to, { day: "numeric", month: "short", year: "numeric" })}`;
  const step = (n: number) => {
    if (period.unit === "custom") {
      const len = Math.round((parse(period.to).getTime() - parse(period.from).getTime()) / 86_400_000) + 1;
      onChange({ unit: "custom", from: addDays(period.from, n * len), to: addDays(period.to, n * len) });
    } else if (period.unit === "month") {
      const d = parse(period.from);
      onChange({ unit: "month", ...frame("month", ymd(new Date(d.getFullYear(), d.getMonth() + n, 1))) });
    } else onChange({ unit: period.unit, ...frame(period.unit, addDays(period.from, n * (period.unit === "week" ? 7 : 1))) });
  };
  const today = ymd(new Date());
  const isNow = period.from <= today && today <= period.to && period.unit === "month";
  return (
    <div className={cn("glass flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border px-3 py-2.5", className)}>
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <CalendarRange className="size-4 text-primary" /> {t("period.title")}
      </span>
      <div className="flex rounded-lg border p-0.5" role="group" aria-label={t("period.title")}>
        {UNITS.map((u) => (
          <button
            key={u}
            type="button"
            aria-pressed={period.unit === u}
            onClick={() => onChange(u === "custom" ? { unit: "custom", from: period.from, to: period.to } : { unit: u, ...frame(u, period.from <= today && today <= period.to ? today : period.from) })}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition-colors",
              period.unit === u ? "bg-[color:var(--gold)]/15 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`period.${u}`)}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <button type="button" onClick={() => step(-1)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("period.previous")}>
          <ChevronLeft className="size-4" />
        </button>
        <span className="min-w-36 text-center text-sm font-semibold capitalize">{label}</span>
        <button type="button" onClick={() => step(1)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("period.next")}>
          <ChevronRight className="size-4" />
        </button>
      </div>

      {/* pick the day / week / month directly, or the two days */}
      {period.unit === "custom" ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Input type="date" className="h-8 w-36" value={period.from} max={period.to} onChange={(e) => e.target.value && onChange({ ...period, from: e.target.value })} aria-label={t("period.from")} />
          <span>→</span>
          <Input type="date" className="h-8 w-36" value={period.to} min={period.from} onChange={(e) => e.target.value && onChange({ ...period, to: e.target.value })} aria-label={t("period.to")} />
        </div>
      ) : period.unit === "month" ? (
        <Input
          type="month"
          className="h-8 w-40"
          value={period.from.slice(0, 7)}
          onChange={(e) => e.target.value && onChange({ unit: "month", ...frame("month", `${e.target.value}-01`) })}
          aria-label={t("period.month")}
        />
      ) : (
        <Input
          type="date"
          className="h-8 w-40"
          value={period.from}
          onChange={(e) => e.target.value && onChange({ unit: period.unit, ...frame(period.unit as "day" | "week", e.target.value) })}
          aria-label={t(`period.${period.unit}`)}
        />
      )}

      {!isNow && (
        <button type="button" onClick={() => onChange({ unit: "month", ...frame("month", today) })} className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline">
          <RotateCcw className="size-3.5" /> {t("period.thisMonth")}
        </button>
      )}
    </div>
  );
}
