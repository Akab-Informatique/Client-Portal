import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
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
  Pencil,
  Receipt,
  Send,
  Sparkles,
  Undo2,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";

type Kind = "labour" | "charge" | "expense" | "contract" | "milestone" | "project";
type Status = "pending" | "approved" | "posted" | "excluded";
type Item = {
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
};
type Summary = {
  state: { at: string | null; counts: Partial<Record<Kind, number>>; errors: Partial<Record<Kind, string>>; skipped: number };
  counts: { kind: Kind; status: Status; n: number; cents: number }[];
};
type Group = {
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

type Folder = "work" | "staff" | "invoice";
const FOLDERS: { key: Folder; icon: LucideIcon; tabs: (Kind | "timesheets")[] }[] = [
  { key: "work", icon: Hammer, tabs: ["labour", "charge", "contract", "milestone", "project"] },
  { key: "staff", icon: Wallet, tabs: ["expense", "timesheets"] },
  { key: "invoice", icon: Receipt, tabs: [] },
];
const TAB_ICON: Record<Kind | "timesheets", LucideIcon> = {
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
const KEY = ["billables"];

/**
 * Accounting › Approve and post, in three folders: the work to bill (labour,
 * charges, recurring contracts, milestones, projects) approved by hand or by
 * rules; the technicians' expenses and timesheets; and the invoices made from
 * what is approved — a client, the kinds or lines, dates, terms, notes.
 */
export function ApprovalsPage() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const folder = (FOLDERS.find((f) => f.key === params.get("folder"))?.key ?? "work") as Folder;
  const tabs = FOLDERS.find((f) => f.key === folder)!.tabs;
  const tab = (tabs.includes(params.get("tab") as Kind) ? params.get("tab") : tabs[0]) as Kind | "timesheets";
  const go = (f: Folder, tb?: string) => setParams({ folder: f, ...(tb ? { tab: tb } : {}) }, { replace: true });
  const { data: summary } = useQuery({ queryKey: [...KEY, "summary"], queryFn: () => api.get<Summary>("/billables/summary"), refetchInterval: 60_000 });
  const count = (kind: Kind, status: Status) => summary?.counts.find((c) => c.kind === kind && c.status === status)?.n ?? 0;
  const pendingIn = (f: Folder) => FOLDERS.find((x) => x.key === f)!.tabs.reduce((x, k) => x + (k === "timesheets" ? 0 : count(k, "pending")), 0);
  const approved = summary?.counts.filter((c) => c.status === "approved").reduce((x, c) => x + c.n, 0) ?? 0;
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

      {/* folders */}
      <div>
        <div className="flex flex-wrap items-end gap-1 px-2" role="tablist">
          {FOLDERS.map((f) => {
            const active = f.key === folder;
            const n = f.key === "invoice" ? approved : pendingIn(f.key);
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
                {n > 0 && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 font-mono text-[10px]",
                      f.key === "invoice" ? "bg-emerald-500/20 text-emerald-300" : "bg-sky-500/20 text-sky-300",
                    )}
                  >
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="rounded-2xl rounded-tl-none border border-[color:var(--gold)]/30 bg-card/60 p-4">
          {folder === "invoice" ? (
            <InvoiceFolder lang={i18n.language} />
          ) : (
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
                    <TimesheetApprovals lang={i18n.language} />
                  ) : k === "expense" ? (
                    <div className="space-y-6">
                      <ExpenseApprovals lang={i18n.language} />
                      <section className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("approvals.fromAutotask")}</p>
                        <KindTab kind="expense" counts={(s) => count("expense", s)} lang={i18n.language} />
                      </section>
                    </div>
                  ) : (
                    <KindTab kind={k} counts={(s) => count(k, s)} lang={i18n.language} />
                  )}
                </TabsContent>
              ))}
            </Tabs>
          )}
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

