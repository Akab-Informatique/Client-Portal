import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";

type Profit = { contractId: string; name: string; month: string; revenueCents: number; serviceCostCents: number; labourCostCents: number; hours: number; missingWages: number; profitCents: number };

/** Administrators only: what the ticket's contract earns or loses this month (billed less services and hours at each technician's wage) */
export function ContractProfit({ ticketId }: { ticketId: number }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const allowed = can("hr.manage");
  const { data } = useQuery({ queryKey: ["tickets", "contract-profit", ticketId], queryFn: () => api.get<Profit | null>(`/tickets/${ticketId}/contract-profit`), enabled: allowed, refetchInterval: 60_000, staleTime: 30_000 });
  if (!allowed || !data) return null;
  const up = data.profitCents >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  const row = (label: string, cents: number, sign = "") => (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{sign}{money(cents, i18n.language)}</span>
    </div>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold", up ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300")} title={t("tickets.profit.title", { name: data.name })}>
          <Icon className="size-3" />
          {up ? "+" : "−"}
          {money(Math.abs(data.profitCents), i18n.language)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-1.5 text-xs">
        <p className="font-semibold">{t("tickets.profit.title", { name: data.name })}</p>
        <p className="text-muted-foreground">{t("tickets.profit.month", { month: data.month })}</p>
        {row(t("tickets.profit.revenue"), data.revenueCents)}
        {row(t("tickets.profit.services"), data.serviceCostCents, "−")}
        {row(t("tickets.profit.labour", { hours: data.hours }), data.labourCostCents, "−")}
        <div className="border-t pt-1.5 font-semibold">{row(up ? t("tickets.profit.gain") : t("tickets.profit.loss"), Math.abs(data.profitCents))}</div>
        {data.missingWages > 0 && <p className="text-amber-300">{t("tickets.profit.missing", { count: data.missingWages })}</p>}
        <p className="text-[10px] text-muted-foreground">{t("tickets.profit.hint")}</p>
      </PopoverContent>
    </Popover>
  );
}
