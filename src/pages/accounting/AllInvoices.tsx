import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CircleCheck, CircleDashed, Clock, FileX, Loader2, Mail, MailX, RotateCcw, Search, type LucideIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";

type Status = "due" | "overdue" | "partial" | "paid" | "voided";
type Invoice = {
  id: string;
  clientId: string;
  number: string;
  company: string;
  issuedOn: string;
  dueOn: string | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  paidOn: string | null;
  status: Status;
  late: boolean;
  daysLate: number;
  source: "portal" | "autotask" | "quickbooks";
  poNumber: string | null;
  emailedAt: string | null;
  quickbooks: { id: string | null; syncedAt: string | null; error: string | null } | null;
};
type List = {
  summary: { count: number; totalCents: number; paidCents: number; dueCents: number; overdueCents: number; overdueCount: number };
  clients: { id: string; name: string }[];
  items: Invoice[];
};

const STYLE: Record<Status, string> = {
  paid: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  partial: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  due: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  overdue: "border-red-500/50 bg-red-500/15 text-red-300",
  voided: "border-slate-500/40 bg-slate-500/10 text-slate-400",
};
const ICON: Record<Status, LucideIcon> = { paid: CircleCheck, partial: CircleDashed, due: Clock, overdue: AlertTriangle, voided: FileX };
/** The status filter: "open" = still to pay (due, overdue or partial) */
const STATUS_FILTERS = ["open", "overdue", "partial", "paid", "voided"] as const;
/** The filters, in the address (prefixed: the other tab uses from/to) */
const KEYS = { status: "istatus", clientId: "iclient", from: "ifrom", to: "ito", q: "iq", emailed: "iemail", quickbooks: "iqb", source: "isrc" } as const;
type Filter = keyof typeof KEYS;

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Accounting › Factures › Toutes les factures: every invoice, filtered. */
export function AllInvoices() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const m = (c: number) => money(c, i18n.language);
  const [params, setParams] = useSearchParams();
  const get = (k: Filter) => params.get(KEYS[k]) ?? "";
  const set = (patch: Partial<Record<Filter, string | null>>) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(patch)) (v ? p.set(KEYS[k as Filter], v) : p.delete(KEYS[k as Filter]));
        return p;
      },
      { replace: true },
    );
  // the number / PO typed: sent a moment after the last key
  const [q, setQ] = useState(get("q"));
  useEffect(() => {
    const id = setTimeout(() => q !== get("q") && set({ q: q.trim() || null }), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const query = new URLSearchParams(Object.fromEntries((Object.keys(KEYS) as Filter[]).filter((k) => get(k)).map((k) => [k, get(k)]))).toString();
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["crm", "invoices", "all", query],
    queryFn: () => api.get<List>(`/crm/invoices${query ? `?${query}` : ""}`),
    placeholderData: (p) => p,
  });
  const emailed = useMutation({
    mutationFn: (v: { id: string; emailed: boolean }) => api.post(`/crm/invoices/${v.id}/emailed`, { emailed: v.emailed }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ["crm", "invoices"] });
      toast.success(t(v.emailed ? "allInvoices.markedEmailed" : "allInvoices.markedNotEmailed"));
    },
    onError: () => toast.error(t("common.error")),
  });
  const manage = can("accounting.manage");
  const active = (Object.keys(KEYS) as Filter[]).some((k) => get(k));

  // quick date ranges on the issue date
  const now = new Date();
  const ranges = [
    { key: "thisMonth", from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)) },
    { key: "lastMonth", from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) },
    { key: "thisYear", from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` },
  ];
  const sel = "h-9 w-auto min-w-40 bg-background/40";

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="glass space-y-3 rounded-2xl border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-9 bg-background/40 pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("allInvoices.search")} />
          </div>
          <Select value={get("clientId") || "all"} onValueChange={(v) => set({ clientId: v === "all" ? null : v })}>
            <SelectTrigger className={sel} aria-label={t("allInvoices.client")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-72">
              <SelectItem value="all">{t("allInvoices.allClients")}</SelectItem>
              {(data?.clients ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={get("emailed") || "all"} onValueChange={(v) => set({ emailed: v === "all" ? null : v })}>
            <SelectTrigger className={sel} aria-label={t("allInvoices.emailed")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allInvoices.emailAll")}</SelectItem>
              <SelectItem value="yes">{t("allInvoices.emailYes")}</SelectItem>
              <SelectItem value="no">{t("allInvoices.emailNo")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={get("quickbooks") || "all"} onValueChange={(v) => set({ quickbooks: v === "all" ? null : v })}>
            <SelectTrigger className={sel} aria-label="QuickBooks">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allInvoices.qbAll")}</SelectItem>
              <SelectItem value="synced">{t("allInvoices.qbSynced")}</SelectItem>
              <SelectItem value="unsynced">{t("allInvoices.qbUnsynced")}</SelectItem>
              <SelectItem value="error">{t("allInvoices.qbError")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={get("source") || "all"} onValueChange={(v) => set({ source: v === "all" ? null : v })}>
            <SelectTrigger className={sel} aria-label={t("allInvoices.source")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allInvoices.sourceAll")}</SelectItem>
              <SelectItem value="portal">{t("allInvoices.sourcePortal")}</SelectItem>
              <SelectItem value="quickbooks">QuickBooks</SelectItem>
              <SelectItem value="autotask">{t("allInvoices.sourceOld")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* status */}
          <div className="flex flex-wrap gap-1" role="group" aria-label={t("allInvoices.status")}>
            <Chip on={!get("status")} onClick={() => set({ status: null })}>
              {t("allInvoices.statusAll")}
            </Chip>
            {STATUS_FILTERS.map((s) => {
              const Icon = s === "open" ? Clock : ICON[s];
              return (
                <Chip key={s} on={get("status") === s} onClick={() => set({ status: get("status") === s ? null : s })} className={get("status") === s && s !== "open" ? STYLE[s] : undefined}>
                  <Icon className="size-3.5" /> {t(`allInvoices.statusFilter.${s}`)}
                </Chip>
              );
            })}
          </div>
          {/* issue dates */}
          <div className="ml-auto flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t("allInvoices.issued")}</span>
            <Input type="date" className="h-8 w-36 bg-background/40" value={get("from")} max={get("to") || undefined} onChange={(e) => set({ from: e.target.value || null })} aria-label={t("period.from")} />
            <span>→</span>
            <Input type="date" className="h-8 w-36 bg-background/40" value={get("to")} min={get("from") || undefined} onChange={(e) => set({ to: e.target.value || null })} aria-label={t("period.to")} />
            {ranges.map((r) => (
              <Chip key={r.key} on={get("from") === r.from && get("to") === r.to} onClick={() => set({ from: r.from, to: r.to })}>
                {t(`allInvoices.range.${r.key}`)}
              </Chip>
            ))}
          </div>
        </div>
        {active && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              setParams(
                (p) => {
                  for (const k of Object.values(KEYS)) p.delete(k);
                  return p;
                },
                { replace: true },
              );
            }}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <RotateCcw className="size-3.5" /> {t("allInvoices.reset")}
          </button>
        )}
      </div>

      {/* Totals of what is shown */}
      {data && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Total label={t("allInvoices.totals.count", { count: data.summary.count })} value={m(data.summary.totalCents)} />
          <Total label={t("allInvoices.totals.paid")} value={m(data.summary.paidCents)} tone="text-emerald-300" />
          <Total label={t("allInvoices.totals.due")} value={m(data.summary.dueCents)} tone="text-sky-300" />
          <Total
            label={t("allInvoices.totals.overdue", { count: data.summary.overdueCount })}
            value={m(data.summary.overdueCents)}
            tone={data.summary.overdueCents ? "text-red-300" : undefined}
          />
        </div>
      )}

      {/* The invoices */}
      {isLoading && <Loader2 className="mx-auto my-10 size-6 animate-spin text-muted-foreground" />}
      {data && !data.items.length && <p className="glass rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">{t("allInvoices.none")}</p>}
      {data && data.items.length > 0 && (
        <div className={cn("glass overflow-x-auto rounded-2xl border transition-opacity", isFetching && "opacity-70")}>
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2.5 text-left font-medium">{t("allInvoices.col.number")}</th>
                <th className="px-3 py-2.5 text-left font-medium">{t("allInvoices.client")}</th>
                <th className="px-3 py-2.5 text-left font-medium">{t("allInvoices.col.issued")}</th>
                <th className="px-3 py-2.5 text-left font-medium">{t("allInvoices.col.due")}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t("allInvoices.col.total")}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t("allInvoices.col.balance")}</th>
                <th className="px-3 py-2.5 text-left font-medium">{t("allInvoices.status")}</th>
                <th className="px-3 py-2.5 text-center font-medium">{t("allInvoices.col.email")}</th>
                <th className="px-4 py-2.5 text-center font-medium">QB</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {data.items.map((v) => {
                const Icon = ICON[v.status];
                return (
                  <tr key={v.id} className="transition-colors hover:bg-foreground/[0.03]">
                    <td className="px-4 py-2">
                      <span className="font-mono font-medium">{v.number}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {[v.source === "portal" ? t("allInvoices.sourcePortal") : v.source === "quickbooks" ? "QuickBooks" : t("allInvoices.sourceOld"), v.poNumber && `PO ${v.poNumber}`].filter(Boolean).join(" · ")}
                      </span>
                    </td>
                    <td className="max-w-56 px-3 py-2">
                      <Link to={`/crm/${v.clientId}?tab=invoices`} className="block truncate hover:text-primary hover:underline">
                        {v.company}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{shortDate(v.issuedOn)}</td>
                    <td className={cn("px-3 py-2", v.late ? "font-medium text-red-300" : "text-muted-foreground")}>
                      {v.dueOn ? shortDate(v.dueOn) : "—"}
                      {v.late && <span className="block text-[11px]">{t("allInvoices.daysLate", { count: v.daysLate })}</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{m(v.totalCents)}</td>
                    <td className={cn("px-3 py-2 text-right font-mono", v.balanceCents ? "" : "text-muted-foreground")}>{m(v.balanceCents)}</td>
                    <td className="px-3 py-2">
                      <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", STYLE[v.status])}>
                        <Icon className="size-3" />
                        {v.status === "paid" && v.paidOn ? t("crm.invoices.paidOn", { date: shortDate(v.paidOn) }) : t(`crm.invoices.state.${v.status}`)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            disabled={!manage || emailed.isPending}
                            onClick={() => emailed.mutate({ id: v.id, emailed: !v.emailedAt })}
                            className={cn(
                              "rounded-md p-1.5 transition-colors disabled:cursor-default",
                              v.emailedAt ? "text-emerald-400" : "text-muted-foreground/60",
                              manage && "hover:bg-accent hover:text-foreground",
                            )}
                            aria-label={v.emailedAt ? t("allInvoices.emailedOn", { date: shortDate(new Date(v.emailedAt).toLocaleDateString("en-CA")) }) : t("allInvoices.notEmailed")}
                          >
                            {v.emailedAt ? <Mail className="size-4" /> : <MailX className="size-4" />}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {v.emailedAt ? t("allInvoices.emailedOn", { date: shortDate(new Date(v.emailedAt).toLocaleDateString("en-CA")) }) : t("allInvoices.notEmailed")}
                          {manage && <span className="block text-[11px] opacity-80">{v.emailedAt ? t("allInvoices.clickNotEmailed") : t("allInvoices.clickEmailed")}</span>}
                        </TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="px-4 py-2 text-center">
                      {v.quickbooks?.error ? (
                        <span className="rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300" title={v.quickbooks.error}>
                          {t("allInvoices.qbErrorShort")}
                        </span>
                      ) : v.quickbooks?.id ? (
                        <span className="rounded border border-emerald-500/30 px-1.5 py-0.5 text-[10px] text-emerald-300">{t("allInvoices.qbSyncedShort")}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground/60">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.items.length >= 2000 && <p className="border-t px-4 py-2 text-center text-xs text-muted-foreground">{t("allInvoices.capped")}</p>}
        </div>
      )}
    </div>
  );
}

function Chip({ on, onClick, className, children }: { on: boolean; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
        on ? (className ?? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-medium text-foreground") : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        on && className && "font-medium",
      )}
    >
      {children}
    </button>
  );
}

function Total({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="glass rounded-2xl border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 font-mono text-xl font-bold", tone)}>{value}</p>
    </div>
  );
}
