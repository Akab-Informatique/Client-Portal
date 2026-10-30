import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";

type Row = { userId: string; name: string; wageCents: number | null; avgWeeklyCents: number | null; weeks: number; lastWeekCents: number | null; planCents: number | null; active: boolean };
type Payroll = { weekday: number; weeks: number; employees: Row[]; plannedCents: number };

const key = ["vendor-bills", "payroll"];

/** Accounting › Paiements fournisseurs › Paie: the average pay of each employee, and the weekly amount fixed for the forecast. */
export function PayrollPlan() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Payroll>("/vendor-payments/payroll") });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["vendor-bills", "forecast"] });
  };
  const day = useMutation({
    mutationFn: (weekday: number) => api.put("/vendor-payments/payroll-day", { weekday }),
    onSuccess: refresh,
  });
  const data = q.data;
  const active = (data?.employees ?? []).filter((e) => e.active);
  const avgTotal = active.reduce((x, e) => x + (e.avgWeeklyCents ?? 0), 0);
  const planned = active.reduce((x, e) => x + (e.planCents ?? 0), 0);

  return (
    <section className="glass space-y-3 rounded-2xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("vendorBills.payroll.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("vendorBills.payroll.subtitle", { weeks: data?.weeks ?? 8 })}</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("vendorBills.payroll.payday")}</span>
          <Select value={String(data?.weekday ?? 5)} onValueChange={(v) => day.mutate(Number(v))}>
            <SelectTrigger className="h-8 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t(`vendorBills.recurring.weekdays.${n}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!data ? (
        <Skeleton className="h-48" />
      ) : data.employees.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("vendorBills.payroll.none")}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Figure label={t("vendorBills.payroll.avgTotal")} cents={avgTotal} lang={lang} />
            <Figure label={t("vendorBills.payroll.plannedWeek")} cents={planned} lang={lang} strong />
            <Figure label={t("vendorBills.payroll.plannedMonth")} cents={Math.round((planned * 52) / 12)} lang={lang} />
          </div>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-background/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t("vendorBills.payroll.employee")}</th>
                  <th className="px-3 py-2 text-right">{t("vendorBills.payroll.wage")}</th>
                  <th className="px-3 py-2 text-right">{t("vendorBills.payroll.last")}</th>
                  <th className="px-3 py-2 text-right">{t("vendorBills.payroll.average")}</th>
                  <th className="px-3 py-2 text-right">{t("vendorBills.payroll.plan")}</th>
                  <th className="w-16 px-3 py-2 text-right">{t("vendorBills.payroll.counted")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.employees.map((e) => (
                  <Line key={e.userId} e={e} lang={lang} onSaved={refresh} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{t("vendorBills.payroll.hint")}</p>
        </>
      )}
    </section>
  );
}

function Figure({ label, cents, lang, strong }: { label: string; cents: number; lang: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-xl border p-3", strong && "border-[color:var(--gold)]/40")}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-bold tabular-nums", strong && "text-primary")}>{money(cents, lang)}</p>
    </div>
  );
}

function Line({ e, lang, onSaved }: { e: Row; lang: string; onSaved: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState(e.planCents === null ? "" : String(e.planCents / 100));
  useEffect(() => setV(e.planCents === null ? "" : String(e.planCents / 100)), [e.planCents]);
  const save = useMutation({
    mutationFn: (body: { weeklyCents?: number | null; active?: boolean }) => api.put(`/vendor-payments/payroll/${e.userId}`, body),
    onSuccess: onSaved,
    onError: () => toast.error(t("vendorBills.payroll.saveFailed")),
  });
  const typed = v.trim() === "" ? null : Math.round(Number(v.replace(/[\s$]/g, "").replace(",", ".")) * 100);
  const valid = typed === null || (Number.isFinite(typed) && typed >= 0);
  const dirty = valid && typed !== e.planCents;
  const commit = () => dirty && save.mutate({ weeklyCents: typed });
  return (
    <tr className={cn(!e.active && "opacity-50")}>
      <td className="px-3 py-1.5 font-medium">{e.name}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{e.wageCents === null ? t("vendorBills.payroll.noWage") : `${money(e.wageCents, lang)} / h`}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{e.lastWeekCents ? money(e.lastWeekCents, lang) : "—"}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">
        {e.avgWeeklyCents === null ? (
          "—"
        ) : (
          <button type="button" className="rounded px-1 underline decoration-dotted hover:text-primary" title={t("vendorBills.payroll.useAverage", { weeks: e.weeks })} onClick={() => setV(String(e.avgWeeklyCents! / 100))}>
            {money(e.avgWeeklyCents, lang)}
          </button>
        )}
      </td>
      <td className="px-3 py-1.5">
        <div className="ml-auto flex w-40 items-center gap-1">
          <Input
            className="h-8 text-right tabular-nums"
            inputMode="decimal"
            value={v}
            placeholder="0,00"
            onChange={(ev) => setV(ev.target.value)}
            onKeyDown={(ev) => ev.key === "Enter" && commit()}
          />
          <Button size="icon" variant="ghost" className="size-8 shrink-0" disabled={!dirty || save.isPending} onClick={commit} aria-label={t("vendorBills.forecast.save")}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          </Button>
        </div>
      </td>
      <td className="px-3 py-1.5 text-right">
        <Switch checked={e.active} onCheckedChange={(on) => save.mutate({ active: on })} aria-label={t("vendorBills.payroll.counted")} />
      </td>
    </tr>
  );
}
