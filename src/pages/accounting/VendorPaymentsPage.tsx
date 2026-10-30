import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate, longDateTime } from "@/pages/tickets/shared";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSearchParams } from "react-router-dom";
import { PayrollPlan } from "./PayrollPlan";
import { RecurringPayments } from "./RecurringPayments";
import { VendorForecast } from "./VendorForecast";

type Bill = { id: string; vendor: string; number: string | null; issuedOn: string; dueOn: string | null; totalCents: number; balanceCents: number; memo: string | null; status: "open" | "overdue" | "paid"; daysLate: number };
type Bucket = { count: number; cents: number };
type Summary = { today: string; overdue: Bucket; dueToday: Bucket; next7: Bucket; next30: Bucket; noDue: Bucket; totalOpen: Bucket };
type Status = { connected: boolean; syncOn: boolean; last: { at: string; added: number; updated: number; removed: number; total: number } | null };

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Accounting › Paiements fournisseurs: the vendors' bills of QuickBooks laid out on a calendar by due date. */
export function VendorPaymentsPage() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const lang = i18n.language;
  const [sp, setSp] = useSearchParams();
  const tabs = ['calendar', 'forecast', 'recurring', ...(can('hr.manage') ? ['payroll'] : [])];
  const tab = tabs.includes(sp.get('tab') ?? '') ? sp.get('tab')! : 'calendar';
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [picked, setPicked] = useState<string | null>(null);

  const status = useQuery({ queryKey: ["vendor-bills", "status"], queryFn: () => api.get<Status>("/vendor-payments/status") });
  const summary = useQuery({ queryKey: ["vendor-bills", "summary"], queryFn: () => api.get<Summary>("/vendor-payments/summary"), refetchInterval: 60_000 });
  const bills = useQuery({ queryKey: ["vendor-bills", "open"], queryFn: () => api.get<{ today: string; bills: Bill[] }>("/vendor-payments/bills?status=open"), refetchInterval: 60_000 });

  const sync = useMutation({
    mutationFn: () => api.post<{ added: number; updated: number; removed: number }>("/vendor-payments/sync"),
    onSuccess: (r) => {
      toast.success(t("vendorBills.synced", r));
      void qc.invalidateQueries({ queryKey: ["vendor-bills"] });
    },
    onError: (e) => toast.error(t(`vendorBills.errors.${e instanceof ApiError ? e.message : "other"}`, { defaultValue: t("vendorBills.errors.other") })),
  });

  const today = bills.data?.today ?? summary.data?.today ?? "";
  const open = bills.data?.bills ?? [];
  const byDay = useMemo(() => {
    const m = new Map<string, Bill[]>();
    for (const b of open) if (b.dueOn) m.set(b.dueOn, [...(m.get(b.dueOn) ?? []), b]);
    return m;
  }, [open]);
  const late = open.filter((b) => b.status === "overdue");
  const noDue = open.filter((b) => !b.dueOn);

  const first = new Date(cursor.y, cursor.m, 1);
  const offset = (first.getDay() + 6) % 7; // Monday first
  const length = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((offset + length) / 7) * 7 }, (_, i) => (i < offset || i >= offset + length ? null : i - offset + 1));
  const locale = lang === "en" ? "en-CA" : "fr-CA";
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(first);
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 1 + i)));
  const shift = (n: number) => setCursor(({ y, m }) => ({ y: y + Math.floor((m + n) / 12), m: (((m + n) % 12) + 12) % 12 }));
  const monthKey = `${cursor.y}-${pad(cursor.m + 1)}`;
  const monthTotal = [...byDay].filter(([d]) => d.startsWith(monthKey)).reduce((x, [, l]) => x + l.reduce((y, b) => y + b.balanceCents, 0), 0);
  const shown = picked ? (byDay.get(picked) ?? []) : [];

  const tiles: { key: string; b?: Bucket; tone: string }[] = [
    { key: "overdue", b: summary.data?.overdue, tone: "border-red-500/40 text-red-300" },
    { key: "dueToday", b: summary.data?.dueToday, tone: "border-amber-500/40 text-amber-300" },
    { key: "next7", b: summary.data?.next7, tone: "border-[color:var(--gold)]/40 text-primary" },
    { key: "next30", b: summary.data?.next30, tone: "border-sky-500/40 text-sky-300" },
  ];

  return (
    <div className="relative isolate space-y-6">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <CalendarClock className="size-6 text-primary" /> {t("vendorBills.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("vendorBills.subtitle")}</p>
        </div>
        {can("accounting.manage") && (
          <div className="flex items-center gap-3">
            <p className="text-xs text-muted-foreground">{status.data?.last ? t("vendorBills.last", { when: longDateTime(status.data.last.at), total: status.data.last.total }) : t("vendorBills.never")}</p>
            <Button size="sm" variant="outline" disabled={sync.isPending || status.data?.connected === false} onClick={() => sync.mutate()}>
              {sync.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("vendorBills.refresh")}
            </Button>
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setSp((p) => { const n = new URLSearchParams(p); n.set("tab", v); return n; }, { replace: true })}>
        <TabsList>
          {tabs.map((k) => (
            <TabsTrigger key={k} value={k}>
              {t(`vendorBills.tabs.${k}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="calendar" className="space-y-6">
      {status.data && !status.data.connected && (
        <div className="glass rounded-2xl border border-dashed p-4 text-sm">
          <p className="font-semibold">{t("vendorBills.notConnected")}</p>
          <p className="text-muted-foreground">{t("vendorBills.notConnectedText")}</p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((x) => (
          <div key={x.key} className={cn("glass rounded-2xl border p-4", x.tone)}>
            <p className="text-xs uppercase tracking-wide opacity-80">{t(`vendorBills.tiles.${x.key}`)}</p>
            {x.b ? <p className="mt-1 text-2xl font-bold tabular-nums">{money(x.b.cents, lang)}</p> : <Skeleton className="mt-1 h-8 w-32" />}
            <p className="text-xs text-muted-foreground">{t("vendorBills.count", { count: x.b?.count ?? 0 })}</p>
          </div>
        ))}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="glass rounded-2xl border p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button size="icon" variant="ghost" onClick={() => shift(-1)} aria-label={t("vendorBills.prev")}>
                <ChevronLeft className="size-4" />
              </Button>
              <h2 className="min-w-40 text-center text-lg font-semibold capitalize">{monthLabel}</h2>
              <Button size="icon" variant="ghost" onClick={() => shift(1)} aria-label={t("vendorBills.next")}>
                <ChevronRight className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCursor({ y: new Date().getFullYear(), m: new Date().getMonth() })}>
                {t("vendorBills.thisMonth")}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{t("vendorBills.monthTotal", { amount: money(monthTotal, lang) })}</p>
          </div>
          {bills.isLoading ? (
            <Skeleton className="h-96" />
          ) : (
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border bg-border">
              {weekdays.map((w) => (
                <div key={w} className="bg-background/60 p-1.5 text-center text-[11px] font-medium uppercase text-muted-foreground">
                  {w}
                </div>
              ))}
              {cells.map((d, i) => {
                if (d === null) return <div key={i} className="min-h-20 bg-background/30" />;
                const key = iso(cursor.y, cursor.m, d);
                const list = byDay.get(key) ?? [];
                const total = list.reduce((x, b) => x + b.balanceCents, 0);
                const isLate = key < today;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setPicked(picked === key ? null : key)}
                    className={cn(
                      "min-h-20 bg-background/60 p-1.5 text-left align-top transition hover:bg-background/80",
                      key === today && "ring-1 ring-inset ring-[color:var(--gold)]",
                      picked === key && "bg-[color:var(--gold)]/10",
                    )}
                  >
                    <span className={cn("text-xs", key === today ? "font-bold text-primary" : "text-muted-foreground")}>{d}</span>
                    {list.length > 0 && (
                      <span className={cn("mt-1 block rounded-md px-1 py-0.5 text-[11px] font-semibold tabular-nums", isLate ? "bg-red-500/20 text-red-300" : "bg-[color:var(--gold)]/15 text-primary")}>
                        {money(total, lang)}
                        <span className="block font-normal opacity-80">{t("vendorBills.count", { count: list.length })}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-4">
          {picked && <BillList title={t("vendorBills.dayTitle", { date: shortDate(picked) })} bills={shown} empty={t("vendorBills.dayNone")} lang={lang} />}
          <BillList title={t("vendorBills.lateTitle", { count: late.length })} bills={late} empty={t("vendorBills.lateNone")} lang={lang} tone="late" />
          {noDue.length > 0 && <BillList title={t("vendorBills.noDueTitle", { count: noDue.length })} bills={noDue} empty="" lang={lang} />}
        </section>
      </div>
        </TabsContent>

        <TabsContent value="forecast">
          <VendorForecast />
        </TabsContent>
        <TabsContent value="recurring">
          <RecurringPayments />
        </TabsContent>
        {tabs.includes("payroll") && (
          <TabsContent value="payroll">
            <PayrollPlan />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function BillList({ title, bills, empty, lang, tone }: { title: string; bills: Bill[]; empty: string; lang: string; tone?: "late" }) {
  const { t } = useTranslation();
  return (
    <div className="glass overflow-hidden rounded-2xl border">
      <h3 className={cn("border-b px-4 py-2.5 text-sm font-semibold", tone === "late" && bills.length > 0 && "text-red-300")}>{title}</h3>
      {bills.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y">
          {bills.map((b) => (
            <li key={b.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{b.vendor}</p>
                <p className="text-xs text-muted-foreground">
                  {b.number ? `#${b.number} · ` : ""}
                  {b.dueOn ? t("vendorBills.due", { date: shortDate(b.dueOn) }) : t("vendorBills.noDue")}
                  {b.daysLate > 0 && <span className="text-red-300"> · {t("vendorBills.daysLate", { count: b.daysLate })}</span>}
                </p>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <p className="font-semibold">{money(b.balanceCents, lang)}</p>
                {b.balanceCents !== b.totalCents && <p className="text-xs text-muted-foreground">{t("vendorBills.ofTotal", { amount: money(b.totalCents, lang) })}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
