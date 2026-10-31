import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ban, CalendarClock, CalendarDays, Cloud, FilePen, FilePlus2, FileText, History, Loader2, Minus, Pencil, Play, Plus, Receipt, Star, Trash2, TrendingUp, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirm } from "@/components/ConfirmDialog";
import { ScopeDialog } from "@/components/ScopeDialog";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { contractCharges, chargesOn, linesForCharges, type BillingPeriod, type ChargeLine } from "@shared/contractCharges";
import { prorata } from "@shared/prorata";
import { combineBps, netCents } from "@shared/rebate";
import { RebateInput, percentOf } from "@/components/RebateInput";
import { bankBundle, type BankMonth, type BankRollover } from "@shared/bank";
import { shortDate, ticketErrorText } from "@/pages/tickets/shared";
import { MapItcloudDialog, NewServiceDialog, type Unmapped } from "./ContractServices";
import { money, useContractTypes, type CrmContract, type CrmDetail } from "./shared";

/**
 * A contract in its own window: made (with its services) or viewed in tabs — overview, services, charges (what is
 * charged and when, prorated when a service starts mid-period) and activity (what was added, changed, removed).
 * Nothing here bills anything: it shows the schedule the services give.
 */
type Line = {
  id: string;
  name: string;
  kind: "recurring" | "recurring_yearly";
  priceCents: number;
  /** The line's own rebate and the contract's (percent × 100); netPriceCents is the unit price after both */
  rebateBps: number;
  contractRebateBps?: number;
  netPriceCents?: number;
  costCents: number;
  quantity: number;
  source: string | null;
  addedOn: string;
  firstCents: number | null;
  totalCents: number | null;
  periods: { from: string; to: string; days: number; periodDays: number; full: boolean; amountCents: number }[];
};
type Summary = { billedThrough?: string | null; billedCents?: number; revenueCents: number; perPeriodCents: number; yearlyExtraCents: number; endsOn: string | null; dueCents: number; next: { date: string; amountCents: number; prorated: boolean } | null };
type Detail = CrmContract & { billingPeriod: BillingPeriod; endedOn: string | null; billedThrough: string | null; services: Line[]; bankMonths?: BankMonth[]; summary: Summary; charged: { has: boolean; billingItems: number; timeEntries: number; servicesStarted: number } };
type CatalogItem = { id: string; name: string; kind: "recurring" | "recurring_yearly"; priceCents: number; costCents: number };
export type Event = { id: string; kind: string; source: string; detail: Record<string, any>; at: string; actor: string | null };

const todayYmd = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const toCents = (v: string) => (v.trim() === "" ? null : Math.round((Number(v.replace(",", ".")) || 0) * 100));

function contractError(t: (k: string, o?: Record<string, unknown>) => string, e: unknown) {
  if (e instanceof ApiError && ["contract_dates", "contract_dates_services", "service_outside_term", "service_from_vendor", "service_not_recurring", "contract_no_term", "contract_inactive", "invalid_type"].includes(e.code)) return t(`crm.contracts.errors.${e.code}`);
  return ticketErrorText(t, e);
}

function Kpi({ icon, label, value, hint, tone }: { icon: ReactNode; label: string; value: ReactNode; hint?: ReactNode; tone?: "gold" | "sky" | "amber" }) {
  return (
    <div className={cn("rounded-xl border bg-background/40 px-3 py-2.5", tone === "gold" && "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/[0.06]")}>
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className={cn(tone === "sky" ? "text-sky-300" : tone === "amber" ? "text-amber-300" : "text-primary")}>{icon}</span> {label}
      </p>
      <p className="mt-0.5 font-mono text-lg font-semibold">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The numbers on top: potential revenue, what a full period charges (per month or per year), the next charge */
function Figures({ summary, period, lang }: { summary: Summary; period: BillingPeriod; lang: string }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi icon={<TrendingUp className="size-3.5" />} label={t("crm.contracts.window.revenue")} value={money(summary.revenueCents, lang)} hint={t("crm.contracts.window.revenueHint")} tone="gold" />
      <Kpi
        icon={<Receipt className="size-3.5" />}
        label={period === "yearly" ? t("crm.contracts.window.perYear") : t("crm.contracts.window.perMonth")}
        value={money(summary.perPeriodCents, lang)}
        hint={summary.yearlyExtraCents > 0 ? t("crm.contracts.window.plusYearly", { amount: money(summary.yearlyExtraCents, lang) }) : undefined}
      />
      <Kpi
        icon={<CalendarClock className="size-3.5" />}
        label={t("crm.contracts.window.next")}
        tone={summary.next?.prorated ? "amber" : undefined}
        value={summary.next ? money(summary.next.amountCents, lang) : "—"}
        hint={summary.next ? `${shortDate(summary.next.date)}${summary.next.prorated ? ` · ${t("crm.contracts.window.prorated")}` : ""}` : t("crm.contracts.window.noNext")}
      />
      <Kpi icon={<CalendarDays className="size-3.5" />} label={t("crm.contracts.window.due")} value={money(summary.dueCents, lang)} hint={summary.billedThrough ? t("crm.contracts.billedThroughHint", { date: shortDate(summary.billedThrough), amount: money(summary.billedCents ?? 0, lang) }) : t("crm.contracts.window.dueHint")} tone="sky" />
    </div>
  );
}

/** Picks a recurring service, a quantity, a day and optionally a price; shows the prorata as it goes. */
function ServiceAdder({ term, onAdd, busy, heading = true, bundled = false, contractRebateBps = 0 }: { term: { start: string; end: string } | null; onAdd: (p: { service: CatalogItem; quantity: number; addedOn: string; priceCents?: number; rebate?: number }) => void; busy?: boolean; heading?: boolean; bundled?: boolean; contractRebateBps?: number }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  // a service that does not exist yet is made right here (a popup), then added
  const [making, setMaking] = useState(false);
  const canMake = can("services.manage");
  const { data: catalog = [] } = useQuery({ queryKey: ["crm", "services-catalog"], queryFn: () => api.get<CatalogItem[]>("/crm/services-catalog") });
  const inside = (d: string) => (term ? (d < term.start ? term.start : d > term.end ? term.end : d) : d);
  const [serviceId, setServiceId] = useState("");
  const [quantity, setQuantity] = useState("1");
  // a service starts with the contract unless another day is picked
  const [addedOn, setAddedOn] = useState(() => term?.start ?? inside(todayYmd()));
  const [price, setPrice] = useState("");
  const [rebate, setRebate] = useState("");
  // the day follows the term when it changes
  useEffect(() => setAddedOn((d) => inside(d)), [term?.start, term?.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const svc = catalog.find((x) => x.id === (serviceId || catalog[0]?.id));
  const qty = Math.max(1, Math.round(Number(quantity) || 1));
  const unit = toCents(price) ?? svc?.priceCents ?? 0;
  const rebateBps = Math.round(percentOf(rebate) * 100);
  const plan = useMemo(() => (svc && term ? prorata({ period: svc.kind === "recurring_yearly" ? "yearly" : "monthly", priceCents: netCents(unit, combineBps(rebateBps, contractRebateBps)) * qty, addedOn, start: term.start, end: term.end }) : null), [svc, term, unit, qty, addedOn, rebateBps, contractRebateBps]);
  const maker = making && (
    <NewServiceDialog
      term={term}
      defaultDay={addedOn}
      onClose={() => setMaking(false)}
      onCreated={(service, quantity, day) => onAdd({ service, quantity, addedOn: day })}
    />
  );
  if (!catalog.length)
    return canMake ? (
      <div>
        <Button type="button" size="sm" variant="outline" onClick={() => setMaking(true)}>
          <Plus className="size-3.5" /> {t("crm.contracts.newService")}
        </Button>
        {maker}
      </div>
    ) : (
      <p className="text-xs text-muted-foreground">{t("crm.contracts.noServices")}</p>
    );
  const ok = svc && term && plan && typeof plan !== "string";
  return (
    <div className="space-y-3 rounded-xl border bg-background/30 p-3">
      {heading && (
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <Plus className="size-3.5 text-primary" /> {t("crm.contracts.addService")}
          </p>
          {canMake && (
            <Button type="button" size="sm" variant="outline" onClick={() => setMaking(true)}>
              <Plus className="size-3.5" /> {t("crm.contracts.newService")}
            </Button>
          )}
        </div>
      )}
      {maker}
      <div className={cn("grid gap-2", bundled ? "sm:grid-cols-[1fr_5rem_9rem]" : "sm:grid-cols-[1fr_5rem_9rem_7rem]")}>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("crm.contracts.service")}</span>
          <select value={svc?.id ?? ""} onChange={(e) => (e.target.value === "__new" ? setMaking(true) : setServiceId(e.target.value))} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
            {catalog.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} — {money(x.priceCents, i18n.language)} {x.kind === "recurring_yearly" ? t("services.perYear") : t("services.perMonth")}
              </option>
            ))}
            {canMake && <option value="__new">+ {t("crm.contracts.newService")}</option>}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("crm.contracts.window.quantity")}</span>
          <Input value={quantity} inputMode="numeric" onChange={(e) => setQuantity(e.target.value)} className="h-9 text-right font-mono" />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("crm.contracts.startsOn")}</span>
          <Input type="date" value={addedOn} min={term?.start} max={term?.end} onChange={(e) => setAddedOn(e.target.value)} className="h-9" />
        </label>
        {!bundled && (
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("crm.contracts.window.unitPrice")}</span>
            <Input value={price} inputMode="decimal" placeholder={svc ? String(svc.priceCents / 100) : ""} onChange={(e) => setPrice(e.target.value)} className="h-9 text-right font-mono" />
          </label>
        )}
      </div>
      {!bundled && <RebateInput regular={unit / 100} percent={rebate} onPercent={setRebate} unit={svc?.kind === "recurring_yearly" ? t("services.perYear") : t("services.perMonth")} />}
      {bundled && <p className="text-[11px] text-muted-foreground">{t("crm.contracts.bundle.noPrice")}</p>}
      {!term && <p className="text-[11px] text-amber-300">{t("crm.contracts.needTerm")}</p>}
      {term && plan === "outside" && <p className="text-[11px] text-amber-300">{t("crm.contracts.outsideTerm", { from: shortDate(term.start), to: shortDate(term.end) })}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {ok && !bundled && (
            <>
              {t("crm.contracts.firstCharge")} <span className="font-mono text-foreground">{money(plan.firstCents, i18n.language)}</span>
              {!plan.periods[0].full && <span className="ml-1 text-amber-300">({t("crm.contracts.prorata", { days: plan.periods[0].days, of: plan.periods[0].periodDays })})</span>} · {t("crm.contracts.termTotal")} <span className="font-mono text-foreground">{money(plan.totalCents, i18n.language)}</span>
            </>
          )}
        </p>
        <Button type="button" size="sm" disabled={!ok || busy} onClick={() => ok && onAdd({ service: svc, quantity: qty, addedOn, ...(price.trim() !== "" ? { priceCents: unit } : {}), ...(rebateBps > 0 ? { rebate: rebateBps / 100 } : {}) })} className="bg-grad-gold font-semibold text-[#1a1204]">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} {t("crm.contracts.window.addLine")}
        </Button>
      </div>
    </div>
  );
}

