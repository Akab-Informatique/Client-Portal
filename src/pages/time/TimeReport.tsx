import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Loader2, PiggyBank } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";

type Report = {
  userId: string;
  name: string;
  from: string;
  to: string;
  workdayHours: number;
  workedHours: number;
  billableHours: number;
  nonBillableHours: number;
  billableRatio: number | null;
  bankedHours: number;
  paidHours: number;
  bankPaidHours: number;
  bankBalanceHours: number;
  types: { type: string; kind: string; hours: number; billableHours: number; bankedHours: number }[];
  weeks: { weekStart: string; workedHours: number; billableHours: number; bankedHours: number; workdayHours: number }[];
};
type Person = { id: string; name: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const mondayOf = (d: Date) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
/** The period chips: this week, this month, last month, this year (Québec local days). */
function periodOf(key: string): { from: string; to: string } {
  const now = new Date();
  if (key === "week") {
    const m = mondayOf(now);
    const e = new Date(m);
    e.setDate(m.getDate() + 6);
    return { from: iso(m), to: iso(e) };
  }
  if (key === "lastMonth") return { from: iso(new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1))), to: iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), 0))) };
  if (key === "year") return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
  return { from: iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))), to: iso(new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0))) };
}

/**
 * A person's time report over a period (their profile): hours worked, billable ones
 * and the ratio, what was banked instead of paid, the bank so far, per type and per
 * week. Managers can pick anyone's.
 */
export function TimeReportCard() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const manager = useCan()("timesheets.manage");
  const [period, setPeriod] = useState<"week" | "month" | "lastMonth" | "year">("month");
  const [who, setWho] = useState(me.id);
  const { from, to } = periodOf(period);
  const { data: people } = useQuery({ queryKey: ["time", "people"], queryFn: () => api.get<Person[]>("/time/people"), enabled: manager });
  const q = new URLSearchParams({ from, to, ...(who !== me.id ? { userId: who } : {}) }).toString();
  const { data, isLoading } = useQuery({ queryKey: ["time", "report", who, from, to], queryFn: () => api.get<Report>(`/time/report?${q}`) });
  const loc = i18n.language === "en" ? "en-CA" : "fr-CA";
  const h = (n: number) => n.toLocaleString(loc, { maximumFractionDigits: 2 });
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toLocaleString(loc, { maximumFractionDigits: 0 })} %` : "—");
  return (
    <div className="space-y-3">
      {manager && people && (
        <Select value={who} onValueChange={setWho}>
          <SelectTrigger className="h-8 w-full" aria-label={t("timesheet.person")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {people.map((x) => (
              <SelectItem key={x.id} value={x.id}>
                {x.id === me.id ? t("timesheet.me", { name: x.name }) : x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="grid grid-cols-4 gap-1 rounded-lg border p-0.5 text-[11px]" role="tablist">
        {(["week", "month", "lastMonth", "year"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={period === k} onClick={() => setPeriod(k)} className={cn("rounded-md px-1.5 py-1 font-medium", period === k ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground")}>
            {t(`profile.hours.period.${k}`)}
          </button>
        ))}
      </div>
      {isLoading || !data ? (
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Tile label={t("timesheet.worked")} value={`${h(data.workedHours)} h`} />
            <Tile label={t("timesheet.billable")} value={`${h(data.billableHours)} h`} tone="text-emerald-300" />
            <Tile label={t("timesheet.nonBillable")} value={`${h(data.nonBillableHours)} h`} tone="text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("timesheet.ratio")}</span>
              <span className="font-mono text-sm font-semibold text-foreground">{data.billableRatio === null ? "—" : `${data.billableRatio.toLocaleString(loc, { maximumFractionDigits: 1 })} %`}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted/60">
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-300" style={{ width: `${data.workedHours ? Math.min(100, (data.billableHours / data.workedHours) * 100) : 0}%` }} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-sky-400/25 bg-sky-500/[0.06] p-2 text-center sm:grid-cols-4">
            <Tile label={t("timesheet.bankedPeriod")} value={`+${h(data.bankedHours)} h`} tone="text-sky-300" small />
            <Tile label={t("timesheet.bankPaidPeriod")} value={`−${h(data.bankPaidHours)} h`} tone="text-sky-300" small />
            <Tile label={t("timesheet.paidPeriod")} value={`${h(data.paidHours)} h`} small />
            <Tile label={t("timesheet.bankBalance")} value={`${h(data.bankBalanceHours)} h`} tone="text-sky-300" small icon />
          </div>
          {data.workdayHours > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {t("timesheet.workdays")} : <span className="font-mono text-foreground">{h(data.workdayHours)} h</span> · {t("timesheet.workdayNote")}
            </p>
          )}
          {data.types.length > 0 && (
            <ul className="space-y-1 text-sm">
              {data.types.map((x) => (
                <li key={x.type} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{x.type}</span>
                  <span className="w-10 text-right text-[11px] text-muted-foreground">{pct(x.hours, data.workedHours)}</span>
                  <span className="w-16 text-right font-mono">{h(x.hours)} h</span>
                  {x.bankedHours > 0 && <span className="rounded-full border border-sky-400/40 bg-sky-500/10 px-1.5 py-px text-[10px] text-sky-300">{t("timesheet.bankTag")} {h(x.bankedHours)}</span>}
                </li>
              ))}
            </ul>
          )}
          {data.weeks.length > 1 && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("profile.hours.byWeek")}</p>
              <ul className="space-y-0.5 text-xs">
                {data.weeks.map((w) => (
                  <li key={w.weekStart} className="flex items-center gap-2">
                    <span className="w-24 text-muted-foreground">{new Intl.DateTimeFormat(loc, { day: "numeric", month: "short" }).format(new Date(`${w.weekStart}T12:00:00`))}</span>
                    <span className="flex-1 font-mono">{h(w.workedHours)} h</span>
                    <span className="font-mono text-emerald-300">{h(w.billableHours)}</span>
                    {w.bankedHours > 0 && <span className="font-mono text-sky-300">{h(w.bankedHours)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!data.workedHours && !data.workdayHours && <p className="text-xs text-muted-foreground">{t("timesheet.empty")}</p>}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, tone, small, icon }: { label: string; value: string; tone?: string; small?: boolean; icon?: boolean }) {
  return (
    <div>
      <p className={cn("flex items-center justify-center gap-1 font-mono font-semibold", small ? "text-sm" : "text-base", tone)}>
        {icon && <PiggyBank className="size-3.5" />} {value}
      </p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
