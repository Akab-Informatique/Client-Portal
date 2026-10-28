import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { SALES_PERIODS, type SalesKind, type SalesPeriod, type SalesStage } from "@shared/sales";

export type Opportunity = {
  id: string;
  companyName: string;
  clientId: string | null;
  clientName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  source: string;
  kind: SalesKind;
  users: number | null;
  ratePerUserCents: number;
  oneTimeCents: number | null;
  stage: SalesStage;
  probability: number;
  openedOn: string;
  quoteSentOn: string | null;
  closedOn: string | null;
  nextFollowUp: string | null;
  lostReason: string | null;
  notes: string | null;
  ownerId: string | null;
  ownerName: string | null;
  monthlyCents: number;
  overdue: boolean;
};

type Count = { key: string; count: number; mrrCents: number; oneTimeCents: number };
export type SalesDashboard = {
  period: SalesPeriod;
  from: string;
  to: string;
  fiscalYear: number;
  quarter: number;
  today: string;
  results: {
    mrrAddedCents: number;
    mrrAddedDeals: number;
    mrrTotalCents: number;
    usersUnderContract: number;
    oneTimeWonCents: number;
    oneTimeWonDeals: number;
    mrrSeries: { month: string; mrrCents: number; addedCents: number }[];
  };
  pipeline: {
    openDeals: number;
    openMrrCents: number;
    weightedMrrCents: number;
    openOneTimeCents: number;
    weightedOneTimeCents: number;
    byStage: { stage: SalesStage; count: number; mrrCents: number }[];
  };
  efficiency: { won: number; lost: number; conversionPct: number | null; avgCycleDays: number | null; bySource: Count[]; lostReasons: Count[] };
  activity: { overdue: Opportunity[]; dueToday: number; quotesSent: number; quotesSentBy: "week" | "month"; quotesSentSeries: { start: string; count: number }[] };
};

/** One colour per stage (column header, chip, bar) */
export const STAGE_TONE: Record<SalesStage, string> = {
  lead: "bg-slate-400",
  contact: "bg-sky-400",
  meeting: "bg-violet-400",
  quote_sent: "bg-[color:var(--gold)]",
  won: "bg-emerald-400",
  lost: "bg-red-400",
};

export const useOpportunities = () => useQuery({ queryKey: ["sales", "opportunities"], queryFn: () => api.get<Opportunity[]>("/sales/opportunities"), refetchInterval: 30_000 });
export const useSalesStaff = () => useQuery({ queryKey: ["sales", "staff"], queryFn: () => api.get<{ id: string; name: string }[]>("/sales/staff"), staleTime: 60_000 });
export const useSalesClients = () => useQuery({ queryKey: ["sales", "clients"], queryFn: () => api.get<{ id: string; name: string }[]>("/sales/clients"), staleTime: 60_000 });

/** The page's filters, kept in the address: tab, period, reference day, salesperson */
export function useSalesFilters() {
  const [sp, setSp] = useSearchParams();
  const period = (SALES_PERIODS as readonly string[]).includes(sp.get("period") ?? "") ? (sp.get("period") as SalesPeriod) : "month";
  const set = (patch: Record<string, string | null>) =>
    setSp(
      (cur) => {
        const next = new URLSearchParams(cur);
        for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
        return next;
      },
      { replace: true },
    );
  return {
    tab: (sp.get("tab") ?? "dashboard") as "dashboard" | "pipeline" | "list",
    period,
    day: sp.get("day"),
    owner: sp.get("owner") ?? "all",
    set,
  };
}

export const salesError = (e: unknown, t: (k: string) => string) =>
  e instanceof ApiError && ["lost_reason_required", "owner_invalid", "client_not_found"].includes(e.code) ? t(`sales.errors.${e.code}`) : t("common.error");

/** "1 800 $" without cents when round, for the cards */
export const shortMoney = (cents: number, lang: string) =>
  new Intl.NumberFormat(lang === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD", maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