function ExpenseApprovals({ lang }: { lang: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState<Decision>("submitted");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const approver = can("timesheets.approve");
  const accounting = can("accounting.manage");
  const allowed = approver || accounting;
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["time", "approvals", "expenses", status],
    queryFn: () => api.get<TeamExpense[]>(`/time/approvals/expenses?status=${status}`),
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
              <span className="text-right font-mono">{m(x.amountCents)}</span>
              <span />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Weeks to approve: the hours per type only — no tickets, no notes. */
function TimesheetApprovals({ lang }: { lang: string }) {
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
    queryKey: ["time", "approvals", "weeks", status],
    queryFn: () => api.get<TeamWeek[]>(`/time/approvals/timesheets?status=${status}`),
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

// ── Créer des factures ──
type Ready = { client: { id: string; name: string }; kinds: { kind: Kind; count: number; cents: number }[]; cents: number };
type Draft = {
  client: { id: string; name: string; address: string | null; city: string | null; province: string | null; postalCode: string | null; email: string | null };
  number: string;
  issuedOn: string;
  dueOn: string;
  termsDays: number | null;
  poNumber: string | null;
  notes: string | null;
  poRequired: boolean;
  exempt: boolean;
  lines: { itemId: string; kind: Kind; description: string; quantity: number; unitPriceCents: number; amountCents: number; taxable: boolean }[];
  subtotalCents: number;
  gstCents: number;
  qstCents: number;
  totalCents: number;
  company: { legalName: string; address: string; phone: string; email: string; website: string };
  taxes: { gstNumber: string; qstNumber: string; gstRate: number; qstRate: number };
  template: { language: "fr" | "en"; footer: string; paymentInstructions: string; showPaymentLink: boolean };
};
const INVOICE_KINDS: Kind[] = ["labour", "charge", "contract", "milestone", "expense", "project"];

function InvoiceFolder({ lang }: { lang: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const { data: ready = [], isLoading } = useQuery({ queryKey: [...KEY, "ready"], queryFn: () => api.get<Ready[]>("/billables/clients") });
  const [clientId, setClientId] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const current = ready.find((r) => r.client.id === clientId) ?? ready[0] ?? null;
  const m = (c: number) => money(c, lang);
  if (isLoading) return <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />;
  if (!ready.length) return <p className="py-12 text-center text-sm text-muted-foreground">{t("approvals.invoice.none")}</p>;
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="space-y-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("approvals.invoice.clients", { count: ready.length })}</p>
          {can("accounting.manage") && (
            <button type="button" onClick={() => setBulk(true)} className="text-[11px] text-primary hover:underline">
              {t("approvals.invoice.all")}
            </button>
          )}
        </div>
        <ul className="space-y-1">
          {ready.map((r) => (
            <li key={r.client.id}>
              <button
                type="button"
                onClick={() => setClientId(r.client.id)}
                className={cn(
                  "w-full rounded-xl border px-3 py-2 text-left transition-colors",
                  current?.client.id === r.client.id ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10" : "hover:bg-accent/40",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{r.client.name}</span>
                  <span className="font-mono text-xs">{m(r.cents)}</span>
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {r.kinds.map((k) => `${t(`approvals.tabs.${k.kind}`)} (${k.count})`).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      {current && <InvoiceEditor key={current.client.id} ready={current} lang={lang} />}
      {bulk && <PostDialog onClose={() => setBulk(false)} />}
    </div>
  );
}

function InvoiceEditor({ ready, lang }: { ready: Ready; lang: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const m = (c: number) => money(c, lang);
  const today = new Date().toLocaleDateString("en-CA");
  const { data: items = [] } = useQuery({
    queryKey: [...KEY, "approved", ready.client.id],
    queryFn: () => api.get<Item[]>(`/billables?status=approved&clientId=${ready.client.id}`),
  });
  const [kinds, setKinds] = useState<Set<Kind>>(new Set(ready.kinds.map((k) => k.kind)));
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Kind | null>(null);
  const [f, setF] = useState({ issuedOn: today, due: "terms" as "terms" | "date", termsDays: "", dueOn: "", poNumber: "", notes: "" });
  const itemIds = items.filter((i) => kinds.has(i.kind) && !left.has(i.id)).map((i) => i.id);
  const draft = {
    clientId: ready.client.id,
    itemIds,
    issuedOn: f.issuedOn,
    ...(f.due === "date" && f.dueOn ? { dueOn: f.dueOn } : {}),
    ...(f.due === "terms" && f.termsDays !== "" ? { termsDays: Number(f.termsDays) } : {}),
    poNumber: f.poNumber || null,
    notes: f.notes || null,
  };
  const { data: pv, isFetching } = useQuery({
    queryKey: [...KEY, "preview", draft],
    queryFn: () => api.post<Draft>("/billables/invoice/preview", draft),
    enabled: itemIds.length > 0,
    placeholderData: (p) => p,
  });
  const create = useMutation({
    mutationFn: () => api.post<{ number: string }>("/billables/invoice", draft),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      toast.success(t("approvals.invoice.created", { number: r.number }));
    },
    onError: () => toast.error(t("common.error")),
  });
  const toggleKind = (k: Kind, on: boolean) => setKinds((s) => (on ? new Set([...s, k]) : new Set([...s].filter((x) => x !== k))));
  const byKind = (k: Kind) => items.filter((i) => i.kind === k);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="space-y-4">
        <section className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("approvals.invoice.what")}</p>
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
            {INVOICE_KINDS.map((k) => {
              const list = byKind(k);
              const Icon = TAB_ICON[k];
              const chosen = list.filter((i) => !left.has(i.id));
              return (
                <li key={k}>
                  <div className={cn("flex items-center gap-3 px-3 py-2 text-sm", !list.length && "opacity-50")}>
                    <Checkbox disabled={!list.length} checked={list.length > 0 && kinds.has(k)} onCheckedChange={(v) => toggleKind(k, Boolean(v))} />
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="flex-1">{t(`approvals.tabs.${k}`)}</span>
                    <span className="text-xs text-muted-foreground">
                      {list.length ? t("approvals.items", { count: list.length }) : k === "project" ? t("common.comingSoon") : t("approvals.invoice.nothing")}
                    </span>
                    <span className="w-24 text-right font-mono text-xs">{list.length ? m(chosen.reduce((x, i) => x + i.amountCents, 0)) : ""}</span>
                    {list.length > 0 && (
                      <button type="button" onClick={() => setOpen(open === k ? null : k)} className="text-[11px] text-primary hover:underline">
                        {open === k ? t("approvals.invoice.hide") : t("approvals.invoice.lines")}
                      </button>
                    )}
                  </div>
                  {open === k && (
                    <ul className="space-y-0.5 border-t border-dashed bg-background/30 px-3 py-2">
                      {list.map((i) => (
                        <li key={i.id}>
                          <label className="flex cursor-pointer items-start gap-2 text-xs">
                            <Checkbox
                              className="mt-0.5"
                              disabled={!kinds.has(k)}
                              checked={kinds.has(k) && !left.has(i.id)}
                              onCheckedChange={(v) => setLeft((s) => (v ? new Set([...s].filter((x) => x !== i.id)) : new Set([...s, i.id])))}
                            />
                            <span className="min-w-0 flex-1">
                              {i.description}
                              <span className="block text-[10px] text-muted-foreground">
                                {[shortDate(i.date), i.ticketNumber, i.resourceName].filter(Boolean).join(" · ")}
                              </span>
                            </span>
                            <span className="font-mono">{m(i.amountCents)}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs">
            <span className="text-muted-foreground">{t("approvals.invoice.issuedOn")}</span>
            <Input type="date" value={f.issuedOn} onChange={(e) => setF({ ...f, issuedOn: e.target.value })} />
          </label>
          <div className="space-y-1.5 text-xs">
            <span className="flex gap-3 text-muted-foreground">
              {(["terms", "date"] as const).map((x) => (
                <label key={x} className="flex cursor-pointer items-center gap-1">
                  <input type="radio" name="due" checked={f.due === x} onChange={() => setF({ ...f, due: x })} className="accent-[color:var(--gold)]" />{" "}
                  {t(`approvals.invoice.due_${x}`)}
                </label>
              ))}
            </span>
            {f.due === "terms" ? (
              <Input
                type="number"
                min={0}
                placeholder={pv?.termsDays != null ? String(pv.termsDays) : ""}
                value={f.termsDays}
                onChange={(e) => setF({ ...f, termsDays: e.target.value })}
              />
            ) : (
              <Input type="date" value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} />
            )}
          </div>
          <label className="space-y-1.5 text-xs">
            <span className="text-muted-foreground">
              {t("approvals.invoice.po")}
              {pv?.poRequired && <span className="ml-1 text-amber-300">· {t("approvals.invoice.poRequired")}</span>}
            </span>
            <Input value={f.poNumber} maxLength={60} onChange={(e) => setF({ ...f, poNumber: e.target.value })} />
          </label>
          <label className="space-y-1.5 text-xs sm:col-span-2">
            <span className="text-muted-foreground">{t("approvals.invoice.notes")}</span>
            <Textarea rows={3} value={f.notes} maxLength={2000} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </label>
        </section>
        {can("accounting.manage") && (
          <Button
            disabled={!itemIds.length || create.isPending || (pv?.poRequired && !f.poNumber)}
            onClick={() => create.mutate()}
            className="w-full bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105"
          >
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}{" "}
            {t("approvals.invoice.create", { total: pv ? m(pv.totalCents) : "" })}
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("approvals.invoice.preview")} {isFetching && <Loader2 className="size-3 animate-spin" />}
        </p>
        {!itemIds.length && <p className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">{t("approvals.invoice.pick")}</p>}
        {itemIds.length > 0 && pv && <InvoicePaper d={pv} />}
      </div>
    </div>
  );
}

/** The invoice as the client will see it. */
function InvoicePaper({ d }: { d: Draft }) {
  const { t } = useTranslation();
  const lng = d.template.language;
  const L = (k: string, o?: Record<string, unknown>) => t(`approvals.paper.${k}`, { lng, ...o });
  const mm = (c: number) => money(c, lng);
  const day = (s: string) => new Intl.DateTimeFormat(lng === "en" ? "en-CA" : "fr-CA", { dateStyle: "long" }).format(new Date(`${s}T12:00:00`));
  return (
    <div className="rounded-2xl bg-[#f4f4f1] p-6 text-[12px] text-[#0a0a0b] shadow-xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-base font-bold">{d.company.legalName || "—"}</p>
          <p className="whitespace-pre-line text-[11px] text-black/60">
            {[d.company.address, d.company.phone, d.company.email, d.company.website].filter(Boolean).join("\n")}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold tracking-wide">{L("invoice")}</p>
          <p className="font-mono">{d.number}</p>
          <p className="text-[11px] text-black/60">
            {L("date")} : {day(d.issuedOn)}
          </p>
          <p className="text-[11px] font-semibold">
            {L("due")} : {day(d.dueOn)}
          </p>
          {d.poNumber && <p className="text-[11px] text-black/60">PO : {d.poNumber}</p>}
        </div>
      </div>
      <div className="mt-4">
        <p className="text-[10px] uppercase tracking-wider text-black/50">{L("billTo")}</p>
        <p className="font-semibold">{d.client.name}</p>
        <p className="whitespace-pre-line text-[11px] text-black/60">
          {[d.client.address, [d.client.city, d.client.province, d.client.postalCode].filter(Boolean).join(" "), d.client.email].filter(Boolean).join("\n")}
        </p>
      </div>
      <table className="mt-4 w-full">
        <thead>
          <tr className="border-b border-black/20 text-[10px] uppercase tracking-wider text-black/50">
            <th className="pb-1 text-left font-medium">{L("description")}</th>
            <th className="whitespace-nowrap pb-1 pl-3 text-right font-medium">{L("qty")}</th>
            <th className="whitespace-nowrap pb-1 pl-3 text-right font-medium">{L("rate")}</th>
            <th className="whitespace-nowrap pb-1 pl-3 text-right font-medium">{L("amount")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-black/10">
          {d.lines.map((l) => (
            <tr key={l.itemId}>
              <td className="py-1.5 pr-2">{l.description}</td>
              <td className="whitespace-nowrap py-1.5 pl-3 text-right font-mono">{l.quantity}</td>
              <td className="whitespace-nowrap py-1.5 pl-3 text-right font-mono">{mm(l.unitPriceCents)}</td>
              <td className="whitespace-nowrap py-1.5 pl-3 text-right font-mono">{mm(l.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ml-auto mt-3 w-56 space-y-0.5 text-[12px]">
        <p className="flex justify-between">
          <span>{L("subtotal")}</span>
          <span className="font-mono">{mm(d.subtotalCents)}</span>
        </p>
        {d.exempt ? (
          <p className="text-[11px] text-black/60">{L("exempt")}</p>
        ) : (
          <>
            <p className="flex justify-between text-black/70">
              <span>TPS ({d.taxes.gstRate} %)</span>
              <span className="font-mono">{mm(d.gstCents)}</span>
            </p>
            <p className="flex justify-between text-black/70">
              <span>TVQ ({d.taxes.qstRate} %)</span>
              <span className="font-mono">{mm(d.qstCents)}</span>
            </p>
          </>
        )}
        <p className="flex justify-between border-t border-black/20 pt-1 text-sm font-bold">
          <span>{L("total")}</span>
          <span className="font-mono">{mm(d.totalCents)}</span>
        </p>
      </div>
      {d.notes && <p className="mt-4 whitespace-pre-line rounded-md bg-black/5 p-2 text-[11px]">{d.notes}</p>}
      <p className="mt-3 text-[11px] text-black/60">
        {d.termsDays != null ? (d.termsDays === 0 ? L("onReceipt") : L("terms", { days: d.termsDays })) : L("dueOn", { date: day(d.dueOn) })}
        {(d.taxes.gstNumber || d.taxes.qstNumber) && ` · TPS ${d.taxes.gstNumber || "—"} · TVQ ${d.taxes.qstNumber || "—"}`}
      </p>
      {d.template.paymentInstructions && <p className="mt-2 whitespace-pre-line text-[11px]">{d.template.paymentInstructions}</p>}
      {d.template.showPaymentLink && (
        <p className="mt-3 inline-block rounded-md bg-[#0a0a0b] px-3 py-1.5 text-[11px] font-semibold text-[#ffce1a]">{L("payOnline")}</p>
      )}
      {d.template.footer && <p className="mt-4 border-t border-black/10 pt-2 text-center text-[11px] text-black/60">{d.template.footer}</p>}
    </div>
  );
}

function KindTab({ kind, counts, lang }: { kind: Kind; counts: (s: Status) => number; lang: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>("pending");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const { data: items = [], isLoading } = useQuery({
    queryKey: [...KEY, kind, status],
    queryFn: () => api.get<Item[]>(`/billables?kind=${kind}&status=${status}`),
  });
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; items: Item[] }>();
    for (const i of items) m.set(i.clientId, { name: i.clientName, items: [...(m.get(i.clientId)?.items ?? []), i] });
    return [...m.entries()];
  }, [items]);
  const manage = can("accounting.manage") && status !== "posted";
  const setMany = (ids: string[], on: boolean) => setSel((s) => (on ? new Set([...s, ...ids]) : new Set([...s].filter((x) => !ids.includes(x)))));
  const move = useMutation({
    mutationFn: (to: "pending" | "approved" | "excluded") => api.post<{ changed: number }>("/billables/status", { ids: [...sel], status: to }),
    onSuccess: (r, to) => {
      setSel(new Set());
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t(`approvals.moved.${to}`, { count: r.changed }));
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
        return (
          <section key={clientId} className="glass overflow-hidden rounded-2xl border">
            <div className="flex items-center gap-3 border-b bg-background/30 px-3 py-2">
              {manage && (
                <Checkbox
                  checked={ids.every((x) => sel.has(x)) ? true : ids.some((x) => sel.has(x)) ? "indeterminate" : false}
                  onCheckedChange={(v) => setMany(ids, Boolean(v))}
                />
              )}
              <span className="flex-1 text-sm font-semibold">{g.name}</span>
              <span className="text-xs text-muted-foreground">{t("approvals.items", { count: g.items.length })}</span>
              <span className="font-mono text-sm">{m(sub)}</span>
            </div>
            <ul className="divide-y divide-border/60">
              {g.items.map((i) =>
                editing === i.id ? (
                  <li key={i.id}>
                    <EditRow item={i} onDone={() => setEditing(null)} lang={lang} />
                  </li>
                ) : (
                  <li
                    key={i.id}
                    className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2 text-sm md:grid-cols-[auto_90px_minmax(0,1fr)_80px_100px_110px_auto]"
                  >
                    {manage ? <Checkbox className="mt-0.5" checked={sel.has(i.id)} onCheckedChange={(v) => setMany([i.id], Boolean(v))} /> : <span />}
                    <span className="hidden text-xs text-muted-foreground md:block">
                      {shortDate(i.date)}
                      {i.dateEnd && <span className="block">→ {shortDate(i.dateEnd)}</span>}
                    </span>
                    <span className="min-w-0">
                      <span className="block break-words">{i.description}</span>
                      <span className="block text-[11px] text-muted-foreground">
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
                      {(i.quantityX100 / 100).toLocaleString(lang === "en" ? "en-CA" : "fr-CA")}
                    </span>
                    <span className="hidden text-right font-mono text-xs text-muted-foreground md:block">{m(i.unitPriceCents)}</span>
                    <span className="text-right font-mono">{m(i.amountCents)}</span>
                    <span className="flex items-center justify-end gap-1">
                      {i.autoApproved && i.status === "approved" && (
                        <span
                          className="flex items-center gap-0.5 rounded-md border border-violet-500/40 bg-violet-500/10 px-1 py-0.5 text-[10px] text-violet-300"
                          title={t("approvals.autoHint")}
                        >
                          <Sparkles className="size-2.5" /> {t("approvals.auto")}
                        </span>
                      )}
                      <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px]", STATUS_STYLE[i.status])}>{t(`approvals.status.${i.status}`)}</span>
                      {manage && (
                        <button
                          type="button"
                          onClick={() => setEditing(i.id)}
                          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                          aria-label={t("approvals.edit")}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      )}
                    </span>
                  </li>
                ),
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function EditRow({ item: i, onDone, lang }: { item: Item; onDone: () => void; lang: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({ quantity: String(i.quantityX100 / 100), rate: (i.unitPriceCents / 100).toFixed(2), description: i.description });
  const num = (s: string) => Number(s.replace(",", "."));
  const save = useMutation({
    mutationFn: () => api.patch(`/billables/${i.id}`, { quantity: num(f.quantity), unitPriceCents: Math.round(num(f.rate) * 100), description: f.description }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t("approvals.saved"));
      onDone();
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <form
      className="grid gap-2 bg-[color:var(--gold)]/[0.04] px-3 py-2 sm:grid-cols-[minmax(0,1fr)_100px_110px_auto]"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className="h-8" aria-label={t("approvals.description")} />
      <Input
        value={f.quantity}
        inputMode="decimal"
        onChange={(e) => setF({ ...f, quantity: e.target.value })}
        className="h-8 font-mono"
        aria-label={t(i.kind === "labour" ? "approvals.hours" : "approvals.quantity")}
        placeholder={t(i.kind === "labour" ? "approvals.hours" : "approvals.quantity")}
      />
      <Input
        value={f.rate}
        inputMode="decimal"
        onChange={(e) => setF({ ...f, rate: e.target.value })}
        className="h-8 font-mono"
        aria-label={t("approvals.rate")}
      />
      <div className="flex items-center gap-1">
        <span className="px-1 font-mono text-xs text-muted-foreground">{money(Math.round(num(f.quantity) * num(f.rate) * 100), lang)}</span>
        <Button type="submit" size="sm" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
          {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          <X className="size-3.5" />
        </Button>
      </div>
    </form>
  );
}

/** What posting will make, client by client; then the invoices are made. */
function PostDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data: groups = [], isLoading } = useQuery({ queryKey: [...KEY, "post"], queryFn: () => api.get<Group[]>("/billables/post"), gcTime: 0 });
  const [sel, setSel] = useState<Set<string> | null>(null);
  const chosen = sel ?? new Set(groups.map((g) => g.client.id));
  const m = (c: number) => money(c, i18n.language);
  const post = useMutation({
    mutationFn: () => api.post<{ number: string; client: string }[]>("/billables/post", { clientIds: [...chosen] }),
    onSuccess: (made) => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      toast.success(t("approvals.posted", { count: made.length, numbers: made.map((x) => x.number).join(", ") }));
      onClose();
    },
    onError: () => toast.error(t("common.error")),
  });
  const total = groups.filter((g) => chosen.has(g.client.id)).reduce((x, g) => x + g.totalCents, 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("approvals.postTitle")}</DialogTitle>
          <DialogDescription>{t("approvals.postText")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin">
          {isLoading && <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />}
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
            {groups.map((g) => (
              <li key={g.client.id}>
                <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5 text-sm hover:bg-accent/30">
                  <Checkbox
                    className="mt-0.5"
                    checked={chosen.has(g.client.id)}
                    onCheckedChange={(v) => setSel(new Set(v ? [...chosen, g.client.id] : [...chosen].filter((x) => x !== g.client.id)))}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{g.client.name}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t("approvals.lines", { count: g.count })} · {g.kinds.map((k) => t(`approvals.tabs.${k}`)).join(", ")} ·{" "}
                      {g.exempt ? t("approvals.exempt") : `TPS ${m(g.gstCents)} · TVQ ${m(g.qstCents)}`} · {t("approvals.terms", { days: g.termsDays })}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-mono">{m(g.totalCents)}</span>
                    <span className="block font-mono text-[11px] text-muted-foreground">{m(g.subtotalCents)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
          <span className="mr-auto text-sm">
            {t("approvals.invoices", { count: chosen.size })} · <span className="font-mono">{m(total)}</span>
          </span>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!chosen.size || post.isPending}
            onClick={() => post.mutate()}
            className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105"
          >
            {post.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("approvals.postConfirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