const field = "h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40 disabled:opacity-60";
function Field({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  return (
    <label className={cn("space-y-1 text-xs", className)}>
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[10px] leading-snug text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** What becomes of the hours of the bank that are not used in a month */
function RolloverPicker({ value, onChange, disabled }: { value: BankRollover; onChange: (v: BankRollover) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="text-xs text-muted-foreground">{t("crm.contracts.bank.rollover")}</legend>
      {(["lose", "carry", "topup"] as const).map((r) => (
        <label key={r} className="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs has-[:checked]:border-[color:var(--gold)]/50 has-[:checked]:bg-[color:var(--gold)]/[0.06]">
          <input type="radio" name="bank-rollover" checked={value === r} onChange={() => onChange(r)} className="mt-0.5 accent-[color:var(--gold)]" />
          <span>
            <span className="block font-medium">{t(`crm.contracts.bank.${r}`)}</span>
            <span className="block text-[11px] text-muted-foreground">{t(`crm.contracts.bank.${r}Hint`)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

// ── making a contract ──
type Draft = { serviceId: string; name: string; kind: "recurring" | "recurring_yearly"; priceCents: number; quantity: number; addedOn: string; unitCustom: boolean; rebate: number };

export function NewContractDialog({ client, onClose }: { client: CrmDetail; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  // a new contract is never a fixed price one any more
  const { data: allTypes = [] } = useContractTypes();
  const types = allTypes.filter((x) => x.kind !== "fixed");
  const [f, setF] = useState(() => {
    const now = new Date();
    const end = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate() - 1, 12);
    const day = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    return { name: "", typeKey: "", startDate: day(now), endDate: day(end), figure: "", rate: "", billingPeriod: "monthly" as BillingPeriod, billedThrough: "", supportDefault: false, bundleOn: false, bundlePrice: "", bundleQty: "1", bankRate: "", bankRollover: "lose" as BankRollover, rebate: "" };
  });
  const [lines, setLines] = useState<Draft[]>([]);
  // the hourly rate starts at the usual one of Admin › Facturation; typing another changes it, 0 means no hourly rate (included)
  const { data: defaults } = useQuery({ queryKey: ["crm", "contract-defaults"], queryFn: () => api.get<{ hourlyRateCents: number }>("/crm/contract-defaults"), staleTime: 60_000 });
  const usualRate = defaults ? String(defaults.hourlyRateCents / 100) : "";
  const rate = f.rate === "" ? usualRate : f.rate;
  const type = types.find((x) => x.key === (f.typeKey || types[0]?.key));
  const termOk = Boolean(f.startDate && f.endDate && f.endDate >= f.startDate);
  const term = termOk ? { start: f.startDate, end: f.endDate } : null;
  // what the services will charge, live
  const isBank = type?.kind === "banked";
  const bankHours = Number(f.figure.replace(",", ".")) || 0;
  const bankRateCents = toCents(f.bankRate) ?? 0;
  const bankPlan = isBank && bankHours > 0 ? bankBundle(bankHours, bankRateCents) : null;
  const bundled = (type?.kind === "recurring" && f.bundleOn) || Boolean(bankPlan);
  const bundleCents = bankPlan ? bankPlan.priceCents : toCents(f.bundlePrice);
  const bundleQty = bankPlan ? bankPlan.quantity : Math.max(1, Math.round(Number(f.bundleQty) || 1));
  const charges = useMemo(
    () =>
      contractCharges(
        { startDate: f.startDate, endDate: f.endDate, billingPeriod: f.billingPeriod },
        linesForCharges(
          { name: f.name || "—", startDate: f.startDate, billingPeriod: f.billingPeriod, bundlePriceCents: bundled ? (bundleCents ?? 0) : null, bundleQuantity: bundleQty, rebateBps: Math.round(percentOf(f.rebate) * 100) },
          lines.map((l, i): ChargeLine => ({ id: String(i), name: l.name, kind: l.kind, priceCents: l.priceCents, quantity: l.quantity, addedOn: l.addedOn, rebateBps: Math.round(l.rebate * 100) })),
        ),
      ),
    [f.startDate, f.endDate, f.billingPeriod, f.name, lines, bundled, bundleCents, bundleQty, f.rebate],
  );
  const on = chargesOn(charges, todayYmd(), f.billedThrough || null);
  const create = useMutation({
    mutationFn: () => {
      const n = f.figure.trim() === "" ? null : Number(f.figure.replace(",", "."));
      // a recurring services contract has no typed charge: it comes from its services
      const figure = isBank ? { bankedHours: n, bankedRate: bankRateCents / 100, bankRollover: f.bankRollover } : {};
      const hourlyRate = isBank ? undefined : rate.trim() === "" ? undefined : Number(rate.replace(",", "."));
      return api.post(`/crm/clients/${client.id}/contracts`, {
        name: f.name.trim(),
        typeKey: type!.key,
        startDate: f.startDate,
        endDate: f.endDate,
        billingPeriod: isBank ? "monthly" : f.billingPeriod,
        ...(f.billedThrough ? { billedThrough: f.billedThrough } : {}),
        ...(f.supportDefault ? { supportDefault: true } : {}),
        ...(hourlyRate !== undefined && Number.isFinite(hourlyRate) ? { hourlyRate } : {}),
        ...figure,
        ...(percentOf(f.rebate) > 0 ? { rebate: percentOf(f.rebate) } : {}),
        ...(bundled && !isBank ? { bundlePrice: (bundleCents ?? 0) / 100, bundleQuantity: bundleQty } : {}),
        services: (isBank ? [] : lines).map((l) => ({ serviceId: l.serviceId, addedOn: l.addedOn, quantity: l.quantity, ...(l.unitCustom && !bundled ? { priceCents: l.priceCents } : {}), ...(l.rebate > 0 ? { rebate: l.rebate } : {}) })),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "client", client.id, "contracts"] });
      toast.success(t("crm.contracts.created"));
      onClose();
    },
    onError: (e) => toast.error(contractError(t, e)),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const lang = i18n.language;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] sm:max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FilePlus2 className="size-5 text-primary" /> {t("crm.contracts.new")} — {client.name}
          </DialogTitle>
          <DialogDescription>{t("crm.contracts.window.newHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (f.name.trim() && type && termOk) create.mutate();
          }}
        >
          <section className="space-y-3">
            <h4 className="text-sm font-semibold">{t("crm.contracts.window.info")}</h4>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t("crm.contracts.name")} className="sm:col-span-2">
                <Input value={f.name} onChange={set("name")} required maxLength={120} autoFocus />
              </Field>
              <Field label={t("crm.contracts.type")}>
                <select value={type?.key ?? ""} onChange={set("typeKey")} className={field}>
                  {types.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("crm.contracts.start")}>
                <Input type="date" required value={f.startDate} onChange={set("startDate")} />
              </Field>
              <Field label={t("crm.contracts.end")}>
                <Input type="date" required min={f.startDate || undefined} value={f.endDate} onChange={set("endDate")} className={cn(f.endDate && f.startDate && f.endDate < f.startDate && "border-destructive")} />
              </Field>
              {!isBank && (
                <Field label={t("crm.contracts.window.chargedBy")}>
                  <select value={f.billingPeriod} onChange={set("billingPeriod")} className={field}>
                    <option value="monthly">{t("crm.contracts.window.monthly")}</option>
                    <option value="yearly">{t("crm.contracts.window.yearly")}</option>
                  </select>
                </Field>
              )}
              <Field label={t("crm.contracts.billedThrough")} hint={t("crm.contracts.billedThroughText")}>
                <Input type="date" value={f.billedThrough} onChange={set("billedThrough")} />
              </Field>
              {!isBank && (
                <Field label={t("crm.contracts.hourlyRate")} hint={t("crm.contracts.hourlyRateHint")}>
                  <Input value={rate} onChange={(e) => setF((x) => ({ ...x, rate: e.target.value }))} inputMode="decimal" placeholder={usualRate || "$"} className="text-right font-mono" />
                </Field>
              )}
              <label className="flex items-center gap-2 self-end pb-2 text-xs">
                <input type="checkbox" checked={f.supportDefault} onChange={(e) => setF((x) => ({ ...x, supportDefault: e.target.checked }))} className="size-4 accent-[color:var(--gold)]" />
                <span>
                  <span className="block font-medium">{t("crm.contracts.supportDefault")}</span>
                  <span className="block text-[10px] text-muted-foreground">{t("crm.contracts.supportDefaultHint")}</span>
                </span>
              </label>
              {/* the recurring services contract asks no charge here: it comes from its services */}
              {type && type.kind !== "recurring" && type.kind !== "hourly" && !isBank && (
                <Field label={t(`crm.contracts.figure_${type.kind}`)}>
                  <Input value={f.figure} onChange={set("figure")} inputMode="decimal" placeholder={type.kind === "banked" ? "h" : "$"} />
                </Field>
              )}
            </div>
          </section>

          {type && type.kind !== "fixed" && (
            <section className="space-y-2 rounded-xl border bg-background/30 p-3">
              <h4 className="text-sm font-semibold">{t("rebate.contract")}</h4>
              <p className="text-xs text-muted-foreground">{t("rebate.contractHint")}</p>
              <RebateInput regular={isBank ? bankRateCents / 100 : type.kind === "hourly" ? Number(rate.replace(",", ".")) || 0 : null} percent={f.rebate} onPercent={(v) => setF((x) => ({ ...x, rebate: v }))} unit={isBank || type.kind === "hourly" ? "/ h" : undefined} />
            </section>
          )}

          {isBank && (
            <section className="space-y-3 rounded-xl border bg-background/30 p-3">
              <h4 className="text-sm font-semibold">{t("crm.contracts.bank.title")}</h4>
              <p className="text-xs text-muted-foreground">{t("crm.contracts.bank.hint")}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t("crm.contracts.bank.hours")}>
                  <Input value={f.figure} onChange={set("figure")} inputMode="decimal" placeholder="h" className="text-right font-mono" />
                </Field>
                <Field label={t("crm.contracts.bank.rate")}>
                  <Input value={f.bankRate} onChange={set("bankRate")} inputMode="decimal" placeholder="$" className="text-right font-mono" />
                </Field>
                <p className="self-end pb-2 text-xs text-muted-foreground">
                  {t("crm.contracts.bundle.total")} <span className="font-mono text-sm text-foreground">{money(Math.round(bankHours * bankRateCents), lang)}</span> {t("services.perMonth")}
                </p>
              </div>
              <RolloverPicker value={f.bankRollover} onChange={(v) => setF((x) => ({ ...x, bankRollover: v }))} />
            </section>
          )}

          {type?.kind === "recurring" && (
            <section className="space-y-3 rounded-xl border bg-background/30 p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Switch checked={f.bundleOn} onCheckedChange={(v) => setF((x) => ({ ...x, bundleOn: v }))} /> {t("crm.contracts.bundle.toggle")}
              </label>
              <p className="text-xs text-muted-foreground">{t("crm.contracts.bundle.hint")}</p>
              {f.bundleOn && (
                <div className="grid gap-3 sm:grid-cols-[6rem_9rem_1fr]">
                  <Field label={t("crm.contracts.window.quantity")}>
                    <Input value={f.bundleQty} inputMode="numeric" onChange={set("bundleQty")} className="text-right font-mono" />
                  </Field>
                  <Field label={f.billingPeriod === "yearly" ? t("crm.contracts.bundle.priceYear") : t("crm.contracts.bundle.priceMonth")}>
                    <Input value={f.bundlePrice} inputMode="decimal" placeholder="0" onChange={set("bundlePrice")} className="text-right font-mono" />
                  </Field>
                  <p className="self-end pb-2 text-xs text-muted-foreground">
                    {t("crm.contracts.bundle.total")} <span className="font-mono text-sm text-foreground">{money((bundleCents ?? 0) * bundleQty, lang)}</span> {f.billingPeriod === "yearly" ? t("services.perYear") : t("services.perMonth")}
                  </p>
                </div>
              )}
            </section>
          )}

          {!isBank && (
          <section className="space-y-3">
            <h4 className="flex items-center gap-1.5 text-sm font-semibold">
              <Wrench className="size-4 text-primary" /> {bundled ? t("crm.contracts.bundle.included") : t("crm.contracts.services")} ({lines.length})
            </h4>
            {lines.length > 0 && (
              <ul className="divide-y divide-border/50 rounded-lg border bg-background/30 text-sm">
                {lines.map((l, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {l.name} {l.quantity > 1 && <span className="font-mono text-xs text-muted-foreground">× {l.quantity}</span>}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {bundled ? t("crm.contracts.bundle.inPackage") : `${l.rebate > 0 ? `${money(netCents(l.priceCents, Math.round(l.rebate * 100)), lang)} (${t("rebate.applied", { pct: l.rebate })}) ` : `${money(l.priceCents, lang)} `}${l.kind === "recurring_yearly" ? t("services.perYear") : t("services.perMonth")} · ${t("crm.contracts.addedOn", { date: shortDate(l.addedOn) })}`}
                      </span>
                    </span>
                    <Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => setLines((x) => x.filter((_, j) => j !== i))} aria-label={t("common.delete")}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <ServiceAdder
              term={term}
              heading={false}
              bundled={bundled}
              contractRebateBps={Math.round(percentOf(f.rebate) * 100)}
              onAdd={(p) => setLines((x) => [...x, { serviceId: p.service.id, name: p.service.name, kind: p.service.kind, priceCents: p.priceCents ?? p.service.priceCents, quantity: p.quantity, addedOn: p.addedOn, unitCustom: p.priceCents !== undefined, rebate: p.rebate ?? 0 }])}
            />
          </section>
          )}

          <Figures summary={{ billedThrough: f.billedThrough || null, billedCents: on.billedCents, revenueCents: charges.revenueCents, perPeriodCents: charges.perPeriodCents, yearlyExtraCents: charges.yearlyExtraCents, endsOn: charges.endsOn, dueCents: on.dueCents, next: on.next ? { date: on.next.date, amountCents: on.next.amountCents, prorated: on.next.prorated } : null }} period={f.billingPeriod} lang={lang} />

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending || !f.name.trim() || !type || !termOk} className="bg-grad-gold font-semibold text-[#1a1204]">
              {create.isPending && <Loader2 className="size-4 animate-spin" />} {t("crm.contracts.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── viewing and editing a contract ──
export function ContractWindow({ client, contractId, onClose }: { client: CrmDetail; contractId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const can = useCan();
  const editable = can("crm.billing");
  const key = ["crm", "client", client.id, "contract", contractId];
  const { data: k, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/crm/clients/${client.id}/contracts/${contractId}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["crm", "client", client.id, "contracts"] });
    void qc.invalidateQueries({ queryKey: ["crm", "client", client.id, "contract-activity", contractId] });
    void qc.invalidateQueries({ queryKey: ["tickets"] });
  };
  const lang = i18n.language;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] sm:max-w-5xl overflow-y-auto">
        {isLoading || !k ? (
          <>
            <DialogHeader>
              <DialogTitle className="sr-only">{t("crm.tabs.contracts")}</DialogTitle>
            </DialogHeader>
            <Loader2 className="mx-auto my-10 size-6 animate-spin text-muted-foreground" />
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                <FileText className="size-5 text-primary" /> {k.name}
                {k.active ? (
                  <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-300">{t("crm.contracts.window.active")}</span>
                ) : (
                  <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300">{k.endedOn ? t("crm.contracts.window.stoppedOn", { date: shortDate(k.endedOn) }) : t("crm.contracts.inactive")}</span>
                )}
                {(k.rebateBps ?? 0) > 0 && <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">{t("rebate.onContract", { pct: (k.rebateBps ?? 0) / 100 })}</span>}
                {k.isSupportDefault && <span className="rounded-md border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{t("crm.contracts.supportDefault")}</span>}
              </DialogTitle>
              <DialogDescription>
                {client.name} · {k.type ?? "—"} · {k.startDate ? shortDate(k.startDate) : "…"} → {k.endDate ? shortDate(k.endDate) : t("crm.contracts.noEnd")}
              </DialogDescription>
            </DialogHeader>
            <Figures summary={k.summary} period={k.billingPeriod} lang={lang} />
            <Tabs defaultValue="services" className="mt-2">
              <TabsList className="flex-wrap">
                <TabsTrigger value="services" className="gap-1.5">
                  <Wrench className="size-3.5" /> {k.billingMode === "banked" ? t("crm.contracts.bank.tab") : `${t("crm.contracts.window.tabServices")} (${k.services.length})`}
                </TabsTrigger>
                <TabsTrigger value="charges" className="gap-1.5">
                  <CalendarClock className="size-3.5" /> {t("crm.contracts.window.tabCharges")}
                </TabsTrigger>
                <TabsTrigger value="activity" className="gap-1.5">
                  <History className="size-3.5" /> {t("crm.contracts.window.tabActivity")}
                </TabsTrigger>
                <TabsTrigger value="overview" className="gap-1.5">
                  <FilePen className="size-3.5" /> {t("crm.contracts.window.tabOverview")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="services" className="pt-3">
                {k.billingMode === "banked" ? <BankTab k={k} /> : <ServicesTab client={client} k={k} editable={editable} onChanged={refresh} />}
              </TabsContent>
              <TabsContent value="charges" className="pt-3">
                <ChargesTab k={k} lang={lang} />
              </TabsContent>
              <TabsContent value="activity" className="pt-3">
                <ActivityTab client={client} k={k} lang={lang} />
              </TabsContent>
              <TabsContent value="overview" className="pt-3">
                <OverviewTab client={client} k={k} editable={editable} onChanged={refresh} onClose={onClose} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── services ──
/** An hours bank: where it stands this month and month by month what was available, used, left and bought */
function BankTab({ k }: { k: Detail }) {
  const { t, i18n } = useTranslation();
  const rows = [...(k.bankMonths ?? [])].reverse();
  const h = (n: number) => `${n.toLocaleString(i18n.language, { maximumFractionDigits: 2 })} h`;
  return (
    <div className="space-y-3">
      {k.bank ? (
        <div className="grid gap-2 sm:grid-cols-4">
          <Kpi icon={<CalendarDays className="size-3.5" />} label={t("crm.contracts.bank.monthHours")} value={h(k.bank.hours)} hint={`${money(k.bank.rateCents ?? 0, i18n.language)} / h`} />
          <Kpi icon={<Receipt className="size-3.5" />} label={t("crm.contracts.bank.availableNow")} value={h(k.bank.available)} />
          <Kpi icon={<Minus className="size-3.5" />} label={t("crm.contracts.bank.usedNow")} value={h(k.bank.used)} tone="sky" />
          <Kpi icon={<TrendingUp className="size-3.5" />} label={t("crm.contracts.bank.leftNow")} value={h(k.bank.left)} tone={k.bank.left > 0 ? "gold" : "amber"} hint={k.bank.over > 0 ? t("crm.contracts.bank.overHint", { over: k.bank.over }) : undefined} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("crm.contracts.bank.notSet")}</p>
      )}
      <p className="text-xs text-muted-foreground">{t(`crm.contracts.bank.${k.bankRollover ?? "lose"}Hint`)}</p>
      {rows.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase text-muted-foreground">
            <tr>
              <th className="py-1">{t("crm.contracts.bank.month")}</th>
              <th className="text-right">{t("crm.contracts.bank.available")}</th>
              <th className="text-right">{t("crm.contracts.bank.used")}</th>
              <th className="text-right">{t("crm.contracts.bank.left")}</th>
              <th className="text-right">{t("crm.contracts.bank.bought")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50 font-mono">
            {rows.map((r) => (
              <tr key={r.month}>
                <td className="py-1.5 font-sans">{r.month}</td>
                <td className="text-right">{h(r.available)}</td>
                <td className="text-right">{h(r.used)}</td>
                <td className={cn("text-right", r.over > 0 && "text-amber-300")}>{r.over > 0 ? `−${h(r.over)}` : h(r.left)}</td>
                <td className="text-right">{h(r.charge)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ServicesTab({ client, k, editable, onChanged }: { client: CrmDetail; k: Detail; editable: boolean; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const base = `/crm/clients/${client.id}/contracts/${k.id}`;
  const term = k.startDate && k.endDate ? { start: k.startDate, end: k.endDate } : null;
  const [editing, setEditing] = useState<string | null>(null);
  const [mapping, setMapping] = useState(false);
  // the day the prices are looked at: the period it falls in is shown for every service (prorated only if the service starts or ends inside it)
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  const [asOf, setAsOf] = useState(today);
  const nextMonth = (() => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
    return d.toISOString().slice(0, 10);
  })();
  const periodAt = (l: Line) => l.periods.find((p) => p.from <= asOf && asOf <= p.to) ?? null;
  // a bundle: what is charged is the package; the services under it carry no price of their own
  const bundled = k.bundlePriceCents != null;
  const bundleLines = linesForCharges({ name: k.name, startDate: k.startDate, billingPeriod: k.billingPeriod ?? "monthly", bundlePriceCents: k.bundlePriceCents, bundleQuantity: k.bundleQuantity, rebateBps: k.rebateBps }, []);
  const bundlePiece = bundled
    ? contractCharges({ startDate: k.startDate, endDate: k.endDate, endedOn: k.endedOn, billingPeriod: k.billingPeriod ?? "monthly" }, bundleLines)
        .entries.flatMap((e) => e.pieces)
        .find((p) => p.from <= asOf && asOf <= p.to) ?? null
    : null;
  const totalAt = bundled ? (bundlePiece?.amountCents ?? 0) : k.services.reduce((n, l) => n + (periodAt(l)?.amountCents ?? 0), 0);
  const { data: waiting = [] } = useQuery({ queryKey: ["crm", "client", client.id, "itcloud-unmapped", k.id], queryFn: () => api.get<Unmapped[]>(`${base}/itcloud-services`), enabled: editable && k.active });
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: (p: { service: CatalogItem; quantity: number; addedOn: string; priceCents?: number; rebate?: number }) => api.post(`${base}/services`, { serviceId: p.service.id, quantity: p.quantity, addedOn: p.addedOn, ...(p.priceCents !== undefined ? { priceCents: p.priceCents } : {}), ...(p.rebate ? { rebate: p.rebate } : {}) }),
    onSuccess: () => {
      toast.success(t("crm.contracts.serviceAdded"));
      onChanged();
    },
    onError: (e) => toast.error(contractError(t, e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`${base}/services/${id}`),
    onSuccess: onChanged,
    onError: (e) => toast.error(contractError(t, e)),
  });
  // a changed price: "only this contract" or "the service and every running contract" — the server asks (and says how many others)
  const [scope, setScope] = useState<{ edit: { id: string; quantity: number; priceCents: number; addedOn: string; rebate: number }; others: number } | null>(null);
  const change = useMutation({
    mutationFn: (p: { id: string; quantity: number; priceCents: number; addedOn: string; rebate: number; scope?: "line" | "service" | "all" }) => api.patch(`${base}/services/${p.id}`, { quantity: p.quantity, priceCents: p.priceCents, addedOn: p.addedOn, rebate: p.rebate, ...(p.scope ? { scope: p.scope } : {}) }),
    onSuccess: () => {
      setEditing(null);
      setScope(null);
      onChanged();
      void qc.invalidateQueries({ queryKey: ["services"] });
    },
    onError: (e, v) => {
      if (e instanceof ApiError && e.code === "price_scope_required") setScope({ edit: { id: v.id, quantity: v.quantity, priceCents: v.priceCents, addedOn: v.addedOn, rebate: v.rebate }, others: Number(e.fields?.find((x) => x.path === "contracts")?.message ?? 0) });
      else toast.error(contractError(t, e));
    },
  });
  return (
    <div className="space-y-3">
      {bundled && (
        <div className="rounded-lg border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/[0.06] px-3 py-2 text-sm">
          <p className="font-medium">
            {t("crm.contracts.bundle.title")} — {k.bundleQuantity ?? 1} × {money(k.bundlePriceCents ?? 0, i18n.language)} = <span className="font-mono">{money(netCents(k.bundlePriceCents ?? 0, k.rebateBps) * (k.bundleQuantity ?? 1), i18n.language)}</span> {k.billingPeriod === "yearly" ? t("services.perYear") : t("services.perMonth")}
          </p>
          <p className="text-xs text-muted-foreground">{t("crm.contracts.bundle.shown")}</p>
        </div>
      )}
      {k.services.length === 0 && <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">{t("crm.contracts.window.noLines")}</p>}
      {k.services.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background/30 px-3 py-2 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{t("crm.contracts.asOf")}</span>
          <Input type="date" value={asOf} min={k.startDate ?? undefined} max={k.endDate ?? undefined} onChange={(e) => e.target.value && setAsOf(e.target.value)} className="h-8 w-40" aria-label={t("crm.contracts.asOf")} />
          <Button type="button" size="sm" variant={asOf === today ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => setAsOf(today)}>
            {t("crm.contracts.asOfToday")}
          </Button>
          <Button type="button" size="sm" variant={asOf === nextMonth ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => setAsOf(nextMonth)}>
            {t("crm.contracts.asOfNextMonth")}
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            {t("crm.contracts.periodTotal")} <span className="font-mono text-sm text-foreground">{money(totalAt, i18n.language)}</span>
          </span>
        </div>
      )}
      {k.services.length > 0 && (
        <ul className="divide-y divide-border/50 rounded-lg border bg-background/30 text-sm">
          {k.services.map((l) => (
            <li key={l.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate font-medium">
                    {l.name}
                    {l.quantity > 1 && <span className="font-mono text-xs text-muted-foreground">× {l.quantity}</span>}
                    {l.source && <span className="rounded border border-sky-400/40 px-1 text-[9px] font-semibold uppercase text-sky-300" title={t("crm.contracts.fromVendorHint")}>{l.source === "itcloud" ? "ITCloud" : l.source}</span>}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {(l.rebateBps > 0 || (l.contractRebateBps ?? 0) > 0) && <span className="mr-1 text-muted-foreground line-through">{money(l.priceCents, i18n.language)}</span>}
                    {money(l.netPriceCents ?? l.priceCents, i18n.language)} {l.kind === "recurring_yearly" ? t("services.perYear") : t("services.perMonth")} · {t("crm.contracts.addedOn", { date: shortDate(l.addedOn) })}
                    {l.rebateBps > 0 && <span className="ml-1.5 rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-300">{t("rebate.applied", { pct: l.rebateBps / 100 })}</span>}
                    {(l.contractRebateBps ?? 0) > 0 && <span className="ml-1 rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-300">{t("rebate.onContract", { pct: (l.contractRebateBps ?? 0) / 100 })}</span>}
                  </span>
                </span>
                {bundled && <span className="text-right text-[11px] text-muted-foreground">{t("crm.contracts.bundle.inPackage")}</span>}
                {!bundled && l.firstCents !== null && (
                  <span className="text-right text-[11px] text-muted-foreground">
                    {(() => {
                      const p = periodAt(l);
                      return p ? (
                        <span className="block">
                          {t("crm.contracts.periodOf", { from: shortDate(p.from), to: shortDate(p.to) })} <span className="font-mono text-sm text-foreground">{money(p.amountCents, i18n.language)}</span>
                          {p.full ? <span className="ml-1 text-emerald-300">({t("crm.contracts.fullPrice")})</span> : <span className="ml-1 text-amber-300">({t("crm.contracts.prorata", { days: p.days, of: p.periodDays })})</span>}
                        </span>
                      ) : (
                        <span className="block">{asOf < l.addedOn ? t("crm.contracts.notStarted", { date: shortDate(l.addedOn) }) : t("crm.contracts.noMoreCharge")}</span>
                      );
                    })()}
                    <span className="block">
                      {t("crm.contracts.termTotal")} <span className="font-mono text-foreground">{money(l.totalCents ?? 0, i18n.language)}</span>
                    </span>
                  </span>
                )}
                {editable && (
                  <span className="flex">
                    <Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-foreground" onClick={() => setEditing(editing === l.id ? null : l.id)} aria-label={t("common.edit")}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      disabled={remove.isPending}
                      onClick={() => void confirm({ title: t("crm.contracts.window.removeTitle", { name: l.name }), description: t("crm.contracts.window.removeText"), confirmLabel: t("common.delete"), destructive: true }).then((ok) => ok && remove.mutate(l.id))}
                      aria-label={t("common.delete")}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </span>
                )}
              </div>
              {editing === l.id && <LineEditor l={l} term={term} fromVendor={Boolean(l.source)} busy={change.isPending} contractRebateBps={k.rebateBps ?? 0} onSave={(p) => change.mutate({ id: l.id, ...p })} onCancel={() => setEditing(null)} />}
            </li>
          ))}
        </ul>
      )}
      {editable && k.active && (
        <>
          <ServiceAdder term={term} busy={add.isPending} bundled={bundled} contractRebateBps={k.rebateBps ?? 0} onAdd={(p) => add.mutate(p)} />
          {waiting.length > 0 && (
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 border-sky-500/40 text-xs text-sky-300" onClick={() => setMapping(true)}>
              <Cloud className="size-3.5" /> {t("crm.contracts.mapItcloud", { count: waiting.length })}
            </Button>
          )}
        </>
      )}
      {!k.active && <p className="text-xs text-amber-300">{t("crm.contracts.window.inactiveServices")}</p>}
      {scope && (
        <ScopeDialog
          title={t("crm.contracts.scope.title")}
          description={t("crm.contracts.scope.text", { count: scope.others })}
          options={[
            ...(scope.others > 0 ? [{ label: t("crm.contracts.scope.all", { count: scope.others }), onClick: () => change.mutate({ ...scope.edit, scope: "all" as const }) }] : []),
            { label: t("crm.contracts.scope.service"), onClick: () => change.mutate({ ...scope.edit, scope: "service" as const }) },
            { label: t("crm.contracts.scope.narrow"), onClick: () => change.mutate({ ...scope.edit, scope: "line" as const }) },
          ]}
          busy={change.isPending}
          onCancel={() => setScope(null)}
        />
      )}
      {mapping && (
        <MapItcloudDialog
          clientId={client.id}
          k={k}
          rows={waiting}
          onClose={() => setMapping(false)}
          onDone={() => {
            onChanged();
            void qc.invalidateQueries({ queryKey: ["crm", "client", client.id, "itcloud-unmapped", k.id] });
          }}
        />
      )}
    </div>
  );
}

/** Changes a line: its quantity, its price per unit, the day it starts (the prorata is shown as it goes) */
function LineEditor({ l, term, fromVendor, busy, onSave, onCancel, contractRebateBps = 0 }: { l: Line; fromVendor?: boolean; term: { start: string; end: string } | null; busy: boolean; onSave: (p: { quantity: number; priceCents: number; addedOn: string; rebate: number }) => void; onCancel: () => void; contractRebateBps?: number }) {
  const { t, i18n } = useTranslation();
  const [quantity, setQuantity] = useState(String(l.quantity));
  const [price, setPrice] = useState(String(l.priceCents / 100));
  const [addedOn, setAddedOn] = useState(l.addedOn);
  const [rebate, setRebate] = useState(l.rebateBps ? String(l.rebateBps / 100) : "");
  const qty = Math.max(1, Math.round(Number(quantity) || 1));
  const unit = toCents(price) ?? l.priceCents;
  const plan = term ? prorata({ period: l.kind === "recurring_yearly" ? "yearly" : "monthly", priceCents: netCents(unit, combineBps(Math.round(percentOf(rebate) * 100), contractRebateBps)) * qty, addedOn, start: term.start, end: term.end }) : "dates";
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border bg-background/40 p-2">
      <Field label={t("crm.contracts.window.quantity")}>
        <Input value={quantity} inputMode="numeric" disabled={fromVendor} onChange={(e) => setQuantity(e.target.value)} className="h-8 w-20 text-right font-mono" />
      </Field>
      <Field label={t("crm.contracts.window.unitPrice")}>
        <Input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} className="h-8 w-28 text-right font-mono" />
      </Field>
      <Field label={t("crm.contracts.startsOn")}>
        <Input type="date" value={addedOn} min={term?.start} max={term?.end} disabled={fromVendor} onChange={(e) => setAddedOn(e.target.value)} className="h-8" />
      </Field>
      <div className="basis-full">
        <RebateInput regular={unit / 100} percent={rebate} onPercent={setRebate} />
      </div>
      <span className="pb-2 text-[11px] text-muted-foreground">
        {typeof plan !== "string" && (
          <>
            {t("crm.contracts.firstCharge")} <span className="font-mono text-foreground">{money(plan.firstCents, i18n.language)}</span> · {t("crm.contracts.termTotal")} <span className="font-mono text-foreground">{money(plan.totalCents, i18n.language)}</span>
          </>
        )}
      </span>
      <span className="ml-auto flex gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" size="sm" disabled={busy || typeof plan === "string"} onClick={() => onSave({ quantity: qty, priceCents: unit, addedOn, rebate: percentOf(rebate) })} className="bg-grad-gold font-semibold text-[#1a1204]">
          {busy && <Loader2 className="size-3.5 animate-spin" />} {t("common.save")}
        </Button>
      </span>
    </div>
  );
}

// ── charges: what is charged and when, with the prorata ──
function ChargesTab({ k, lang }: { k: Detail; lang: string }) {
  const { t } = useTranslation();
  const today = todayYmd();
  const ch = useMemo(
    () => contractCharges({ startDate: k.startDate, endDate: k.endDate, endedOn: k.endedOn, billingPeriod: k.billingPeriod }, linesForCharges({ name: k.name, startDate: k.startDate, billingPeriod: k.billingPeriod ?? "monthly", bundlePriceCents: k.bundlePriceCents, bundleQuantity: k.bundleQuantity, rebateBps: k.rebateBps }, k.services.map((l): ChargeLine => ({ id: l.id, name: l.name, kind: l.kind, priceCents: l.priceCents, quantity: l.quantity, addedOn: l.addedOn, rebateBps: l.rebateBps })))),
    [k],
  );
  const on = chargesOn(ch, today, k.billedThrough);
  if (!k.startDate || !k.endDate) return <p className="text-sm text-amber-300">{t("crm.contracts.needTerm")}</p>;
  if (!ch.entries.length) return <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">{t("crm.contracts.window.noCharges")}</p>;
  return (
    <div className="space-y-3">
      {k.endedOn && <p className="text-xs text-amber-300">{t("crm.contracts.window.chargesStopped", { date: shortDate(k.endedOn) })}</p>}
      <p className="text-[11px] text-muted-foreground">{t("crm.contracts.window.chargesNote")}</p>
      <ul className="divide-y divide-border/50 overflow-hidden rounded-lg border text-sm">
        {ch.entries.map((e) => {
          const isNext = on.next?.date === e.date;
          const billed = Boolean(k.billedThrough && e.date <= k.billedThrough);
          const past = e.date <= today || billed;
          return (
            <li key={e.date} className={cn("px-3 py-2", isNext && "bg-[color:var(--gold)]/[0.07]", past && "text-muted-foreground")}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span className="w-28 font-mono text-xs">{shortDate(e.date)}</span>
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {shortDate(e.from)} → {shortDate(e.to)}
                </span>
                {e.prorated && <span className="rounded border border-amber-400/40 px-1.5 text-[10px] font-semibold uppercase text-amber-300">{t("crm.contracts.window.prorated")}</span>}
                {isNext && <span className="rounded border border-[color:var(--gold)]/50 px-1.5 text-[10px] font-semibold uppercase text-primary">{t("crm.contracts.window.nextTag")}</span>}
                {billed ? <span className="rounded border border-emerald-500/40 px-1.5 text-[10px] font-semibold uppercase text-emerald-300">{t("crm.contracts.billedTag")}</span> : past && <span className="rounded border px-1.5 text-[10px] uppercase">{t("crm.contracts.window.dueTag")}</span>}
                <span className={cn("w-28 text-right font-mono font-semibold", !past && "text-foreground")}>{money(e.amountCents, lang)}</span>
              </div>
              {(e.pieces.length > 1 || e.prorated) && (
                <ul className="mt-1 space-y-0.5 pl-28 text-[11px] text-muted-foreground">
                  {e.pieces.map((p, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {p.prorated && <span className="text-amber-300">{t("crm.contracts.prorata", { days: p.days, of: p.periodDays })}</span>}
                      <span className="w-24 text-right font-mono">{money(p.amountCents, lang)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        <li className="flex items-center justify-between bg-background/40 px-3 py-2 text-xs font-semibold">
          <span>{t("crm.contracts.window.revenue")}</span>
          <span className="font-mono">{money(ch.revenueCents, lang)}</span>
        </li>
      </ul>
    </div>
  );
}

// ── activity ──
const FIELD_LABEL: Record<string, string> = {
  name: "crm.contracts.name",
  type: "crm.contracts.type",
  startDate: "crm.contracts.start",
  endDate: "crm.contracts.end",
  billingPeriod: "crm.contracts.window.chargedBy",
  billedThrough: "crm.contracts.billedThrough",
  autoApprove: "crm.contracts.auto",
};

export const contractEventIcon = (kind: string) =>
    kind === "service_added" ? <Plus className="size-3.5 text-emerald-300" /> : kind === "service_removed" ? <Minus className="size-3.5 text-destructive" /> : kind === "service_changed" ? <Pencil className="size-3.5 text-sky-300" /> : kind === "stopped" ? <Ban className="size-3.5 text-amber-300" /> : kind === "resumed" ? <Play className="size-3.5 text-emerald-300" /> : kind === "created" ? <FilePlus2 className="size-3.5 text-primary" /> : <FilePen className="size-3.5 text-muted-foreground" />;

export const contractEventText = (t: TFunction, e: Event, lang: string) => {
    const d = e.detail;
    const per = (kind: string) => (kind === "recurring_yearly" ? t("services.perYear") : t("services.perMonth"));
    switch (e.kind) {
      case "service_added":
        return t("crm.contracts.window.ev_added", { name: d.name, qty: d.quantity, price: money(d.priceCents, lang), per: per(d.kind), date: shortDate(d.addedOn) });
      case "service_removed":
        return t("crm.contracts.window.ev_removed", { name: d.name, qty: d.quantity, date: shortDate(d.addedOn) }) + (d.reason === "ended" ? ` — ${t("crm.contracts.window.ev_ended")}` : d.reason === "unmapped" ? ` — ${t("crm.contracts.window.ev_unmapped")}` : d.movedTo ? ` — ${t("crm.contracts.window.ev_movedTo", { name: d.movedTo })}` : "");
      case "service_changed": {
        const ch = (d.changes ?? {}) as Record<string, [unknown, unknown]>;
        const parts = Object.entries(ch).map(([f, [a, b]]) => `${t(`crm.contracts.window.f_${f}`, { defaultValue: f })}: ${f === "priceCents" || f === "costCents" ? `${money(Number(a), lang)} → ${money(Number(b), lang)}` : `${a} → ${b}`}`);
        return `${t("crm.contracts.window.ev_changed", { name: d.name })} (${parts.join(", ")})`;
      }
      case "stopped":
        return t("crm.contracts.window.ev_stopped", { date: d.on ? shortDate(String(d.on)) : "" });
      case "resumed":
        return t("crm.contracts.window.ev_resumed");
      case "created":
        return t("crm.contracts.window.ev_created", { name: d.name });
      default: {
        const ch = (d.changes ?? {}) as Record<string, [unknown, unknown]>;
        const parts = Object.keys(ch).map((f) => (FIELD_LABEL[f] ? t(FIELD_LABEL[f]) : f));
        return t("crm.contracts.window.ev_updated", { fields: parts.join(", ") });
      }
    }
  };

function ActivityTab({ client, k, lang }: { client: CrmDetail; k: Detail; lang: string }) {
  const { t } = useTranslation();
  const { data = [], isLoading } = useQuery({ queryKey: ["crm", "client", client.id, "contract-activity", k.id], queryFn: () => api.get<Event[]>(`/crm/clients/${client.id}/contracts/${k.id}/activity`) });
  if (isLoading) return <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />;
  if (!data.length) return <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">{t("crm.contracts.window.noActivity")}</p>;
  const icon = contractEventIcon;
  const text = (e: Event) => contractEventText(t, e, lang);
  return (
    <ol className="space-y-1.5">
      {data.map((e) => (
        <li key={e.id} className="flex items-start gap-3 rounded-lg border bg-background/30 px-3 py-2 text-sm">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background/60">{icon(e.kind)}</span>
          <span className="min-w-0 flex-1">
            <span className="block">{text(e)}</span>
            <span className="block text-[11px] text-muted-foreground">
              {new Date(e.at).toLocaleString(lang)} · {e.source === "itcloud" ? "ITCloud" : (e.actor ?? "—")}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// ── overview: edit the contract, stop or delete it ──
function OverviewTab({ client, k, editable, onChanged, onClose }: { client: CrmDetail; k: Detail; editable: boolean; onChanged: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const can = useCan();
  const { data: types = [] } = useContractTypes();
  const base = `/crm/clients/${client.id}/contracts/${k.id}`;
  const isBank = k.billingMode === "banked";
  const [rebate, setRebate] = useState(k.rebateBps ? String(k.rebateBps / 100) : "");
  useEffect(() => setRebate(k.rebateBps ? String(k.rebateBps / 100) : ""), [k.rebateBps]);
  const [bankRate, setBankRate] = useState(String((k.bankRateCents ?? 0) / 100));
  const [rollover, setRollover] = useState<BankRollover>((k.bankRollover ?? "lose") as BankRollover);
  useEffect(() => {
    setBankRate(String((k.bankRateCents ?? 0) / 100));
    setRollover((k.bankRollover ?? "lose") as BankRollover);
  }, [k.bankRateCents, k.bankRollover]);
  const figureField = k.billingMode === "hourly" ? null : k.billingMode === "per_ticket" ? "ticketRate" : k.billingMode === "fixed" ? "fixedPrice" : k.billingMode === "banked" ? "bankedHours" : null;
  const figureValue = k.billingMode === "hourly" ? null : k.billingMode === "per_ticket" ? k.ticketRateCents : k.billingMode === "fixed" ? k.fixedPriceCents : k.billingMode === "banked" ? k.bankedHoursX100 : null;
  const show = (v: number | null) => (v == null ? "" : String(v / 100));
  // the hourly rate of the contract: what is typed, else what applies (the usual rate on an hourly contract, none on the others)
  const rateNow = show(k.hourlyRateCents ?? (k.billingMode === "hourly" ? k.usualRateCents : 0));
  const [rate, setRate] = useState(rateNow);
  useEffect(() => setRate(rateNow), [rateNow]);
  // the bundle of a recurring contract: on when it has a price
  const bundleNow = { on: k.bundlePriceCents != null, price: show(k.bundlePriceCents ?? null), qty: String(k.bundleQuantity ?? 1) };
  const [bundle, setBundle] = useState(bundleNow);
  useEffect(() => setBundle(bundleNow), [bundleNow.on, bundleNow.price, bundleNow.qty]); // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState({ name: k.name, typeKey: k.typeKey ?? "", startDate: k.startDate ?? "", endDate: k.endDate ?? "", billingPeriod: k.billingPeriod, billedThrough: k.billedThrough ?? "", figure: show(figureValue) });
  useEffect(() => setF({ name: k.name, typeKey: k.typeKey ?? "", startDate: k.startDate ?? "", endDate: k.endDate ?? "", billingPeriod: k.billingPeriod, billedThrough: k.billedThrough ?? "", figure: show(figureValue) }), [k.name, k.typeKey, k.startDate, k.endDate, k.billingPeriod, k.billedThrough, figureValue]); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.patch<{ approved?: number }>(base, p),
    onSuccess: () => {
      toast.success(t("crm.contracts.billingSaved"));
      onChanged();
    },
    onError: (e) => toast.error(contractError(t, e)),
  });
  const del = useMutation({
    mutationFn: () => api.del<{ deleted: boolean; deactivated: boolean }>(base),
    onSuccess: (r) => {
      toast.success(r.deleted ? t("crm.contracts.window.deleted") : t("crm.contracts.window.stopped"));
      onChanged();
      if (r.deleted) onClose();
    },
    onError: (e) => toast.error(contractError(t, e)),
  });
  const dirty = f.name.trim() !== k.name || f.typeKey !== (k.typeKey ?? "") || f.startDate !== (k.startDate ?? "") || f.endDate !== (k.endDate ?? "") || f.billingPeriod !== k.billingPeriod || f.billedThrough !== (k.billedThrough ?? "") || (figureField !== null && (toCents(f.figure) ?? null) !== (figureValue ?? null)) || rate !== rateNow || Math.round(percentOf(rebate) * 100) !== (k.rebateBps ?? 0) || (isBank && (toCents(bankRate) !== (k.bankRateCents ?? 0) || rollover !== (k.bankRollover ?? "lose"))) || bundle.on !== bundleNow.on || (bundle.on && (bundle.price !== bundleNow.price || bundle.qty !== bundleNow.qty));
  const save = () => {
    const p: Record<string, unknown> = {};
    if (f.name.trim() !== k.name) p.name = f.name.trim();
    if (f.typeKey && f.typeKey !== (k.typeKey ?? "")) p.typeKey = f.typeKey;
    if (f.startDate !== (k.startDate ?? "")) p.startDate = f.startDate || null;
    if (f.endDate !== (k.endDate ?? "")) p.endDate = f.endDate || null;
    if (f.billingPeriod !== k.billingPeriod) p.billingPeriod = f.billingPeriod;
    if (f.billedThrough !== (k.billedThrough ?? "")) p.billedThrough = f.billedThrough || null;
    if (rate !== rateNow) p.hourlyRate = rate.trim() === "" ? 0 : Number(rate.replace(",", "."));
    if (bundle.on !== bundleNow.on || (bundle.on && (bundle.price !== bundleNow.price || bundle.qty !== bundleNow.qty))) {
      p.bundlePrice = bundle.on ? Number(bundle.price.replace(",", ".")) || 0 : null;
      if (bundle.on) p.bundleQuantity = Math.max(1, Math.round(Number(bundle.qty) || 1));
    }
    if (figureField && (toCents(f.figure) ?? null) !== (figureValue ?? null)) {
      const n = f.figure.trim() === "" ? null : Number(f.figure.replace(",", "."));
      p[figureField] = n;
    }
    if (Math.round(percentOf(rebate) * 100) !== (k.rebateBps ?? 0)) p.rebate = percentOf(rebate);
    if (isBank) {
      if (toCents(bankRate) !== (k.bankRateCents ?? 0)) p.bankedRate = (toCents(bankRate) ?? 0) / 100;
      if (rollover !== (k.bankRollover ?? "lose")) p.bankRollover = rollover;
    }
    patch.mutate(p);
  };
  const askDelete = async () => {
    const ok = await confirm(
      k.charged.has
        ? { title: t("crm.contracts.window.stopTitle", { name: k.name }), description: t("crm.contracts.window.stopText", { items: k.charged.billingItems, time: k.charged.timeEntries, services: k.charged.servicesStarted }), confirmLabel: t("crm.contracts.window.stop"), destructive: true }
        : { title: t("crm.contracts.window.deleteTitle", { name: k.name }), description: t("crm.contracts.window.deleteText"), confirmLabel: t("common.delete"), destructive: true },
    );
    if (ok) del.mutate();
  };
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t("crm.contracts.name")} className="sm:col-span-2">
          <Input value={f.name} disabled={!editable} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} />
        </Field>
        <Field label={t("crm.contracts.type")}>
          <select value={f.typeKey} disabled={!editable} onChange={(e) => setF({ ...f, typeKey: e.target.value })} className={field}>
            {!k.typeKey && <option value="">{k.type ?? t("crm.contracts.noType")}</option>}
            {types.map((x) => (
              <option key={x.key} value={x.key}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("crm.contracts.start")}>
          <Input type="date" value={f.startDate} disabled={!editable} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </Field>
        <Field label={t("crm.contracts.end")}>
          <Input type="date" value={f.endDate} min={f.startDate || undefined} disabled={!editable} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        </Field>
        {!isBank && (
          <Field label={t("crm.contracts.window.chargedBy")}>
            <select value={f.billingPeriod} disabled={!editable} onChange={(e) => setF({ ...f, billingPeriod: e.target.value as BillingPeriod })} className={field}>
              <option value="monthly">{t("crm.contracts.window.monthly")}</option>
              <option value="yearly">{t("crm.contracts.window.yearly")}</option>
            </select>
          </Field>
        )}
        <Field label={t("crm.contracts.billedThrough")} hint={t("crm.contracts.billedThroughText")}>
          <Input type="date" value={f.billedThrough} disabled={!editable} onChange={(e) => setF({ ...f, billedThrough: e.target.value })} />
        </Field>
        {!isBank && (
          <Field label={t("crm.contracts.hourlyRate")} hint={t("crm.contracts.hourlyRateHint")}>
            <Input value={rate} disabled={!editable} inputMode="decimal" placeholder={String(k.usualRateCents / 100)} onChange={(e) => setRate(e.target.value)} className="text-right font-mono" />
          </Field>
        )}
        {isBank && (
          <Field label={t("crm.contracts.bank.rate")}>
            <Input value={bankRate} disabled={!editable} inputMode="decimal" onChange={(e) => setBankRate(e.target.value)} className="text-right font-mono" />
          </Field>
        )}
        {figureField && (
          <Field label={t(isBank ? "crm.contracts.bank.hours" : `crm.contracts.figure_${k.billingMode}`)}>
            <Input value={f.figure} disabled={!editable} inputMode="decimal" placeholder={k.billingMode === "hourly" ? String(k.usualRateCents / 100) : "0"} onChange={(e) => setF({ ...f, figure: e.target.value })} className="text-right font-mono" />
          </Field>
        )}
      </div>
      {k.billingMode !== "fixed" && (
        <div className="space-y-2 rounded-xl border bg-background/30 p-3">
          <p className="text-sm font-semibold">{t("rebate.contract")}</p>
          <p className="text-xs text-muted-foreground">{t("rebate.contractHint")}</p>
          <RebateInput regular={isBank ? (toCents(bankRate) ?? 0) / 100 : k.billingMode === "hourly" ? Number(rate.replace(",", ".")) || 0 : null} percent={rebate} onPercent={setRebate} unit={isBank || k.billingMode === "hourly" ? "/ h" : undefined} />
        </div>
      )}
      {isBank && <RolloverPicker value={rollover} onChange={setRollover} disabled={!editable} />}
      {k.billingMode === "monthly" && (
        <div className="space-y-3 rounded-xl border bg-background/30 p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch checked={bundle.on} disabled={!editable} onCheckedChange={(v) => setBundle({ ...bundle, on: v })} /> {t("crm.contracts.bundle.toggle")}
          </label>
          <p className="text-xs text-muted-foreground">{t("crm.contracts.bundle.hint")}</p>
          {bundle.on && (
            <div className="grid gap-3 sm:grid-cols-[6rem_9rem]">
              <Field label={t("crm.contracts.window.quantity")}>
                <Input value={bundle.qty} disabled={!editable} inputMode="numeric" onChange={(e) => setBundle({ ...bundle, qty: e.target.value })} className="text-right font-mono" />
              </Field>
              <Field label={f.billingPeriod === "yearly" ? t("crm.contracts.bundle.priceYear") : t("crm.contracts.bundle.priceMonth")}>
                <Input value={bundle.price} disabled={!editable} inputMode="decimal" placeholder="0" onChange={(e) => setBundle({ ...bundle, price: e.target.value })} className="text-right font-mono" />
              </Field>
            </div>
          )}
        </div>
      )}
      {editable && (
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-muted-foreground" title={t("crm.contracts.autoHint")}>
            <Switch checked={k.autoApprove} disabled={patch.isPending || !can("accounting.manage")} onCheckedChange={(v) => patch.mutate({ autoApprove: v })} /> {t("crm.contracts.auto")}
          </label>
          {!k.isSupportDefault && k.active && (
            <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 text-xs" disabled={patch.isPending} onClick={() => patch.mutate({ supportDefault: true })}>
              <Star className="size-3" /> {t("crm.contracts.makeDefault")}
            </Button>
          )}
          <Button type="button" size="sm" disabled={!dirty || patch.isPending || !f.name.trim()} onClick={save} className="ml-auto bg-grad-gold font-semibold text-[#1a1204]">
            {patch.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("common.save")}
          </Button>
        </div>
      )}
      {editable && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/[0.04] p-4">
          <p className="text-sm font-medium">{k.active ? (k.charged.has ? t("crm.contracts.window.stopHeading") : t("crm.contracts.window.deleteHeading")) : t("crm.contracts.window.inactiveHeading")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {k.active
              ? k.charged.has
                ? t("crm.contracts.window.stopText", { items: k.charged.billingItems, time: k.charged.timeEntries, services: k.charged.servicesStarted })
                : t("crm.contracts.window.deleteText")
              : t("crm.contracts.window.inactiveText", { date: k.endedOn ? shortDate(k.endedOn) : "—" })}
          </p>
          <div className="mt-3 flex gap-2">
            {k.active ? (
              <Button type="button" variant="outline" size="sm" disabled={del.isPending} onClick={() => void askDelete()} className="gap-1.5 border-destructive/50 text-destructive hover:bg-destructive/10">
                {del.isPending ? <Loader2 className="size-3.5 animate-spin" /> : k.charged.has ? <Ban className="size-3.5" /> : <Trash2 className="size-3.5" />} {k.charged.has ? t("crm.contracts.window.stop") : t("common.delete")}
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" disabled={patch.isPending} onClick={() => patch.mutate({ active: true })} className="gap-1.5">
                <Play className="size-3.5" /> {t("crm.contracts.window.resume")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

