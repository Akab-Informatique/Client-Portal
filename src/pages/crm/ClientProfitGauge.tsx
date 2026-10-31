import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Info, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { LEVEL_FAIR_FROM, LEVEL_HEALTHY_FROM, type ProfitLevel } from "@shared/profitability";
import { money } from "./shared";

type Data = {
  days: number;
  revenueCents: number;
  revenueBy: { recurring: number; labour: number; other: number };
  labourCostCents: number;
  goodsCostCents: number;
  serviceCostCents: number;
  costCents: number;
  profitCents: number;
  marginPct: number | null;
  hours: number;
  billedHours: number;
  revenuePerHourCents: number | null;
  costPerHourCents: number | null;
  missingWages: number;
  level: ProfitLevel | null;
};

const MIN = -50;
const MAX = 100;
const COLORS: Record<ProfitLevel, string> = { loss: "#f87171", weak: "#fb923c", fair: "#facc15", healthy: "#34d399" };
const point = (m: number, r: number) => {
  const a = Math.PI * (1 - (Math.max(MIN, Math.min(MAX, m)) - MIN) / (MAX - MIN));
  return [100 + r * Math.cos(a), 100 - r * Math.sin(a)] as const;
};
const arc = (from: number, to: number, r = 80) => {
  const [x1, y1] = point(from, r);
  const [x2, y2] = point(to, r);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};

/**
 * How profitable the client is for us: money in against the time spent (formula in shared/profitability.ts). ADMINISTRATORS ONLY —
 * it is not even asked for without the right (the server refuses technicians, client users and "view as client" too).
 */
export function ClientProfitGauge({ clientId }: { clientId: string }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const allowed = can("hr.manage");
  const [days, setDays] = useState(90);
  const { data } = useQuery({ queryKey: ["crm", "client", clientId, "profitability", days], queryFn: () => api.get<Data>(`/crm/clients/${clientId}/profitability?days=${days}`), enabled: allowed, staleTime: 60_000, retry: false });
  if (!allowed || !data) return null;
  const lang = i18n.language;
  const level = data.level;
  const tone = level ? COLORS[level] : "#94a3b8";
  const margin = data.marginPct;
  const [nx, ny] = point(margin ?? MIN, 62);
  const cash = (c: number | null) => (c === null ? "—" : money(c, lang));
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-2xl border bg-background/40 p-4">
      <div className="w-52 shrink-0">
        <svg viewBox="0 0 200 118" className="w-full" role="img" aria-label={t("crm.profit.title")}>
          <path d={arc(MIN, 0)} stroke={COLORS.loss} strokeWidth="14" fill="none" opacity="0.85" />
          <path d={arc(0, LEVEL_FAIR_FROM)} stroke={COLORS.weak} strokeWidth="14" fill="none" opacity="0.85" />
          <path d={arc(LEVEL_FAIR_FROM, LEVEL_HEALTHY_FROM)} stroke={COLORS.fair} strokeWidth="14" fill="none" opacity="0.85" />
          <path d={arc(LEVEL_HEALTHY_FROM, MAX)} stroke={COLORS.healthy} strokeWidth="14" fill="none" opacity="0.85" />
          <line x1="100" y1="100" x2={nx} y2={ny} stroke={tone} strokeWidth="3.5" strokeLinecap="round" />
          <circle cx="100" cy="100" r="6" fill={tone} />
          <text x="100" y="116" textAnchor="middle" className="fill-foreground font-mono text-[15px] font-bold">
            {margin === null ? "—" : `${margin} %`}
          </text>
        </svg>
        <p className="-mt-1 text-center text-xs font-semibold" style={{ color: tone }}>
          {level ? t(`crm.profit.level.${level}`) : t("crm.profit.noData")}
        </p>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            {t("crm.profit.title")}
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300" title={t("crm.profit.adminOnlyHint")}>
              <ShieldAlert className="size-3" /> {t("crm.profit.adminOnly")}
            </span>
          </p>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="ml-auto h-8 rounded-md border bg-transparent px-2 text-xs" aria-label={t("crm.profit.period")}>
            {[30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                {t("crm.profit.lastDays", { count: d })}
              </option>
            ))}
          </select>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">{t("crm.profit.revenue")}</dt>
            <dd className="font-mono text-sm font-semibold">{money(data.revenueCents, lang)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("crm.profit.cost")}</dt>
            <dd className="font-mono text-sm font-semibold">{money(data.costCents, lang)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("crm.profit.profit")}</dt>
            <dd className="font-mono text-sm font-semibold" style={{ color: tone }}>
              {data.profitCents < 0 ? "−" : ""}
              {money(Math.abs(data.profitCents), lang)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("crm.profit.hours")}</dt>
            <dd className="font-mono text-sm font-semibold">
              {data.hours} h{" "}
              <span className="font-sans text-[11px] font-normal text-muted-foreground">
                ({data.billedHours} h {t("crm.profit.billed")})
              </span>
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">{t("crm.profit.perHour")}</dt>
            <dd className={cn("font-mono text-sm font-semibold", data.revenuePerHourCents !== null && data.costPerHourCents !== null && data.revenuePerHourCents < data.costPerHourCents && "text-red-300")}>
              {cash(data.revenuePerHourCents)} / h <span className="font-sans text-[11px] font-normal text-muted-foreground">{t("crm.profit.vsCost", { cost: cash(data.costPerHourCents) })}</span>
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">{t("crm.profit.revenueBy")}</dt>
            <dd className="text-[11px]">
              {t("crm.profit.recurring")} {money(data.revenueBy.recurring, lang)} · {t("crm.profit.labour")} {money(data.revenueBy.labour, lang)} · {t("crm.profit.other")} {money(data.revenueBy.other, lang)}
            </dd>
          </div>
        </dl>
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 size-3 shrink-0" />
          <span>
            {t("crm.profit.formula", { fair: LEVEL_FAIR_FROM, healthy: LEVEL_HEALTHY_FROM })}
            {data.missingWages > 0 ? ` ${t("crm.contracts.profit.missing", { count: data.missingWages })}` : ""}
          </span>
        </p>
      </div>
    </div>
  );
}
