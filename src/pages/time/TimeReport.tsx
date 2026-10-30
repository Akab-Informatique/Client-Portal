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
  bankedHours: number;
  vacationHours: number;
  sickHours: number;
  holidayHours: number;
  holidayCents: number;
  bankPaidHours: number;
  enteredHours: number;
  paidHours: number;
  types: { type: string; kind: string; hours: number }[];
  weeks: { weekStart: string; workdayHours: number; bankedHours: number; paidHours: number; enteredHours: number }[];
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
 * A person's time report over a period (their profile): the hours PAID — work days (less what is put in the bank), vacation,
 * sick days, holidays and hours paid out of the bank — per type and per week. Billable time is not part of it. Managers can
 * pick anyone's.
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
  const money = (cents: number) => new Intl.NumberFormat(loc, { style: "currency", currency: "CAD" }).format(cents / 100);
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
            <Tile label={t("timesheet.workdays")} value={`${h(data.workdayHours)} h`} />
            <Tile label={t("timesheet.bankedWeek")} value={`${h(data.bankedHours)} h`} tone="text-sky-300" icon />
            <Tile label={t("timesheet.paidTotal")} value={`${h(data.paidHours)} h`} tone="text-emerald-300" />
          </div>
          {(data.vacationHours > 0 || data.sickHours > 0 || data.holidayHours > 0 || data.bankPaidHours > 0) && (
            <ul className="space-y-1 rounded-xl border bg-card/40 p-2.5 text-sm">
              {data.vacationHours > 0 && <Line label={t("timesheet.paidVacation")} value={`${h(data.vacationHours)} h`} />}
              {data.sickHours > 0 && <Line label={t("timesheet.paidSick")} value={`${h(data.sickHours)} h`} />}
              {data.holidayHours > 0 && <Line label={t("timesheet.paidHoliday")} value={`${h(data.holidayHours)} h (${money(data.holidayCents)})`} />}
              {data.bankPaidHours > 0 && <Line label={t("timesheet.paidBank")} value={`${h(data.bankPaidHours)} h`} />}
            </ul>
          )}
          {data.types.length > 0 && (
            <ul className="space-y-1 text-sm">
              {data.types.map((x) => (
                <li key={x.type} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{x.type}</span>
                  <span className="w-16 text-right font-mono">{h(x.hours)} h</span>
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
                    <span className="flex-1 font-mono">{h(w.paidHours)} h</span>
                    {w.bankedHours > 0 && <span className="font-mono text-sky-300">{h(w.bankedHours)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!data.paidHours && !data.workdayHours && !data.enteredHours && <p className="text-xs text-muted-foreground">{t("timesheet.empty")}</p>}
        </>
      )}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex justify-between gap-2">
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </li>
  );
}

function Tile({ label, value, tone, icon }: { label: string; value: string; tone?: string; icon?: boolean }) {
  return (
    <div>
      <p className={cn("flex items-center justify-center gap-1 font-mono text-base font-semibold", tone)}>
        {icon && <PiggyBank className="size-3.5" />} {value}
      </p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
