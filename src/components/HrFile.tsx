import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2, PiggyBank, Thermometer, TreePalm } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

type HrFileData = {
  userId: string;
  hourlyWageCents: number | null;
  overtimeAfterHours: number;
  bankCents: number;
  bankHours: number | null;
  vacationCents: number;
  vacationHours: number | null;
  sickHours: number;
  negative: ("bank" | "vacation" | "sick")[];
  canEdit: boolean;
};
type LedgerRow = { id: string; account: "bank" | "vacation" | "sick"; kind: string; cents: number | null; hours: number | null; weekStart: string | null; note: string | null; by: string | null; at: string };
type Account = "bank" | "vacation" | "sick";

const KEY = (id: string) => ["hr", id];

/**
 * The RH tab of an employee: hourly wage, the hours bank and the vacation bank (in dollars) and the sick days (in hours).
 * HR (hr.manage) changes everything here, each change by hand confirmed with a tick; an employee with hr.own only sees their own.
 * Entries on the timesheet move the accounts by themselves (banked hours add, bank payouts, vacation and sick entries take off).
 */
export function HrFile({ userId }: { userId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const loc = i18n.language === "en" ? "en-CA" : "fr-CA";
  const { data, isLoading } = useQuery({ queryKey: KEY(userId), queryFn: () => api.get<HrFileData>(`/hr/${userId}`) });
  const { data: ledger } = useQuery({ queryKey: [...KEY(userId), "ledger"], queryFn: () => api.get<LedgerRow[]>(`/hr/${userId}/ledger`) });
  const money = (cents: number) => new Intl.NumberFormat(loc, { style: "currency", currency: "CAD" }).format(cents / 100);
  const h = (n: number) => n.toLocaleString(loc, { maximumFractionDigits: 2 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY(userId) });
    void qc.invalidateQueries({ queryKey: ["hr", "people"] });
  };
  const fail = (e: unknown) => toast.error(e instanceof ApiError && e.code === "hr_wage_missing" ? t("hr.wageMissing") : t("common.error"));

  const [wage, setWage] = useState<string | null>(null);
  const [overtime, setOvertime] = useState<string | null>(null);
  const saveProfile = useMutation({
    mutationFn: () =>
      api.put(`/hr/${userId}/profile`, {
        ...(wage !== null ? { hourlyWage: wage.trim() === "" ? null : Number(wage.replace(",", ".")) } : {}),
        ...(overtime !== null ? { overtimeAfterHours: Number(overtime.replace(",", ".")) } : {}),
      }),
    onSuccess: () => {
      toast.success(t("common.saved"));
      setWage(null);
      setOvertime(null);
      refresh();
    },
    onError: fail,
  });

  const [adj, setAdj] = useState({ account: "bank" as Account, value: "", note: "", confirm: false, unit: "amount" as "amount" | "hours" });
  const adjust = useMutation({
    mutationFn: () => {
      const n = Number(adj.value.replace(",", "."));
      return api.post(`/hr/${userId}/adjust`, { account: adj.account, ...(adj.account === "sick" || adj.unit === "hours" ? { hours: n } : { amount: n }), note: adj.note, confirm: true });
    },
    onSuccess: () => {
      toast.success(t("hr.adjusted"));
      setAdj({ ...adj, value: "", note: "", confirm: false });
      refresh();
    },
    onError: fail,
  });

  if (isLoading || !data) return <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />;
  const wageShown = wage ?? (data.hourlyWageCents != null ? String(data.hourlyWageCents / 100) : "");
  const overtimeShown = overtime ?? String(data.overtimeAfterHours);
  const dirty = wage !== null || overtime !== null;
  const nv = Number(adj.value.replace(",", "."));
  const adjOk = Number.isFinite(nv) && nv !== 0 && adj.confirm;

  const Balance = ({ icon: Icon, label, value, sub, bad, tone }: { icon: typeof PiggyBank; label: string; value: string; sub?: string; bad: boolean; tone: string }) => (
    <div className={cn("rounded-xl border p-3", bad ? "border-destructive/50 bg-destructive/10" : "bg-card/40")}>
      <p className={cn("flex items-center gap-1.5 text-xs font-medium", tone)}>
        <Icon className="size-3.5" /> {label}
      </p>
      <p className={cn("mt-1 font-mono text-lg font-semibold", bad && "text-destructive")}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-5">
      {data.negative.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {t("hr.negative", { accounts: data.negative.map((a) => t(`hr.account.${a}`)).join(", ") })}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Balance icon={PiggyBank} tone="text-sky-300" label={t("hr.account.bank")} value={money(data.bankCents)} sub={data.bankHours != null ? t("hr.hoursAtWage", { hours: h(data.bankHours) }) : undefined} bad={data.bankCents < 0} />
        <Balance icon={TreePalm} tone="text-emerald-300" label={t("hr.account.vacation")} value={money(data.vacationCents)} sub={data.vacationHours != null ? t("hr.hoursAtWage", { hours: h(data.vacationHours) }) : undefined} bad={data.vacationCents < 0} />
        <Balance icon={Thermometer} tone="text-rose-300" label={t("hr.account.sick")} value={`${h(data.sickHours)} h`} bad={data.sickHours < 0} />
      </div>

      <section className="space-y-2 rounded-xl border p-3">
        <h3 className="text-sm font-semibold">{t("hr.pay")}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("hr.wage")}</span>
            <Input value={wageShown} inputMode="decimal" disabled={!data.canEdit} onChange={(e) => setWage(e.target.value)} className="font-mono" placeholder="0,00" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("hr.overtimeAfter")}</span>
            <Input value={overtimeShown} inputMode="decimal" disabled={!data.canEdit} onChange={(e) => setOvertime(e.target.value)} className="font-mono" />
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("hr.payHint")}</p>
        {data.canEdit && (
          <div className="flex justify-end">
            <Button size="sm" disabled={!dirty || saveProfile.isPending} onClick={() => saveProfile.mutate()}>
              {saveProfile.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
          </div>
        )}
      </section>

      {data.canEdit && (
        <section className="space-y-3 rounded-xl border p-3">
          <h3 className="text-sm font-semibold">{t("hr.adjust")}</h3>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr]">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("hr.account.label")}</span>
              <select value={adj.account} onChange={(e) => setAdj({ ...adj, account: e.target.value as Account })} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm">
                {(["bank", "vacation", "sick"] as const).map((a) => (
                  <option key={a} value={a}>
                    {t(`hr.account.${a}`)}
                  </option>
                ))}
              </select>
            </label>
            {adj.account !== "sick" && (
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">{t("hr.unit")}</span>
                <select value={adj.unit} onChange={(e) => setAdj({ ...adj, unit: e.target.value as "amount" | "hours" })} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm">
                  <option value="amount">$</option>
                  <option value="hours">{t("hr.hoursAtWageUnit")}</option>
                </select>
              </label>
            )}
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{adj.account === "sick" || adj.unit === "hours" ? t("hr.valueHours") : t("hr.valueAmount")}</span>
              <Input value={adj.value} inputMode="decimal" onChange={(e) => setAdj({ ...adj, value: e.target.value })} className="font-mono" placeholder="+ / −" />
            </label>
          </div>
          <Input value={adj.note} maxLength={300} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder={t("hr.note")} />
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={adj.confirm} onChange={(e) => setAdj({ ...adj, confirm: e.target.checked })} className="mt-0.5" />
            <span>{t("hr.confirm")}</span>
          </label>
          <div className="flex justify-end">
            <Button size="sm" disabled={!adjOk || adjust.isPending} onClick={() => adjust.mutate()}>
              {adjust.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t("hr.apply")}
            </Button>
          </div>
        </section>
      )}

      <section className="space-y-1.5">
        <h3 className="text-sm font-semibold">{t("hr.history")}</h3>
        {!ledger?.length ? (
          <p className="text-xs text-muted-foreground">{t("hr.noHistory")}</p>
        ) : (
          <ul className="divide-y divide-border/50 rounded-xl border text-sm">
            {ledger.slice(0, 60).map((r) => {
              const value = r.cents != null ? money(r.cents) : `${h(r.hours ?? 0)} h`;
              const negative = (r.cents ?? r.hours ?? 0) < 0;
              return (
                <li key={r.id} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{new Intl.DateTimeFormat(loc, { day: "numeric", month: "short", year: "numeric" }).format(new Date(r.at))}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {t(`hr.account.${r.account}`)} · {t(`hr.kind.${r.kind}`)}
                    {r.note ? <span className="text-muted-foreground"> — {r.note}</span> : null}
                    {r.by ? <span className="text-muted-foreground"> ({r.by})</span> : null}
                  </span>
                  <span className={cn("shrink-0 font-mono", negative ? "text-destructive" : "text-emerald-300")}>{`${negative ? "" : "+"}${value}`}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
