import { useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BadgeCheck, Banknote, CalendarRange, ChevronRight, FilePen, FileText, Folder, FolderOpen, Loader2, Paperclip, Pencil, Plus, Send, Star, Trash2, UserCog, Wallet, X } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { isMileageUnit } from "@shared/mileage";
import { money, useCrmClients } from "@/pages/crm/shared";
import { fileToBase64 } from "@/pages/outlook/shared";
import { shortDate } from "@/pages/tickets/shared";

export type ExpenseType = { id: string; name: string; unit: string | null; unitPriceCents: number | null; billable: boolean; ledgerAccountId: string | null; active: boolean };
export type Expense = {
  id: string;
  date: string;
  typeId: string;
  type: string;
  description: string;
  quantityX100: number;
  unitPriceCents: number;
  amountCents: number;
  clientId: string | null;
  clientName: string | null;
  billable: boolean;
  status: "draft" | "submitted" | "approved" | "rejected" | "paid";
  comment: string | null;
  hasReceipt: boolean;
  receiptName: string | null;
  quickbooksId: string | null;
  quickbooksError: string | null;
  /** A trip (a mileage type, in km): where from and to; it shows as kilometres, never in money */
  unit: string | null;
  mileage: boolean;
  fromPlace: string | null;
  toPlace: string | null;
};
export const EXPENSE_STATUS_STYLE: Record<Expense["status"], string> = {
  draft: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  submitted: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  rejected: "border-red-500/40 bg-red-500/10 text-red-300",
  paid: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
};
const MAX_FILE = 5 * 1024 * 1024;

/** An expense kept to be added again in one click (the same trip, parking…) */
export type ExpenseFavorite = {
  id: string;
  name: string;
  typeId: string;
  type: string;
  description: string;
  quantityX100: number | null;
  amountCents: number | null;
  clientId: string | null;
  clientName: string | null;
  billable: boolean;
  mileage: boolean;
  fromPlace: string | null;
  toPlace: string | null;
};
const FAVORITES_KEY = ["time", "expense-favorites"] as const;
const useFavorites = () => useQuery({ queryKey: FAVORITES_KEY, queryFn: () => api.get<ExpenseFavorite[]>("/time/expense-favorites") });

