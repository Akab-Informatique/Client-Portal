import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  BadgeDollarSign,
  Check,
  ClipboardCheck,
  Clock,
  DownloadCloud,
  FileText,
  Flag,
  FolderKanban,
  Hammer,
  Loader2,
  Package,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Sparkles,
  Undo2,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";
import { PeriodBar, usePeriod } from "./period";

export type Kind = "labour" | "charge" | "expense" | "contract" | "milestone" | "project";
export type Status = "pending" | "approved" | "posted" | "excluded";
export type Item = {
  id: string;
  clientId: string;
  clientName: string;
  kind: Kind;
  date: string;
  dateEnd: string | null;
  description: string;
  ticketNumber: string | null;
  contractName: string | null;
  resourceName: string | null;
  quantityX100: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
  status: Status;
  edited: boolean;
  invoiceNumber: string | null;
  autoApproved: boolean;
  excludedReason: string | null;
  qbItemId?: string | null;
  qbTaxCodeId?: string | null;
};
type Summary = {
  state: { at: string | null; counts: Partial<Record<Kind, number>>; errors: Partial<Record<Kind, string>>; skipped: number };
  counts: { kind: Kind; status: Status; n: number; cents: number }[];
};
export type Group = {
  client: { id: string; name: string };
  count: number;
  subtotalCents: number;
  gstCents: number;
  qstCents: number;
  totalCents: number;
  exempt: boolean;
  termsDays: number;
  kinds: Kind[];
};

type Folder = "work" | "staff";
const FOLDERS: { key: Folder; icon: LucideIcon; tabs: (Kind | "timesheets")[] }[] = [
  { key: "work", icon: Hammer, tabs: ["labour", "charge", "contract", "milestone", "project"] },
  { key: "staff", icon: Wallet, tabs: ["expense", "timesheets"] },
];
export const TAB_ICON: Record<Kind | "timesheets", LucideIcon> = {
  labour: Hammer,
  charge: Package,
  expense: Wallet,
  contract: FileText,
  milestone: Flag,
  project: FolderKanban,
  timesheets: Clock,
};
const STATUSES: Status[] = ["pending", "approved", "posted", "excluded"];
const STATUS_STYLE: Record<Status, string> = {
  pending: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  posted: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
  excluded: "border-slate-500/40 bg-slate-500/10 text-slate-400",
};
export const KEY = ["billables"];

/**
 * Accounting › Approbation, in two folders: the work to bill (labour, charges,
 * recurring contracts, milestones, projects) approved by hand or by rules; the
 * technicians' expenses and timesheets. Everything within the time frame
 * chosen on top (this month by default). Invoices are made in Factures ›
 * Éléments à facturer.
 */
