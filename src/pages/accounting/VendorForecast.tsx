import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";

type Event = { kind: "in" | "out"; date: string; cents: number; label: string; ref: string | null; late: boolean };
type Day = { date: string; inCents: number; outCents: number; balanceCents: number };
type Forecast = {
  today: string;
  days: number;
  settings: { balanceCents: number; balanceOn: string | null; payDelayDays: number; lateDelayDays: number };
  startCents: number;
  inCents: number;
  outCents: number;
  endCents: number;
  lowest: { date: string; balanceCents: number };
  shortfall: { date: string; balanceCents: number } | null;
  leftOut: { noDueIn: number; noDueOut: number; beyondIn: number; beyondOut: number };
  series: Day[];
  events: Event[];
};

const HORIZONS = [30, 60, 90, 180];

/** Cash forecast: the portal's client invoices coming in against the vendors' bills going out, day by day. */
export function VendorForecast() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const can = useCan();
  const qc = useQueryClient();
  const [days, setDays] = useState(60);
  const f = useQuery({ queryKey: ["vendor-bills", "forecast", days], queryFn: () => api.get<Forecast>(`/vendor-payments/forecast?days=${days}`), refetchInterval: 60_000 });
  const [balance, setBalance] = useState("");
  const [pay, setPay] = useState("");
  const [late, setLate] = useState("");
  const s = f.data?.settings;
  useEffect(() => {
    if (!s) return;
    setBalance(String(s.balanceCents / 100));
    setPay(String(s.payDelayDays));
    setLate(String(s.lateDelayDays));
  }, [s?.balanceCents, s?.payDelayDays, s?.lateDelayDays]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => api.put("/vendor-payments/forecast/settings", { balance: Number(balance.replace(",", ".")) || 0, payDelayDays: Math.max(0, Math.round(Number(pay) || 0)), lateDelayDays: Math.max(0, Math.round(Number(late) || 0)) }),
    onSuccess: () => {
      toast.success(t("vendorBills.forecast.saved"));
      void qc.invalidateQueries({ queryKey: ["vendor-bills", "forecast"] });
    },
    onError: () => toast.error(t("vendorBills.forecast.saveFailed")),
  });

  const data = f.data;
  const moves = (data?.events ?? []).reduce<Record<string, Event[]>>((m, e) => ({ ...m, [e.date]: [...(m[e.date] ?? []), e] }), {});
  return (
    <section className="glass space-y-4 rounded-2xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("vendorBills.forecast.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("vendorBills.forecast.subtitle")}</p>
        </div>
        <div className="flex gap-1">
          {HORIZONS.map((n) => (
            <Button key={n} size="sm" variant={days === n ? "default" : "outline"} onClick={() => setDays(n)}>
              {t("vendorBills.forecast.horizon", { count: n })}
            </Button>
          ))}
        </div>
      </div>

      {can("accounting.manage") && (
        <form
          className="grid gap-3 rounded-xl border p-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="fc-balance">{t("vendorBills.forecast.balance")}</Label>
            <Input id="fc-balance" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} />
            {s?.balanceOn && <p className="text-[11px] text-muted-foreground">{t("vendorBills.forecast.balanceOn", { date: shortDate(s.balanceOn) })}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="fc-pay">{t("vendorBills.forecast.payDelay")}</Label>
            <Input id="fc-pay" inputMode="numeric" value={pay} onChange={(e) => setPay(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">{t("vendorBills.forecast.payDelayHint")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="fc-late">{t("vendorBills.forecast.lateDelay")}</Label>
            <Input id="fc-late" inputMode="numeric" value={late} onChange={(e) => setLate(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">{t("vendorBills.forecast.lateDelayHint")}</p>
          </div>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("vendorBills.forecast.save")}
          </Button>
        </form>
      )}

      {!data ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className={cn("flex items-start gap-3 rounded-xl border p-4", data.shortfall ? "border-red-500/40 bg-red-500/10" : "border-emerald-500/40 bg-emerald-500/10")}>
            {data.shortfall ? <CircleAlert className="mt-0.5 size-5 shrink-0 text-red-300" /> : <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-300" />}
            <div>
              <p className="font-semibold">
                {data.shortfall ? t("vendorBills.forecast.short", { date: shortDate(data.shortfall.date), amount: money(-data.lowest.balanceCents, lang) }) : t("vendorBills.forecast.enough", { days: data.days, amount: money(data.lowest.balanceCents, lang) })}
              </p>
              <p className="text-sm text-muted-foreground">
                {data.shortfall ? t("vendorBills.forecast.shortHint", { date: shortDate(data.lowest.date) }) : t("vendorBills.forecast.enoughHint", { date: shortDate(data.lowest.date) })}
              </p>
              {data.settings.balanceOn === null && <p className="mt-1 text-sm text-amber-300">{t("vendorBills.forecast.noBalance")}</p>}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <Figure label={t("vendorBills.forecast.start")} cents={data.startCents} lang={lang} />
            <Figure label={t("vendorBills.forecast.in")} cents={data.inCents} lang={lang} tone="text-emerald-300" />
            <Figure label={t("vendorBills.forecast.out")} cents={-data.outCents} lang={lang} tone="text-red-300" />
            <Figure label={t("vendorBills.forecast.end")} cents={data.endCents} lang={lang} />
          </div>

          <Chart series={data.series} />

          {(data.leftOut.noDueIn > 0 || data.leftOut.noDueOut > 0) && (
            <p className="text-xs text-muted-foreground">{t("vendorBills.forecast.noDue", { in: money(data.leftOut.noDueIn, lang), out: money(data.leftOut.noDueOut, lang) })}</p>
          )}

          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-background/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t("vendorBills.forecast.date")}</th>
                  <th className="px-3 py-2">{t("vendorBills.forecast.what")}</th>
                  <th className="px-3 py-2 text-right">{t("vendorBills.forecast.amount")}</th>
                  <th className="px-3 py-2 text-right">{t("vendorBills.forecast.balance")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.series
                  .filter((x) => moves[x.date])
                  .map((x) =>
                    moves[x.date].map((e, i, all) => (
                      <tr key={`${x.date}-${e.ref}-${e.kind}`}>
                        <td className="px-3 py-1.5 align-top text-muted-foreground">{i === 0 ? shortDate(x.date) : ""}</td>
                        <td className="px-3 py-1.5">
                          {e.label}
                          {e.late && <span className="ml-2 rounded-full border border-red-500/40 px-1.5 text-[10px] text-red-300">{t(e.kind === "in" ? "vendorBills.forecast.lateIn" : "vendorBills.forecast.lateOut")}</span>}
                        </td>
                        <td className={cn("px-3 py-1.5 text-right tabular-nums", e.kind === "in" ? "text-emerald-300" : "text-red-300")}>{money(e.kind === "in" ? e.cents : -e.cents, lang)}</td>
                        <td className={cn("px-3 py-1.5 text-right tabular-nums", x.balanceCents < 0 && "font-semibold text-red-300")}>{i === all.length - 1 ? money(x.balanceCents, lang) : ""}</td>
                      </tr>
                    )),
                  )}
                {data.events.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                      {t("vendorBills.forecast.none")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Figure({ label, cents, lang, tone }: { label: string; cents: number; lang: string; tone?: string }) {
  return (
    <div className="rounded-xl border p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-bold tabular-nums", tone, cents < 0 && !tone && "text-red-300")}>{money(cents, lang)}</p>
    </div>
  );
}

/** The running balance as a line; the zero line is drawn when the balance goes under it. */
function Chart({ series }: { series: Day[] }) {
  const w = 800;
  const h = 160;
  const values = series.map((x) => x.balanceCents);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const x = (i: number) => (i / Math.max(1, series.length - 1)) * w;
  const y = (v: number) => h - 8 - ((v - min) / (max - min || 1)) * (h - 16);
  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.balanceCents).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-40 w-full" role="img" preserveAspectRatio="none">
      {min < 0 && <line x1="0" x2={w} y1={y(0)} y2={y(0)} stroke="currentColor" strokeDasharray="4 4" className="text-red-400" opacity={0.7} />}
      <path d={`${path} L${w},${h} L0,${h} Z`} fill="currentColor" className="text-primary" opacity={0.1} />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" className="text-primary" />
    </svg>
  );
}
