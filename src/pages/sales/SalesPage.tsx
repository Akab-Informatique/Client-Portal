import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Columns3, FileSignature, LayoutDashboard, List, Plus, TrendingUp } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { SALES_PERIODS, periodRange, shiftPeriod, type SalesStage } from "@shared/sales";
import { Board } from "./Board";
import { ContractsTab } from "./ContractsTab";
import { Dashboard } from "./Dashboard";
import { OpportunityDialog } from "./OpportunityDialog";
import { OpportunityList } from "./OpportunityList";
import { useOpportunities, useSalesFilters, useSalesStaff, type Opportunity, type SalesDashboard } from "./shared";

const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

/** Vente › Ventes: the dashboard of the salespeople, the pipeline as a board and the list of opportunities. */
export function SalesPage() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const me = useMe();
  const { tab, period, day: dayParam, owner, set } = useSalesFilters();
  const day = dayParam ?? todayQc();
  const range = periodRange(period, day);
  const { data: staff = [] } = useSalesStaff();
  const [editing, setEditing] = useState<{ opp?: Opportunity; stage?: SalesStage } | null>(null);

  const opps = useOpportunities();
  const ownerId = owner === "me" ? me.id : owner === "all" ? null : owner;
  const list = (opps.data ?? []).filter((o) => !ownerId || o.ownerId === ownerId);
  const dash = useQuery({
    queryKey: ["sales", "dashboard", period, day, owner],
    queryFn: () => api.get<SalesDashboard>(`/sales/dashboard?period=${period}&day=${day}${owner !== "all" ? `&owner=${owner}` : ""}`),
    refetchInterval: 30_000,
    enabled: tab === "dashboard",
    placeholderData: (prev) => prev,
  });

  const lang = i18n.language === "en" ? "en-CA" : "fr-CA";
  const mon = (d: string, withYear = false) => new Intl.DateTimeFormat(lang, { month: withYear ? "long" : "short", ...(withYear ? { year: "numeric" } : {}) }).format(new Date(`${d}T12:00:00`));
  const label =
    period === "month"
      ? mon(range.from, true)
      : period === "quarter"
        ? t("sales.period.quarterLabel", { q: range.quarter, year: range.fiscalYear, from: mon(range.from), to: mon(range.to) })
        : t("sales.period.yearLabel", { year: range.fiscalYear, from: mon(range.from, true), to: mon(range.to, true) });
  const isCurrent = periodRange(period, todayQc()).from === range.from;

  const tabs = [
    { key: "dashboard", icon: LayoutDashboard, label: t("sales.tab.dashboard") },
    { key: "pipeline", icon: Columns3, label: t("sales.tab.pipeline") },
    { key: "list", icon: List, label: t("sales.tab.list") },
    { key: "contracts", icon: FileSignature, label: t("sales.tab.contracts") },
  ] as const;

  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <TrendingUp className="size-6 text-primary" /> {t("sales.title")}
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("sales.subtitle")}</p>
        </div>
        {can("opportunities.edit") && (
          <Button onClick={() => setEditing({})}>
            <Plus className="size-4" /> {t("sales.add")}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" className="glass inline-flex rounded-xl border p-1">
          {tabs.map((x) => (
            <button
              key={x.key}
              role="tab"
              aria-selected={tab === x.key}
              onClick={() => set({ tab: x.key === "dashboard" ? null : x.key })}
              className={cn("flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors", tab === x.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              <x.icon className="size-4" /> {x.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label={t("sales.period.label")} className="glass inline-flex rounded-xl border p-1">
            {SALES_PERIODS.map((p) => (
              <button
                key={p}
                role="radio"
                aria-checked={period === p}
                onClick={() => set({ period: p === "month" ? null : p })}
                className={cn("rounded-lg px-3 py-1.5 text-sm transition-colors", period === p ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {t(`sales.period.${p}`)}
              </button>
            ))}
          </div>
          <div className="glass flex items-center rounded-xl border p-1">
            <Button variant="ghost" size="icon" className="size-8" onClick={() => set({ day: shiftPeriod(period, day, -1) })} aria-label={t("sales.period.prev")}>
              <ChevronLeft className="size-4" />
            </Button>
            <button type="button" className="min-w-40 px-2 text-center text-sm font-medium capitalize" onClick={() => set({ day: null })} title={t("sales.period.current")}>
              {label}
            </button>
            <Button variant="ghost" size="icon" className="size-8" onClick={() => set({ day: shiftPeriod(period, day, 1) })} aria-label={t("sales.period.next")}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
          {!isCurrent && (
            <Button variant="ghost" size="sm" onClick={() => set({ day: null })}>
              {t("sales.period.current")}
            </Button>
          )}
          <Select value={owner} onValueChange={(v) => set({ owner: v === "all" ? null : v })}>
            <SelectTrigger className="w-auto min-w-40" aria-label={t("sales.f.owner")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("sales.owner.all")}</SelectItem>
              <SelectItem value="me">{t("sales.owner.me")}</SelectItem>
              {staff
                .filter((p) => p.id !== me.id)
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {tab === "dashboard" && <Dashboard data={dash.data} isLoading={dash.isLoading} onOpen={(opp) => setEditing({ opp })} />}
      {tab === "pipeline" &&
        (opps.isLoading ? (
          <div className="h-96 animate-pulse rounded-2xl border bg-muted/30" />
        ) : (
          <Board list={list} from={range.from} to={range.to} onOpen={(opp) => setEditing({ opp })} onNew={(stage) => setEditing({ stage })} />
        ))}
      {tab === "contracts" && <ContractsTab period={period} day={day} />}
      {tab === "list" && <OpportunityList list={list} from={range.from} to={range.to} onOpen={(opp) => setEditing({ opp })} />}

      {editing && <OpportunityDialog opp={editing.opp} stage={editing.stage} onClose={() => setEditing(null)} />}
    </div>
  );
}