export function ApprovalsPage() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { period, set: setPeriod, query: pq } = usePeriod();
  // invoices moved to Factures › Éléments à facturer (old links follow)
  const legacyInvoice = params.get("folder") === "invoice";
  useEffect(() => {
    if (legacyInvoice) navigate("/accounting/invoices", { replace: true });
  }, [legacyInvoice, navigate]);
  const folder = (FOLDERS.find((f) => f.key === params.get("folder"))?.key ?? "work") as Folder;
  const tabs = FOLDERS.find((f) => f.key === folder)!.tabs;
  const tab = (tabs.includes(params.get("tab") as Kind) ? params.get("tab") : tabs[0]) as Kind | "timesheets";
  const go = (f: Folder, tb?: string) =>
    setParams(
      (p) => {
        p.set("folder", f);
        if (tb) p.set("tab", tb);
        else p.delete("tab");
        return p;
      },
      { replace: true },
    );
  const { data: summary } = useQuery({
    queryKey: [...KEY, "summary", pq],
    queryFn: () => api.get<Summary>(`/billables/summary?${pq}`),
    refetchInterval: 60_000,
  });
  const count = (kind: Kind, status: Status) => summary?.counts.find((c) => c.kind === kind && c.status === status)?.n ?? 0;
  const pendingIn = (f: Folder) => FOLDERS.find((x) => x.key === f)!.tabs.reduce((x, k) => x + (k === "timesheets" ? 0 : count(k, "pending")), 0);
  const importNow = useMutation({
    mutationFn: () => api.post<Summary["state"]>("/billables/import"),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: KEY });
      const errors = Object.keys(s.errors);
      if (errors.length) toast.warning(t("approvals.importPartial", { kinds: errors.map((k) => t(`approvals.tabs.${k}`)).join(", ") }));
      else toast.success(t("approvals.imported"));
    },
    onError: () => toast.error(t("approvals.importFailed")),
  });
  const errors = Object.entries(summary?.state.errors ?? {});
  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ClipboardCheck className="size-6 text-primary" /> {t("approvals.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("approvals.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {summary?.state.at ? t("approvals.lastImport", { when: relativeTime(summary.state.at) }) : t("approvals.neverImported")}
          </span>
          {can("accounting.manage") && (
            <Button variant="outline" disabled={importNow.isPending} onClick={() => importNow.mutate()}>
              {importNow.isPending ? <Loader2 className="size-4 animate-spin" /> : <DownloadCloud className="size-4" />} {t("approvals.import")}
            </Button>
          )}
        </div>
      </div>
      {errors.length > 0 && (
        <div className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          {errors.map(([k, e]) => (
            <p key={k} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {t("approvals.kindError", { kind: t(`approvals.tabs.${k}`), error: e })}
            </p>
          ))}
        </div>
      )}

      {/* the time frame: only the work of these days */}
      <PeriodBar period={period} onChange={setPeriod} />

      {/* folders */}
      <div>
        <div className="flex flex-wrap items-end gap-1 px-2" role="tablist">
          {FOLDERS.map((f) => {
            const active = f.key === folder;
            const n = pendingIn(f.key);
            return (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => go(f.key)}
                className={cn(
                  "relative -mb-px flex items-center gap-2 rounded-t-xl border border-b-0 px-4 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "z-10 border-[color:var(--gold)]/40 bg-card text-foreground"
                    : "border-transparent bg-background/40 text-muted-foreground hover:bg-card/60 hover:text-foreground",
                )}
              >
                {active && <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-grad-gold" />}
                <f.icon className={cn("size-4", active && "text-primary")} /> {t(`approvals.folders.${f.key}`)}
                {n > 0 && <span className="rounded-full bg-sky-500/20 px-1.5 font-mono text-[10px] text-sky-300">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="rounded-2xl rounded-tl-none border border-[color:var(--gold)]/30 bg-card/60 p-4">
          {
            <Tabs value={tab} onValueChange={(v) => go(folder, v)}>
              <TabsList className="h-auto flex-wrap justify-start">
                {tabs.map((k) => {
                  const Icon = TAB_ICON[k];
                  const soon = k === "project" || k === "timesheets";
                  return (
                    <TabsTrigger key={k} value={k} className={soon ? "opacity-70" : undefined}>
                      <Icon className="size-4" /> {t(`approvals.tabs.${k}`)}
                      {!soon && count(k as Kind, "pending") > 0 && (
                        <span className="rounded-full bg-sky-500/20 px-1.5 font-mono text-[10px] text-sky-300">{count(k as Kind, "pending")}</span>
                      )}
                      {soon && <span className="rounded-full border border-dashed px-1.5 text-[9px] text-muted-foreground">{t("common.comingSoon")}</span>}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
              {tabs.map((k) => (
                <TabsContent key={k} value={k} className="mt-4">
                  {k === "project" ? (
                    <Placeholder kind={k} />
                  ) : k === "timesheets" ? (
                    <TimesheetApprovals lang={i18n.language} pq={pq} />
                  ) : k === "expense" ? (
                    <div className="space-y-6">
                      <ExpenseApprovals lang={i18n.language} pq={pq} />
                      <section className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("approvals.fromAutotask")}</p>
                        <KindTab kind="expense" counts={(s) => count("expense", s)} lang={i18n.language} pq={pq} />
                      </section>
                    </div>
                  ) : (
                    <KindTab kind={k} counts={(s) => count(k, s)} lang={i18n.language} pq={pq} />
                  )}
                </TabsContent>
              ))}
            </Tabs>
          }
        </div>
      </div>
    </div>
  );
}

function Placeholder({ kind }: { kind: "timesheets" | "project" }) {
  const { t } = useTranslation();
  const Icon = TAB_ICON[kind];
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-14 text-center">
      <Icon className="size-8 text-primary" />
      <p className="font-semibold">{t(`approvals.empty.${kind}.title`)}</p>
      <p className="max-w-lg text-sm text-muted-foreground">{t(`approvals.empty.${kind}.text`)}</p>
      <span className="rounded-full border border-dashed px-2.5 py-0.5 text-[11px] text-muted-foreground">{t("common.comingSoon")}</span>
    </div>
  );
}

// ── Expenses and timesheets of the team (timesheets.approve) ──
type TeamExpense = {
  id: string;
  userName: string;
  date: string;
  type: string;
  unit: string | null;
  /** A trip (km): shown as the distance paid, never in money */
  mileage?: boolean;
  fromPlace?: string | null;
  toPlace?: string | null;
  description: string;
  quantityX100: number;
  amountCents: number;
  clientName: string | null;
  billable: boolean;
  hasReceipt: boolean;
  status: string;
  paidAt: string | null;
  quickbooksId: string | null;
  quickbooksError: string | null;
  /** The report it was sent in */
  reportTitle: string | null;
};
type TeamWeek = {
  id: string;
  userName: string;
  weekStart: string;
  weekEnd: string;
  status: string;
  submittedAt: string | null;
  comment: string | null;
  paidAt: string | null;
  types: { type: string; kind: string; hours: number }[];
  labourHours: number;
  totalHours: number;
  quickbooks: { syncedAt: string | null; error: string | null } | null;
};
type Decision = "submitted" | "approved" | "rejected" | "paid";

function DecisionFilter({ value, onChange }: { value: Decision; onChange: (v: Decision) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1">
      {(["submitted", "approved", "paid", "rejected"] as Decision[]).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={value === s}
          onClick={() => onChange(s)}
          className={cn(
            "h-8 rounded-lg border px-2.5 text-xs",
            value === s ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-medium" : "text-muted-foreground hover:bg-accent/50",
          )}
        >
          {t(`approvals.team.${s}`)}
        </button>
      ))}
    </div>
  );
}

function QbMark({ id, error }: { id?: string | null; error?: string | null }) {
  const { t } = useTranslation();
  if (id) return <span className="rounded border border-emerald-500/30 px-1 text-[10px] text-emerald-300">QuickBooks</span>;
  if (error)
    return (
      <span className="rounded border border-red-500/30 px-1 text-[10px] text-red-300" title={error}>
        {t("approvals.team.qbError")}
      </span>
    );
  return null;
}

const GOLD_BTN = "bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105";

/** Paid by accounting, on that day */
function PaidMark({ at }: { at: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 rounded border border-[color:var(--gold)]/40 px-1.5 text-[11px] text-primary">
      <BadgeDollarSign className="size-3" /> {t("approvals.team.paidOn", { date: shortDate(at) })}
    </span>
  );
}

function ExpenseApprovals({ lang, pq }: { lang: string; pq: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState<Decision>("submitted");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const approver = can("timesheets.approve");
  const accounting = can("accounting.manage");
  const allowed = approver || accounting;
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["time", "approvals", "expenses", status, pq],
    queryFn: () => api.get<TeamExpense[]>(`/time/approvals/expenses?status=${status}&${pq}`),
    enabled: allowed,
  });
  // approved → paid (accounting), or back to approved
  const pay = useMutation({
    mutationFn: (paid: boolean) => api.post<{ changed: number }>("/time/approvals/expenses/paid", { ids: [...sel], paid }),
    onSuccess: (r, paid) => {
      setSel(new Set());
      void qc.invalidateQueries({ queryKey: ["time"] });
      toast.success(t(paid ? "approvals.team.expenses_paid" : "approvals.team.expenses_unpaid", { count: r.changed }));
    },
    onError: () => toast.error(t("common.error")),
  });
  const selectable = (status === "submitted" && approver) || ((status === "approved" || status === "paid") && accounting);
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") => api.post<{ changed: number }>("/time/approvals/expenses", { ids: [...sel], decision }),
    onSuccess: (r, decision) => {
      setSel(new Set());
      void qc.invalidateQueries({ queryKey: ["time"] });
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t(`approvals.team.expenses_${decision}`, { count: r.changed }));
    },
  });
  if (!allowed) return <p className="text-sm text-muted-foreground">{t("approvals.team.noRight")}</p>;
  const m = (c: number) => money(c, lang);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm font-semibold">{t("approvals.team.expensesTitle")}</p>
        <DecisionFilter
          value={status}
          onChange={(v) => {
            setStatus(v);
            setSel(new Set());
          }}
        />
      </div>
      {selectable && sel.size > 0 && status !== "submitted" && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[color:var(--gold)]/40 p-2">
          <span className="px-1 text-xs">{t("approvals.selected", { count: sel.size })}</span>
          {status === "approved" ? (
            <Button size="sm" disabled={pay.isPending} onClick={() => pay.mutate(true)} className={GOLD_BTN}>
              <BadgeDollarSign className="size-3.5" /> {t("approvals.team.markPaid")}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={pay.isPending} onClick={() => pay.mutate(false)}>
              <Undo2 className="size-3.5" /> {t("approvals.team.markUnpaid")}
            </Button>
          )}
        </div>
      )}
      {status === "submitted" && approver && sel.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[color:var(--gold)]/40 p-2">
          <span className="px-1 text-xs">{t("approvals.selected", { count: sel.size })}</span>
          <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate("approve")} className="bg-emerald-600 text-white hover:bg-emerald-500">
            <Check className="size-3.5" /> {t("approvals.approve")}
          </Button>
          <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate("reject")}>
            <Ban className="size-3.5" /> {t("approvals.team.reject")}
          </Button>
        </div>
      )}
      {isLoading && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}
      {!isLoading && !rows.length && (
        <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">{t("approvals.team.noExpenses")}</p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
          {rows.map((x) => (
            <li
              key={x.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-sm md:grid-cols-[auto_140px_minmax(0,1fr)_110px_auto]"
            >
              {selectable ? (
                <Checkbox
                  checked={sel.has(x.id)}
                  onCheckedChange={(v) => setSel((s) => (v ? new Set([...s, x.id]) : new Set([...s].filter((y) => y !== x.id))))}
                />
              ) : (
                <span />
              )}
              <span className="hidden min-w-0 md:block">
                <span className="block truncate font-medium">{x.userName}</span>
                <span className="block text-[11px] text-muted-foreground">{shortDate(x.date)}</span>
                {x.reportTitle && <span className="block truncate text-[11px] text-primary/80">{x.reportTitle}</span>}
              </span>
              <span className="min-w-0">
                <span className="block truncate">
                  {x.type} — {x.description}
                </span>
                <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  {x.unit && (
                    <span>
                      {(x.quantityX100 / 100).toLocaleString()} {x.unit}
                    </span>
                  )}
                  {x.clientName && <span>{x.billable ? t("expense.billedTo", { name: x.clientName }) : x.clientName}</span>}
                  {x.hasReceipt && (
                    <a href={`/api/time/expenses/${x.id}/receipt`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {t("expense.receipt")}
                    </a>
                  )}
                  <QbMark id={x.quickbooksId} error={x.quickbooksError} />
                  {x.paidAt && <PaidMark at={x.paidAt} />}
                </span>
              </span>
              <span className="text-right font-mono">{x.mileage ? t("expense.km", { km: x.quantityX100 / 100 }) : m(x.amountCents)}</span>
              <span />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Weeks to approve: the hours per type only — no tickets, no notes. */
function TimesheetApprovals({ lang, pq }: { lang: string; pq: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState<Decision>("submitted");
  const approver = can("timesheets.approve");
  const accounting = can("accounting.manage");
  const allowed = approver || accounting;
  const pay = useMutation({
    mutationFn: (p: { id: string; paid: boolean }) => api.post<{ changed: number }>("/time/approvals/timesheets/paid", { ids: [p.id], paid: p.paid }),
    onSuccess: (_r, p) => {
      void qc.invalidateQueries({ queryKey: ["time"] });
      toast.success(t(p.paid ? "approvals.team.week_paid" : "approvals.team.week_unpaid"));
    },
    onError: () => toast.error(t("common.error")),
  });
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["time", "approvals", "weeks", status, pq],
    queryFn: () => api.get<TeamWeek[]>(`/time/approvals/timesheets?status=${status}&${pq}`),
    enabled: allowed,
  });
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const decide = useMutation({
    mutationFn: (p: { id: string; decision: "approve" | "reject"; comment?: string }) =>
      api.post(`/time/approvals/timesheets/${p.id}`, { decision: p.decision, comment: p.comment }),
    onSuccess: (_r, p) => {
      setRejecting(null);
      setComment("");
      void qc.invalidateQueries({ queryKey: ["time"] });
      toast.success(t(`approvals.team.week_${p.decision}`));
    },
  });
  if (!allowed) return <p className="text-sm text-muted-foreground">{t("approvals.team.noRight")}</p>;
  const loc = lang === "en" ? "en-CA" : "fr-CA";
  const h = (n: number) => `${n.toLocaleString(loc, { maximumFractionDigits: 2 })} h`;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-muted-foreground">{t("approvals.team.weeksHint")}</p>
        <DecisionFilter value={status} onChange={setStatus} />
      </div>
      {isLoading && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}
      {!isLoading && !rows.length && (
        <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">{t("approvals.team.noWeeks")}</p>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((w) => (
          <article key={w.id} className="space-y-3 rounded-2xl border bg-background/30 p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{w.userName}</p>
                <p className="text-xs text-muted-foreground">
                  {shortDate(w.weekStart)} → {shortDate(w.weekEnd)}
                </p>
              </div>
              <QbMark id={w.quickbooks?.syncedAt ? "ok" : null} error={w.quickbooks?.error} />
            </div>
            <ul className="space-y-1 text-sm">
              <li className="flex justify-between font-medium">
                <span className="flex items-center gap-1.5">
                  <Hammer className="size-3.5 text-primary" /> {t("approvals.team.labour")}
                </span>
                <span className="font-mono">{h(w.labourHours)}</span>
              </li>
              {w.types
                .filter((x) => x.kind !== "labour")
                .map((x) => (
                  <li key={x.type} className="flex justify-between text-muted-foreground">
                    <span>{x.type}</span>
                    <span className="font-mono">{h(x.hours)}</span>
                  </li>
                ))}
            </ul>
            <p className="flex justify-between border-t pt-2 text-sm font-semibold">
              <span>{t("timesheet.total")}</span>
              <span className="font-mono">{h(w.totalHours)}</span>
            </p>
            {w.status === "rejected" && w.comment && <p className="text-xs text-red-300">{w.comment}</p>}
            {w.status === "approved" && accounting && (
              <Button size="sm" disabled={pay.isPending} onClick={() => pay.mutate({ id: w.id, paid: true })} className={`w-full ${GOLD_BTN}`}>
                <BadgeDollarSign className="size-3.5" /> {t("approvals.team.markPaid")}
              </Button>
            )}
            {w.status === "paid" && (
              <div className="flex items-center justify-between gap-2">
                {w.paidAt && <PaidMark at={w.paidAt} />}
                {accounting && (
                  <Button size="sm" variant="ghost" disabled={pay.isPending} onClick={() => pay.mutate({ id: w.id, paid: false })}>
                    <Undo2 className="size-3.5" /> {t("approvals.team.markUnpaid")}
                  </Button>
                )}
              </div>
            )}
            {w.status === "submitted" &&
              approver &&
              (rejecting === w.id ? (
                <div className="space-y-2">
                  <Input autoFocus placeholder={t("approvals.team.why")} value={comment} onChange={(e) => setComment(e.target.value)} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ id: w.id, decision: "reject", comment })}>
                      {t("approvals.team.sendBack")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: w.id, decision: "approve" })}
                    className="flex-1 bg-emerald-600 text-white hover:bg-emerald-500"
                  >
                    <Check className="size-3.5" /> {t("approvals.approve")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRejecting(w.id)}>
                    <Undo2 className="size-3.5" /> {t("approvals.team.sendBack")}
                  </Button>
                </div>
              ))}
          </article>
        ))}
      </div>
    </section>
  );
}

