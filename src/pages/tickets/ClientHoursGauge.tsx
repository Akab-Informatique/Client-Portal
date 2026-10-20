import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { classStyle } from "@/lib/clientClass";
import { cn } from "@/lib/utils";
import type { TicketDetail } from "./shared";

type Info = NonNullable<TicketDetail["client"]>;
const hoursText = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));

/**
 * Hours worked for the ticket's client this month, as a ring; the client's
 * classification (Or, Argent, MSP…) under the number. With a monthly goal
 * (from the contract, not set yet) the ring fills towards it; without one it
 * only shows the total.
 */
export function ClientHoursGauge({ info, big }: { info: Info | null; big: boolean }) {
  const { t, i18n } = useTranslation();
  const size = big ? 112 : 76;
  const stroke = big ? 8 : 6;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const goal = info?.goal ?? null;
  const ratio = info ? (goal ? Math.min(info.hours / goal, 1) : info.hours > 0 ? 1 : 0) : 0;
  const over = goal != null && info != null && info.hours > goal;
  const cls = info?.class ?? null;
  const tone = over ? "#f87171" : cls ? classStyle(cls.color).stroke : "#f5b800";
  const month = info ? new Date(`${info.month}-01T12:00:00`).toLocaleDateString(i18n.language, { month: "long", year: "numeric" }) : "";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t("tickets.hours.title")}
          className="relative shrink-0 rounded-full transition hover:brightness-125 data-[state=open]:brightness-125"
          style={{ width: size, height: size }}
        >
          <svg width={size} height={size} className="-rotate-90">
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-border/60" />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={tone}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - ratio)}
              opacity={goal ? 1 : 0.55}
              style={{ transition: "stroke-dashoffset .5s" }}
            />
          </svg>
          <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
            <span className={cn("font-display font-bold", big ? "text-2xl" : "text-base")}>
              {info ? hoursText(info.hours) : "–"}
              {big && <span className="ml-0.5 text-xs font-normal text-muted-foreground">{t("tickets.hours.hoursShort")}</span>}
            </span>
            <span className={cn("mt-0.5 uppercase tracking-wide text-muted-foreground", big ? "text-[10px]" : "text-[9px]")}>{cls ? cls.name : t("tickets.hours.hoursShort")}</span>
            {big && <span className="mt-0.5 max-w-[80%] truncate text-[9px] capitalize text-muted-foreground/80">{month}</span>}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-2 p-3 text-sm">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tickets.hours.title")}</p>
        <p className="font-display text-2xl font-bold">
          {info ? hoursText(info.hours) : "–"} <span className="text-sm font-normal text-muted-foreground">{t("tickets.hours.hoursShort")}</span>
        </p>
        <p className="text-xs capitalize text-muted-foreground">{month}</p>
        <p className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t("tickets.hours.class")}</span>
          {cls ? <span className={cn("rounded-full border px-2 py-px text-[11px] font-medium", classStyle(cls.color).pill)}>{cls.name}</span> : <span className="italic text-muted-foreground">{t("tickets.hours.noClass")}</span>}
        </p>
        <p className="text-xs text-muted-foreground">{goal ? t("tickets.hours.goal", { hours: hoursText(goal) }) : t("tickets.hours.noGoal")}</p>
        <p className="border-t pt-2 text-[11px] text-muted-foreground">{t("tickets.hours.note")}</p>
      </PopoverContent>
    </Popover>
  );
}