/** The favourites as chips: a click uses one; the × forgets it. */
function FavoriteChips({ onPick, removable }: { onPick: (f: ExpenseFavorite) => void; removable?: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data: favs = [] } = useFavorites();
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/time/expense-favorites/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: FAVORITES_KEY }),
    onError: () => toast.error(t("common.error")),
  });
  if (!favs.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Star className="size-3 fill-[color:var(--gold)] text-[color:var(--gold)]" /> {t("expense.favorites.title")}
      </span>
      {favs.map((x) => (
        <span key={x.id} className="inline-flex items-center rounded-full border border-[color:var(--gold)]/35 bg-[color:var(--gold)]/[0.06] text-xs">
          <button
            type="button"
            onClick={() => onPick(x)}
            title={[x.type, x.description, x.clientName].filter(Boolean).join(" · ")}
            className={cn("py-1 pl-2.5 hover:text-primary", removable ? "pr-1" : "pr-2.5")}
          >
            {x.name}
            <span className="ml-1 text-muted-foreground">
              {x.quantityX100 != null ? `${x.quantityX100 / 100}${x.mileage ? " km" : ""}` : x.amountCents != null ? money(x.amountCents, i18n.language) : ""}
            </span>
          </button>
          {removable && (
            <button
              type="button"
              aria-label={t("expense.favorites.remove", { name: x.name })}
              title={t("expense.favorites.remove", { name: x.name })}
              onClick={() => remove.mutate(x.id)}
              className="rounded-full p-1 pr-1.5 text-muted-foreground hover:text-destructive"
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

export type ExpenseReport = {
  id: string;
  title: string;
  periodStart: string | null;
  periodEnd: string | null;
  submittedAt: string | null;
  createdAt: string;
  status: "open" | "submitted" | "approved" | "paid";
  rejected: number;
  totalCents: number;
  /** What is shown in money (a trip shows its kilometres instead) and the kilometres paid */
  moneyCents: number;
  totalKm: number;
  from: string | null;
  to: string | null;
  items: Expense[];
};

/** A report's total: the money of its lines, and the kilometres paid (a trip shows no money) */
function useTotalText() {
  const { t, i18n } = useTranslation();
  return (r: { moneyCents: number; totalKm: number }) => {
    const parts = [r.moneyCents > 0 || r.totalKm === 0 ? money(r.moneyCents, i18n.language) : null, r.totalKm > 0 ? t("expense.kmPaid", { km: r.totalKm }) : null].filter(Boolean);
    return parts.join(" + ");
  };
}

/** The filters, on the reports: open (being filled, or with a refused item to fix), submitted, approved, paid */
const FILTERS = [
  { key: "open", icon: FilePen, className: "border-slate-500/40 bg-slate-500/15 text-slate-200" },
  { key: "submitted", icon: Send, className: EXPENSE_STATUS_STYLE.submitted },
  { key: "approved", icon: BadgeCheck, className: EXPENSE_STATUS_STYLE.approved },
  { key: "paid", icon: Banknote, className: EXPENSE_STATUS_STYLE.paid },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

const ymd = (d: Date) => d.toLocaleDateString("en-CA");
/** This month, first to last day */
const thisMonth = () => {
  const n = new Date();
  return { periodStart: ymd(new Date(n.getFullYear(), n.getMonth(), 1)), periodEnd: ymd(new Date(n.getFullYear(), n.getMonth() + 1, 0)) };
};
/** "1 – 31 oct." / "28 sept. – 4 oct." */
const periodText = (from: string | null, to: string | null) => (from && to ? (from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`) : null);

/** My tools › Expenses: reports covering a period, filled item by item, then sent together for approval. */
export function ExpensesPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  // managers pick whose expenses to look at (their own by default; others are read only)
  const me = useMe();
  const manager = useCan()("timesheets.manage");
  const [who, setWho] = useState(me.id);
  const others = who !== me.id;
  const { data: people } = useQuery({ queryKey: ["time", "people"], queryFn: () => api.get<{ id: string; name: string; timesheetRequired: boolean }[]>("/time/people"), enabled: manager });
  const { data: reports = [], isLoading } = useQuery({ queryKey: ["time", "expense-reports", who], queryFn: () => api.get<ExpenseReport[]>(`/time/expense-reports${others ? `?userId=${who}` : ""}`) });
  const [creating, setCreating] = useState(false);
  const m = (c: number) => money(c, i18n.language);
  const totalText = useTotalText();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["time", "expense-reports"] });
    void qc.invalidateQueries({ queryKey: ["time", "expenses"] });
  };

  // in the address: the filter ("open" by default, "all" for everything) and the report open
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
        return p;
      },
      { replace: true },
    );
  const raw = params.get("status");
  const filter = raw === "all" ? null : (FILTERS.find((f) => f.key === raw) ?? FILTERS[0]);
  const setFilter = (k: FilterKey | "all") => set({ status: k === "open" ? null : k });
  const openReport = reports.find((r) => r.id === params.get("report")) ?? null;
  const shown = filter ? reports.filter((r) => r.status === filter.key) : reports;
  const toFix = reports.filter((r) => r.status === "open" && r.items.length > 0);

  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Wallet className="size-6 text-primary" /> {t("expense.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("expense.subtitle")}</p>
        </div>
        {manager && people && (
          <Select value={who} onValueChange={setWho}>
            <SelectTrigger className="w-64" aria-label={t("timesheet.person")}>
              <UserCog className="size-4 text-primary" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {people.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.id === me.id ? t("timesheet.me", { name: x.name }) : x.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {!others && (
          <Button onClick={() => setCreating(true)} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            <Plus className="size-4" /> {t("expense.report.new")}
          </Button>
        )}
      </div>
      {others && <p className="rounded-xl border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/5 px-3 py-2 text-xs text-muted-foreground">{t("expense.viewing", { name: people?.find((x) => x.id === who)?.name ?? "" })}</p>}

      {toFix.length > 0 && filter?.key !== "open" && (
        <button
          type="button"
          onClick={() => setFilter("open")}
          className="flex w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-left text-sm text-amber-200 hover:bg-amber-500/15"
        >
          <FilePen className="size-4 shrink-0" /> {t("expense.report.notSent", { count: toFix.length })}
        </button>
      )}

      {reports.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("expense.filter.label")}>
          {FILTERS.map((f) => {
            const on = filter?.key === f.key;
            const count = reports.filter((r) => r.status === f.key).length;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(on ? "all" : f.key)}
                title={on ? t("expense.filter.showAll") : undefined}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-all",
                  on ? cn(f.className, "shadow-[0_0_14px_-4px_currentColor]") : "border-border/70 bg-card/40 text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                <f.icon className="size-3.5" />
                {t(`expense.filter.${f.key}`)}
                <span className={cn("tabular-nums", on ? "opacity-90" : "opacity-60")}>{count}</span>
              </button>
            );
          })}
          {!filter && <span className="ml-1 text-xs text-muted-foreground">{t("expense.filter.all")}</span>}
        </div>
      )}

      {isLoading && <Loader2 className="mx-auto my-10 size-6 animate-spin text-muted-foreground" />}
      {!isLoading && !reports.length && <p className="glass rounded-2xl border border-dashed py-14 text-center text-sm text-muted-foreground">{t("expense.report.none")}</p>}
      {reports.length > 0 && !shown.length && <p className="glass rounded-2xl border border-dashed py-10 text-center text-sm text-muted-foreground">{t("expense.filter.none")}</p>}

      {/* The reports: a click opens one */}
      <ul className="space-y-2.5">
        {shown.map((r) => {
          const pill = FILTERS.find((f) => f.key === r.status)!;
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => set({ report: r.id })}
                className={cn(
                  "glass group flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border px-4 py-3 text-left transition-colors hover:border-[color:var(--gold)]/45",
                  r.status === "open" && "border-[color:var(--gold)]/25",
                )}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[color:var(--gold)]/10 text-primary">
                  <Folder className="size-5 fill-[color:var(--gold)]/20 transition-all group-hover:fill-[color:var(--gold)]/40" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{r.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[periodText(r.periodStart, r.periodEnd), t("expense.report.items", { count: r.items.length })].filter(Boolean).join(" · ")}
                    {r.rejected > 0 && r.status === "open" && <span className="text-red-300"> · {t("expense.report.refusedShort", { count: r.rejected })}</span>}
                  </span>
                </span>
                <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", pill.className)}>
                  <pill.icon className="size-3" /> {t(`expense.filter.${pill.key}`)}
                </span>
                <span className="w-28 text-right font-mono font-semibold">{totalText(r)}</span>
                <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
              </button>
            </li>
          );
        })}
      </ul>

      {creating && (
        <ReportFormDialog
          report={null}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            refresh();
            setCreating(false);
            // straight into the new report (it is open: under "Ouvertes")
            set({ status: null, report: id });
          }}
        />
      )}
      {openReport && <ReportView r={openReport} readOnly={others} money={m} onClose={() => set({ report: null })} onChanged={refresh} />}
    </div>
  );
}

/** New report (title and the days it covers), or the same to change while it is open. */
function ReportFormDialog({ report, onClose, onSaved }: { report: ExpenseReport | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const month = thisMonth();
  const [f, setF] = useState({
    title:
      report?.title ??
      t("expense.report.defaultTitle", { month: new Intl.DateTimeFormat(i18n.language === "en" ? "en-CA" : "fr-CA", { month: "long", year: "numeric" }).format(new Date()) }),
    periodStart: report?.periodStart ?? month.periodStart,
    periodEnd: report?.periodEnd ?? month.periodEnd,
  });
  const save = useMutation({
    mutationFn: async () => (report ? (await api.patch(`/time/expense-reports/${report.id}`, f), report.id) : (await api.post<ExpenseReport>("/time/expense-reports", f)).id),
    onSuccess: (id) => onSaved(id),
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : "";
      toast.error(code === "report_period_items" ? t("expense.report.periodItems") : code === "Validation failed" ? t("expense.report.periodInvalid") : t("common.error"));
    },
  });
  const valid = f.title.trim() && f.periodStart && f.periodEnd && f.periodEnd >= f.periodStart;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="size-5 text-primary" /> {report ? t("expense.report.edit") : t("expense.report.new")}
          </DialogTitle>
          <DialogDescription>{t("expense.report.formText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label className="text-xs">{t("expense.report.title")}</Label>
            <Input required maxLength={120} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("expense.report.from")}</Label>
              <Input type="date" required value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("expense.report.to")}</Label>
              <Input type="date" required min={f.periodStart} value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {report ? t("expense.save") : t("expense.report.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One report: + to add an expense, a pencil to change one (or the report), and one button to send it all. */
function ReportView({ r, readOnly, money: m, onClose, onChanged }: { r: ExpenseReport; readOnly?: boolean; money: (c: number) => string; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const totalText = useTotalText();
  const open = r.status === "open" && !readOnly;
  const [item, setItem] = useState<Expense | "new" | { preset: ExpenseFavorite } | null>(null);
  const [editingReport, setEditingReport] = useState(false);
  const onError = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "";
    toast.error(code === "report_empty" ? t("expense.report.empty") : code === "report_submitted" ? t("expense.report.locked") : t("common.error"));
  };
  const submit = useMutation({
    mutationFn: () => api.post(`/time/expense-reports/${r.id}/submit`),
    onSuccess: () => {
      onChanged();
      toast.success(t("expense.report.sent"));
    },
    onError,
  });
  const removeItem = useMutation({ mutationFn: (id: string) => api.del(`/time/expenses/${id}`), onSuccess: onChanged, onError });
  const removeReport = useMutation({
    mutationFn: () => api.del(`/time/expense-reports/${r.id}`),
    onSuccess: () => {
      onChanged();
      onClose();
    },
    onError,
  });
  const toSend = r.items.filter((x) => x.status === "draft" || x.status === "rejected").length;
  // the files of the folder, by classification (the order of the first of each)
  const groups = [...r.items.reduce((acc, x) => acc.set(x.type, [...(acc.get(x.type) ?? []), x]), new Map<string, Expense[]>()).entries()].map(([type, items]) => ({ type, items, mileage: items.every((i) => i.mileage) }));
  const pill = FILTERS.find((f) => f.key === r.status)!;
  const IconBtn = ({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn("rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06]", danger ? "hover:text-destructive" : "hover:text-foreground")}
    >
      {children}
    </button>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="flex max-h-[min(88dvh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <header className="flex items-start gap-3 border-b px-5 py-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[color:var(--gold)]/10 text-primary">
            <FolderOpen className="size-5 fill-[color:var(--gold)]/25" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-1.5 text-lg">
              <span className="truncate">{r.title}</span>
              {open && (
                <IconBtn label={t("expense.report.edit")} onClick={() => setEditingReport(true)}>
                  <Pencil className="size-3.5" />
                </IconBtn>
              )}
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {periodText(r.periodStart, r.periodEnd) && (
                <span className="inline-flex items-center gap-1">
                  <CalendarRange className="size-3.5" /> {periodText(r.periodStart, r.periodEnd)}
                </span>
              )}
              <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", pill.className)}>
                <pill.icon className="size-3" /> {t(`expense.filter.${pill.key}`)}
              </span>
              {r.submittedAt && <span>{t("expense.report.sentOn", { date: shortDate(r.submittedAt.slice(0, 10)) })}</span>}
            </DialogDescription>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("expense.report.total")}</p>
            <p className="font-mono text-xl font-bold">{totalText(r)}</p>
          </div>
          {r.submittedAt && (
            <a
              href={`/api/time/expense-reports/${r.id}/pdf`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-[color:var(--gold)]/50 hover:text-foreground"
              title={t("expense.report.pdf")}
            >
              <FileText className="size-3.5" /> PDF
            </a>
          )}
          <IconBtn label={t("common.close")} onClick={onClose}>
            <X className="size-4" />
          </IconBtn>
        </header>

        {r.rejected > 0 && open && <p className="border-b border-red-500/20 bg-red-500/5 px-5 py-2 text-xs text-red-300">{t("expense.report.refused", { count: r.rejected })}</p>}

        <div className="flex items-center justify-between gap-2 px-5 pb-1 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("expense.report.items", { count: r.items.length })}</p>
          {open && (
            <Button size="sm" variant="outline" className="h-8 gap-1 border-[color:var(--gold)]/40 hover:bg-[color:var(--gold)]/10" onClick={() => setItem("new")} aria-label={t("expense.report.addItem")}>
              <Plus className="size-4 text-primary" /> {t("expense.report.addShort")}
            </Button>
          )}
        </div>

        {open && (
          <div className="px-5 pb-1 pt-1">
            <FavoriteChips onPick={(x) => setItem({ preset: x })} />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin">
          {r.items.length > 0 ? (
            <div className="space-y-3 px-1 pb-1">
              {groups.map((g) => (
                <section key={g.type}>
                  <h3 className="flex items-center gap-2 px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Folder className="size-3.5 text-primary" />
                    <span className="flex-1 truncate">{g.type}</span>
                    <span className="font-normal normal-case">{t("expense.report.items", { count: g.items.length })}</span>
                    <span className="w-24 text-right font-mono text-sm font-semibold normal-case text-foreground">{g.mileage ? t("expense.km", { km: g.items.reduce((n, i) => n + i.quantityX100, 0) / 100 }) : m(g.items.reduce((n, i) => n + i.amountCents, 0))}</span>
                  </h3>
            <ul className="divide-y divide-border/60 rounded-xl border border-border/50 bg-card/30">
              {g.items.map((x) => {
                const editable = open && (x.status === "draft" || x.status === "rejected");
                return (
                  <li key={x.id} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-foreground/[0.03] md:grid-cols-[72px_minmax(0,1fr)_96px_96px_auto]">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <FileText className="size-3.5 shrink-0 text-primary/70" />
                      {shortDate(x.date)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">{x.description}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {[x.type, x.clientName && (x.billable ? t("expense.billedTo", { name: x.clientName }) : x.clientName), x.hasReceipt && t("expense.receipt")].filter(Boolean).join(" · ")}
                      </span>
                      {x.status === "rejected" && x.comment && <span className="block text-[11px] text-red-300">{x.comment}</span>}
                    </span>
                    <span className="hidden md:block">
                      {/* each item's own stage once sent (approved one by one) */}
                      {x.status !== "draft" && <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px]", EXPENSE_STATUS_STYLE[x.status])}>{t(`expense.status.${x.status}`)}</span>}
                    </span>
                    <span className="text-right font-mono">{x.mileage ? t("expense.km", { km: x.quantityX100 / 100 }) : m(x.amountCents)}</span>
                    <span className="flex justify-end gap-0.5">
                      {x.hasReceipt && (
                        <a href={`/api/time/expenses/${x.id}/receipt`} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground" aria-label={t("expense.receipt")} title={t("expense.receipt")}>
                          <Paperclip className="size-3.5" />
                        </a>
                      )}
                      {editable && (
                        <>
                          <IconBtn label={t("expense.edit")} onClick={() => setItem(x)}>
                            <Pencil className="size-3.5" />
                          </IconBtn>
                          <IconBtn label={t("expense.remove")} danger onClick={() => removeItem.mutate(x.id)}>
                            <Trash2 className="size-3.5" />
                          </IconBtn>
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
                </section>
              ))}
            </div>
          ) : (
            <button type="button" disabled={!open} onClick={() => setItem("new")} className="mx-3 my-2 flex w-[calc(100%-1.5rem)] flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-sm text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground">
              <Plus className="size-5 text-primary" /> {t("expense.report.noItems")}
            </button>
          )}
        </div>

        {open && (
          <footer className="flex flex-wrap items-center gap-2 border-t bg-foreground/[0.02] px-5 py-3">
            {r.items.every((x) => x.status === "draft" || x.status === "rejected") && (
              <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={removeReport.isPending} onClick={() => removeReport.mutate()}>
                <Trash2 className="size-3.5" /> {t("expense.report.delete")}
              </Button>
            )}
            <Button className="ml-auto bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={!toSend || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("expense.report.submit", { count: toSend })}
            </Button>
          </footer>
        )}

        {item && (
          <ExpenseDialog
            reportId={r.id}
            period={{ start: r.periodStart, end: r.periodEnd }}
            expense={item === "new" || "preset" in item ? null : item}
            preset={item !== "new" && "preset" in item ? item.preset : undefined}
            onClose={() => setItem(null)}
            onSaved={onChanged}
          />
        )}
        {editingReport && (
          <ReportFormDialog
            report={r}
            onClose={() => setEditingReport(false)}
            onSaved={() => {
              onChanged();
              setEditingReport(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExpenseDialog({
  reportId,
  period,
  expense,
  preset,
  onClose,
  onSaved,
}: {
  reportId: string;
  /** A favourite to start from */
  preset?: ExpenseFavorite;
  /** The report's days: the date must be within */
  period: { start: string | null; end: string | null };
  expense: Expense | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data: types } = useQuery({ queryKey: ["time", "types"], queryFn: () => api.get<{ expense: ExpenseType[] }>("/time/types") });
  const { data: clients = [] } = useCrmClients();
  const fileInput = useRef<HTMLInputElement>(null);
  // today, brought within the report's days
  const now = new Date().toLocaleDateString("en-CA");
  const today = period.start && now < period.start ? period.start : period.end && now > period.end ? period.end : now;
  const fromFavorite = (x: ExpenseFavorite) => ({
    typeId: x.typeId,
    description: x.description,
    quantity: x.quantityX100 != null ? String(x.quantityX100 / 100) : "",
    amount: x.amountCents != null ? (x.amountCents / 100).toFixed(2) : "",
    fromPlace: x.fromPlace ?? "",
    toPlace: x.toPlace ?? "",
    clientId: x.clientId ?? "",
    billable: x.billable,
  });
  const [f, setF] = useState({
    date: expense?.date ?? today,
    typeId: expense?.typeId ?? "",
    description: expense?.description ?? "",
    quantity: expense ? String(expense.quantityX100 / 100) : "",
    amount: expense ? (expense.amountCents / 100).toFixed(2) : "",
    fromPlace: expense?.fromPlace ?? "",
    toPlace: expense?.toPlace ?? "",
    clientId: expense?.clientId ?? "",
    billable: expense?.billable ?? false,
    ...(!expense && preset ? fromFavorite(preset) : {}),
  });
  // also kept as a favourite, under this name
  const [keep, setKeep] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const type = types?.expense.find((x) => x.id === f.typeId);
  const byUnit = Boolean(type?.unit && type.unitPriceCents != null);
  // a trip (km): where from and where to, the distance paid; never the amount in money
  const mileage = isMileageUnit(type?.unit);
  const num = (s: string) => Number(s.replace(",", "."));
  const amount = byUnit ? Math.round(num(f.quantity) * (type!.unitPriceCents ?? 0)) : Math.round(num(f.amount) * 100);
  const save = useMutation({
    mutationFn: async () => {
      const receipt = file ? { name: file.name, contentType: file.type || "application/octet-stream", data: await fileToBase64(file) } : undefined;
      const p = { date: f.date, typeId: f.typeId, description: f.description, ...(byUnit ? { quantity: num(f.quantity) } : { amountCents: amount }), ...(mileage ? { fromPlace: f.fromPlace.trim(), toPlace: f.toPlace.trim() } : {}), clientId: f.clientId || null, billable: Boolean(f.clientId) && f.billable, ...(receipt ? { receipt } : {}) };
      const r = await (expense ? api.patch(`/time/expenses/${expense.id}`, p) : api.post("/time/expenses", { ...p, reportId }));
      if (keep?.trim()) {
        const { date: _date, receipt: _receipt, ...rest } = p as typeof p & { receipt?: unknown };
        await api.post("/time/expense-favorites", { ...rest, name: keep.trim() }).catch((e) => {
          toast.error(e instanceof ApiError && e.code === "too_many_favorites" ? t("expense.favorites.tooMany") : t("common.error"));
        });
        void qc.invalidateQueries({ queryKey: FAVORITES_KEY });
      }
      return r;
    },
    onSuccess: () => {
      onSaved();
      toast.success(t("expense.saved"));
      onClose();
    },
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : "";
      toast.error(code === "expense_out_of_period" ? t("expense.report.outOfPeriod") : code === "mileage_places_required" ? t("expense.placesRequired") : code === "Validation failed" ? t("expense.invalid") : t("common.error"));
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="size-5 text-primary" /> {expense ? t("expense.edit") : t("expense.new")}
          </DialogTitle>
          <DialogDescription>{t("expense.dialogText")}</DialogDescription>
        </DialogHeader>
        {!expense && <FavoriteChips removable onPick={(x) => setF((cur) => ({ ...cur, ...fromFavorite(x) }))} />}
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("expense.date")}</Label>
              <Input type="date" required min={period.start ?? undefined} max={period.end ?? undefined} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("expense.type")}</Label>
              <Select value={f.typeId} onValueChange={(v) => setF({ ...f, typeId: v, billable: types?.expense.find((x) => x.id === v)?.billable ?? f.billable })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("expense.pickType")} />
                </SelectTrigger>
                <SelectContent>
                  {(types?.expense ?? []).map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.name}
                      {x.unit && x.unitPriceCents != null && !isMileageUnit(x.unit) && <span className="ml-1 text-xs text-muted-foreground">({money(x.unitPriceCents, i18n.language)}/{x.unit})</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {mileage && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("expense.from")}</Label>
                <Input required maxLength={200} value={f.fromPlace} onChange={(e) => setF({ ...f, fromPlace: e.target.value })} placeholder={t("expense.fromHint")} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("expense.to")}</Label>
                <Input required maxLength={200} value={f.toPlace} onChange={(e) => setF({ ...f, toPlace: e.target.value })} placeholder={t("expense.toHint")} />
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">{mileage ? t("expense.noteOptional") : t("expense.description")}</Label>
            <Input required={!mileage} maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {byUnit ? (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("expense.quantity", { unit: type!.unit })}</Label>
                <Input required inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("expense.amount")}</Label>
                <Input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
              </div>
            )}
            <div className="flex items-end pb-2 font-mono text-sm">{mileage ? (num(f.quantity) > 0 ? t("expense.km", { km: num(f.quantity) }) : "") : Number.isFinite(amount) && amount > 0 ? money(amount, i18n.language) : ""}</div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("expense.client")}</Label>
              <Select value={f.clientId || "none"} onValueChange={(v) => setF({ ...f, clientId: v === "none" ? "" : v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-72">
                  <SelectItem value="none">{t("expense.noClient")}</SelectItem>
                  {clients
                    .filter((c) => c.active)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <label className={cn("flex items-end gap-2 pb-2 text-sm", !f.clientId && "opacity-50")}>
              <Switch disabled={!f.clientId} checked={Boolean(f.clientId) && f.billable} onCheckedChange={(v) => setF({ ...f, billable: v })} /> {t("expense.billable")}
            </label>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("expense.receipt")}</Label>
            <button type="button" onClick={() => fileInput.current?.click()} className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-sm text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground">
              <Paperclip className="size-4 text-primary" /> {file ? file.name : expense?.receiptName ?? t("expense.pickReceipt")}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              hidden
              onChange={(e) => {
                const x = e.target.files?.[0];
                if (x && x.size > MAX_FILE) toast.error(t("expense.tooBig"));
                else setFile(x ?? null);
                e.target.value = "";
              }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {keep === null ? (
              <Button type="button" variant="ghost" size="sm" className="mr-auto gap-1 text-muted-foreground" onClick={() => setKeep(f.description.slice(0, 80))}>
                <Star className="size-3.5" /> {t("expense.favorites.keep")}
              </Button>
            ) : (
              <span className="mr-auto flex items-center gap-1">
                <Star className="size-3.5 fill-[color:var(--gold)] text-[color:var(--gold)]" />
                <Input
                  autoFocus
                  maxLength={80}
                  value={keep}
                  onChange={(e) => setKeep(e.target.value)}
                  placeholder={t("expense.favorites.name")}
                  aria-label={t("expense.favorites.name")}
                  className="h-8 w-44"
                />
                <button type="button" aria-label={t("common.cancel")} onClick={() => setKeep(null)} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              </span>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!f.typeId || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("expense.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