function KindTab({ kind, counts, lang, pq }: { kind: Kind; counts: (s: Status) => number; lang: string; pq: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>("pending");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const toggle = (ids: string[], close: boolean) =>
    setCollapsed((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (close) next.add(id);
        else next.delete(id);
      }
      saveCollapsed(next);
      return next;
    });
  const { data: items = [], isLoading } = useQuery({
    queryKey: [...KEY, kind, status, pq],
    queryFn: () => api.get<Item[]>(`/billables?kind=${kind}&status=${status}&${pq}`),
  });
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; items: Item[] }>();
    for (const i of items) m.set(i.clientId, { name: i.clientName, items: [...(m.get(i.clientId)?.items ?? []), i] });
    return [...m.entries()];
  }, [items]);
  const manage = can("accounting.manage") && status !== "posted";
  const setMany = (ids: string[], on: boolean) => setSel((s) => (on ? new Set([...s, ...ids]) : new Set([...s].filter((x) => !ids.includes(x)))));
  const move = useMutation({
    mutationFn: (to: "pending" | "approved" | "excluded" | "billed") =>
      api.post<{ changed: number }>("/billables/status", to === "billed" ? { ids: [...sel], status: "excluded", reason: "billed" } : { ids: [...sel], status: to }),
    onSuccess: (r, to) => {
      setSel(new Set());
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t(`approvals.moved.${to}`, { count: r.changed }));
    },
  });
  const edit = useMutation({
    mutationFn: (p: { id: string; patch: { description?: string; quantity?: number; unitPriceCents?: number } }) => api.patch(`/billables/${p.id}`, p.patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t("approvals.saved"));
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.error(t("common.error"));
    },
  });
  const m = (c: number) => money(c, lang);
  const total = items.reduce((x, i) => x + i.amountCents, 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => {
              setStatus(s);
              setSel(new Set());
            }}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
              status === s
                ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {t(`approvals.status.${s}`)} <span className="font-mono text-[10px] text-muted-foreground">{counts(s)}</span>
          </button>
        ))}
        {groups.length > 1 && (
          <span className="ml-2 flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() =>
                toggle(
                  groups.map(([id]) => id),
                  true,
                )
              }
            >
              <ChevronsDownUp className="size-3.5" /> {t("approvals.collapseAll")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() =>
                toggle(
                  groups.map(([id]) => id),
                  false,
                )
              }
            >
              <ChevronsUpDown className="size-3.5" /> {t("approvals.expandAll")}
            </Button>
          </span>
        )}
        {manage && items.length > 0 && (
          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setSel(sel.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}>
            <Check className="size-3.5" /> {sel.size === items.length ? t("approvals.selectNone") : t("approvals.selectAll", { count: items.length })}
          </Button>
        )}
        <span className="ml-auto font-mono text-sm">{m(total)}</span>
      </div>

      {manage && sel.size > 0 && (
        <div className="sticky top-16 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-[color:var(--gold)]/40 bg-background/90 p-2 backdrop-blur">
          <span className="px-1 text-xs">{t("approvals.selected", { count: sel.size })}</span>
          {status !== "approved" && (
            <Button size="sm" disabled={move.isPending} onClick={() => move.mutate("approved")} className="bg-emerald-600 text-white hover:bg-emerald-500">
              <Check className="size-3.5" /> {t("approvals.approve")}
            </Button>
          )}
          {status !== "pending" && (
            <Button size="sm" variant="outline" disabled={move.isPending} onClick={() => move.mutate("pending")}>
              <Undo2 className="size-3.5" /> {t("approvals.backToPending")}
            </Button>
          )}
          {status !== "excluded" && (
            <Button size="sm" variant="outline" disabled={move.isPending} onClick={() => move.mutate("excluded")}>
              <Ban className="size-3.5" /> {t("approvals.exclude")}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={move.isPending} onClick={() => move.mutate("billed")} title={t("approvals.alreadyBilledHint")}>
            <Ban className="size-3.5" /> {t("approvals.alreadyBilled")}
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSel(new Set())}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {isLoading && <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />}
      {!isLoading && items.length === 0 && (
        <p className="glass rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">{t(`approvals.none.${status}`)}</p>
      )}
      {groups.map(([clientId, g]) => {
        const ids = g.items.map((i) => i.id);
        const sub = g.items.reduce((x, i) => x + i.amountCents, 0);
        const closed = collapsed.has(clientId);
        return (
          <section key={clientId} className="glass overflow-hidden rounded-2xl border">
            <div className={cn("flex items-center gap-3 bg-background/30 px-3 py-2", !closed && "border-b")}>
              {manage && (
                <Checkbox
                  checked={ids.every((x) => sel.has(x)) ? true : ids.some((x) => sel.has(x)) ? "indeterminate" : false}
                  onCheckedChange={(v) => setMany(ids, Boolean(v))}
                  aria-label={t("approvals.selectClient", { name: g.name })}
                />
              )}
              <button
                type="button"
                onClick={() => toggle([clientId], !closed)}
                aria-expanded={!closed}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title={t(closed ? "approvals.expand" : "approvals.collapse")}
              >
                <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !closed && "rotate-90")} />
                <span className="truncate text-sm font-semibold">{g.name}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t("approvals.items", { count: g.items.length })}</span>
              </button>
              <span className="font-mono text-sm">{m(sub)}</span>
            </div>
            {!closed && (
              <ul className="divide-y divide-border/60">
                {g.items.map((i) => (
                  <li
                    key={i.id}
                    className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2 text-sm md:grid-cols-[auto_90px_minmax(0,1fr)_80px_100px_110px_auto]"
                  >
                    {manage ? <Checkbox className="mt-1" checked={sel.has(i.id)} onCheckedChange={(v) => setMany([i.id], Boolean(v))} /> : <span />}
                    <span className="hidden pt-1 text-xs text-muted-foreground md:block">
                      {shortDate(i.date)}
                      {i.dateEnd && <span className="block">→ {shortDate(i.dateEnd)}</span>}
                    </span>
                    <span className="min-w-0">
                      {manage ? (
                        <InlineText
                          value={i.description}
                          label={t("approvals.description")}
                          onSave={(description) => edit.mutate({ id: i.id, patch: { description } })}
                        />
                      ) : (
                        <span className="block break-words">{i.description}</span>
                      )}
                      <span className="block px-1 text-[11px] text-muted-foreground">
                        {[
                          i.ticketNumber && `${t("approvals.ticket")} ${i.ticketNumber}`,
                          i.contractName,
                          i.resourceName,
                          i.edited && t("approvals.edited"),
                          i.invoiceNumber && t("approvals.onInvoice", { number: i.invoiceNumber }),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span className="hidden text-right font-mono text-xs md:block">
                      {manage ? (
                        <InlineNumber
                          value={i.quantityX100 / 100}
                          lang={lang}
                          label={t(i.kind === "labour" ? "approvals.hours" : "approvals.quantity")}
                          onSave={(quantity) => edit.mutate({ id: i.id, patch: { quantity } })}
                        />
                      ) : (
                        (i.quantityX100 / 100).toLocaleString(lang === "en" ? "en-CA" : "fr-CA")
                      )}
                    </span>
                    <span className="hidden text-right font-mono text-xs text-muted-foreground md:block">
                      {manage ? (
                        <InlineNumber
                          value={i.unitPriceCents / 100}
                          lang={lang}
                          money
                          label={t("approvals.rate")}
                          onSave={(rate) => edit.mutate({ id: i.id, patch: { unitPriceCents: Math.round(rate * 100) } })}
                        />
                      ) : (
                        m(i.unitPriceCents)
                      )}
                    </span>
                    <span className="pt-1 text-right font-mono">{m(i.amountCents)}</span>
                    <span className="flex items-center justify-end gap-1 pt-0.5">
                      {i.autoApproved && i.status === "approved" && (
                        <span
                          className="flex items-center gap-0.5 rounded-md border border-violet-500/40 bg-violet-500/10 px-1 py-0.5 text-[10px] text-violet-300"
                          title={t("approvals.autoHint")}
                        >
                          <Sparkles className="size-2.5" /> {t("approvals.auto")}
                        </span>
                      )}
                      <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px]", STATUS_STYLE[i.status])}>
                        {i.status === "excluded" && i.excludedReason === "billed" ? t("approvals.alreadyBilledTag") : i.status === "excluded" && i.excludedReason === "aside" ? t("approvals.asideTag") : t(`approvals.status.${i.status}`)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

const COLLAPSED_KEY = "akab.approvals.collapsed";
function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function saveCollapsed(s: Set<string>) {
  try {
    sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s]));
  } catch {
    /* private window: for this page only */
  }
}

/** Text that is edited where it is: a click, then Enter or leaving the field saves; Escape cancels. */
function InlineText({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    const next = v.trim();
    if (!next) return setV(value);
    if (next !== value) onSave(next);
  };
  return (
    <textarea
      value={v}
      rows={1}
      aria-label={label}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === "Escape") {
          setV(value);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      className="field-sizing-content block w-full resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 break-words outline-none hover:border-border focus:border-[color:var(--gold)]/60 focus:bg-background/60"
    />
  );
}

/** A number edited where it is (hours, quantity, rate). */
function InlineNumber({
  value,
  lang,
  label,
  money: asMoney,
  onSave,
}: {
  value: number;
  lang: string;
  label: string;
  money?: boolean;
  onSave: (v: number) => void;
}) {
  const loc = lang === "en" ? "en-CA" : "fr-CA";
  const show = (n: number) =>
    asMoney ? n.toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n.toLocaleString(loc, { maximumFractionDigits: 2 });
  const [v, setV] = useState(show(value));
  useEffect(() => setV(show(value)), [value]);
  const commit = () => {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return setV(show(value));
    if (Math.round(n * 100) !== Math.round(value * 100)) onSave(n);
    else setV(show(value));
  };
  return (
    <input
      value={v}
      inputMode="decimal"
      aria-label={label}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(show(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-right font-mono outline-none hover:border-border focus:border-[color:var(--gold)]/60 focus:bg-background/60"
    />
  );
}
