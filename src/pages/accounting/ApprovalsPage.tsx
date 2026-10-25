import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
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
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";
import { PeriodBar, usePeriod } from "./period";
import { useConfirm } from "@/components/ConfirmDialog";

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
  contractId?: string | null;
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

type Folder = "work";
// the technicians' timesheets and expenses are not approved here any more: they are approved when sent (Admin › Temps et dépenses);
// only the expenses billed back to a client are work to bill, so that tab stays
const FOLDERS: { key: Folder; icon: LucideIcon; tabs: Kind[] }[] = [{ key: "work", icon: Hammer, tabs: ["labour", "charge", "expense", "contract", "milestone", "project"] }];
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
  const tab = (tabs.includes(params.get("tab") as Kind) ? params.get("tab") : tabs[0]) as Kind;
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
  const pendingIn = (f: Folder) => FOLDERS.find((x) => x.key === f)!.tabs.reduce((x, k) => x + count(k, "pending"), 0);
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
                  const soon = k === "project";
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

function Placeholder({ kind }: { kind: "project" }) {
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

function KindTab({ kind, counts, lang, pq }: { kind: Kind; counts: (s: Status) => number; lang: string; pq: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>("pending");
  const [sel, setSel] = useState<Set<string>>(new Set());
  // every section (a client, and under it a contract) starts folded; the ones opened are kept for the session
  const [opened, setOpened] = useState<Set<string>>(readOpened);
  const toggle = (ids: string[], close: boolean) =>
    setOpened((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (close) next.delete(id);
        else next.add(id);
      }
      saveOpened(next);
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
  // the right hourly rate on every labour line of the time frame (the contract's, else the default support contract's, else the usual one)
  const confirm = useConfirm();
  const updateRates = useMutation({
    mutationFn: () => {
      const q = new URLSearchParams(pq);
      return api.post<{ updated: number; unchanged: number; skipped: number; included: number; billedAgain: number }>("/billables/rates", { from: q.get("from"), to: q.get("to") });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t("approvals.updateRatesDone", r));
    },
    onError: () => toast.error(t("common.error")),
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
  const allSections = groups.flatMap(([id, g]) => [id, ...(kind === "contract" ? byContract(g.items).map((cg) => `${id}|${cg.key}`) : [])]);
  const renderItem = (i: Item) => (
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
  );
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
              onClick={() => toggle(allSections, true)}
            >
              <ChevronsDownUp className="size-3.5" /> {t("approvals.collapseAll")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() => toggle(allSections, false)}
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
        <RefreshButton />
        {kind === "labour" && can("accounting.manage") && status !== "posted" && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={updateRates.isPending}
            onClick={() => void confirm({ title: t("approvals.updateRatesTitle"), description: t("approvals.updateRatesText") }).then((ok) => ok && updateRates.mutate())}
          >
            {updateRates.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("approvals.updateRates")}
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
        const closed = !opened.has(clientId);
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
                <li aria-hidden className="hidden grid-cols-[auto_90px_minmax(0,1fr)_80px_100px_110px_auto] gap-3 bg-background/20 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:grid">
                  <span className="w-4" />
                  <span>{t("approvals.col.date")}</span>
                  <span>{t("approvals.col.description")}</span>
                  <span className="text-right">{t(kind === "labour" ? "approvals.col.hours" : "approvals.col.qty")}</span>
                  <span className="text-right">{t(kind === "labour" ? "approvals.col.rate" : "approvals.col.unitPrice")}</span>
                  <span className="text-right">{t("approvals.col.amount")}</span>
                  <span />
                </li>
                {kind === "contract"
                  ? byContract(g.items).map((cg) => (
                      <Fragment key={cg.key}>
                        <li className="flex items-center gap-3 border-t bg-background/30 px-3 py-1.5 text-xs font-semibold">
                          <button
                            type="button"
                            onClick={() => toggle([`${clientId}|${cg.key}`], opened.has(`${clientId}|${cg.key}`))}
                            aria-expanded={opened.has(`${clientId}|${cg.key}`)}
                            title={t(opened.has(`${clientId}|${cg.key}`) ? "approvals.collapse" : "approvals.expand")}
                            className="shrink-0"
                          >
                            <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", opened.has(`${clientId}|${cg.key}`) && "rotate-90")} />
                          </button>
                          {manage ? (
                            <Checkbox
                              checked={cg.items.every((x) => sel.has(x.id)) ? true : cg.items.some((x) => sel.has(x.id)) ? "indeterminate" : false}
                              onCheckedChange={(v) => setMany(cg.items.map((x) => x.id), Boolean(v))}
                              aria-label={cg.name}
                            />
                          ) : (
                            <span className="w-4" />
                          )}
                          <FileText className="size-3.5 shrink-0 text-primary" />
                          <span className="min-w-0 flex-1 truncate">{cg.name}</span>
                          <span className="shrink-0 font-normal text-muted-foreground">{t("approvals.items", { count: cg.items.length })}</span>
                          <span className="shrink-0 font-mono">{m(cg.items.reduce((x, i) => x + i.amountCents, 0))}</span>
                        </li>
                        {opened.has(`${clientId}|${cg.key}`) && cg.items.map(renderItem)}
                      </Fragment>
                    ))
                  : g.items.map(renderItem)}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * A refresh button for a section: reads the contracts, tickets and charges again (what changed on a contract shows in
 * its recurring lines) and reloads the lists.
 */
function RefreshButton() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan();
  const run = useMutation({
    mutationFn: () => api.post<Summary["state"]>("/billables/import"),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["time"] });
      const errors = Object.keys(s.errors);
      if (errors.length) toast.warning(t("approvals.importPartial", { kinds: errors.map((k) => t(`approvals.tabs.${k}`)).join(", ") }));
      else toast.success(t("approvals.refreshed"));
    },
    onError: () => toast.error(t("approvals.importFailed")),
  });
  if (!can("accounting.manage")) return null;
  return (
    <Button size="sm" variant="outline" className="h-8 text-xs" disabled={run.isPending} onClick={() => run.mutate()} title={t("approvals.refreshHint")}>
      <RefreshCw className={cn("size-3.5", run.isPending && "animate-spin")} /> {t("approvals.refresh")}
    </Button>
  );
}

/** The lines of a client's recurring contracts, one group per contract (its services inside, by charge date) */
function byContract(items: Item[]) {
  const m = new Map<string, { key: string; name: string; items: Item[] }>();
  for (const i of items) {
    const key = i.contractId ?? i.contractName ?? "—";
    const g = m.get(key) ?? { key, name: i.contractName ?? "—", items: [] };
    g.items.push(i);
    m.set(key, g);
  }
  return [...m.values()]
    .map((g) => ({ ...g, items: g.items.sort((x, y) => x.date.localeCompare(y.date) || x.description.localeCompare(y.description)) }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

const OPENED_KEY = "akab.approvals.opened";
function readOpened(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(OPENED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function saveOpened(s: Set<string>) {
  try {
    sessionStorage.setItem(OPENED_KEY, JSON.stringify([...s]));
  } catch {
    /* private window: for this page only */
  }
}

/** The small check (approve) and cross (drop) beside a box that was changed */
function Confirm({ onYes, onNo, label }: { onYes: () => void; onNo: () => void; label: string }) {
  return (
    <span className="absolute right-0 top-full z-10 mt-0.5 flex gap-1 rounded-md border bg-popover p-0.5 shadow-md">
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onYes} aria-label={label} title={label} className="grid size-6 place-items-center rounded bg-emerald-600 text-white hover:bg-emerald-500">
        <Check className="size-3.5" />
      </button>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onNo} aria-label="✗" className="grid size-6 place-items-center rounded border text-muted-foreground hover:bg-accent">
        <X className="size-3.5" />
      </button>
    </span>
  );
}

/** Text that is changed where it is: nothing is saved until the check (or Enter); the cross (or Escape) puts it back. */
function InlineText({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const dirty = v.trim() !== value && v.trim() !== "";
  const yes = () => dirty && onSave(v.trim());
  const no = () => setV(value);
  return (
    <span className="relative block">
      <textarea
        value={v}
        rows={1}
        aria-label={label}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            yes();
          }
          if (e.key === "Escape") no();
        }}
        className={cn(
          "field-sizing-content block w-full resize-none rounded-md border bg-transparent px-1 py-0.5 break-words outline-none hover:border-border focus:border-[color:var(--gold)]/60 focus:bg-background/60",
          dirty ? "border-[color:var(--gold)]/60" : "border-transparent",
        )}
      />
      {dirty && <Confirm onYes={yes} onNo={no} label={t("approvals.confirmChange")} />}
    </span>
  );
}

/** A number (hours, quantity, unit price) changed where it is: saved by the check (or Enter), put back by the cross (or Escape). */
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
  const { t } = useTranslation();
  const loc = lang === "en" ? "en-CA" : "fr-CA";
  const show = (n: number) => (asMoney ? n.toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n.toLocaleString(loc, { maximumFractionDigits: 2 }));
  const [v, setV] = useState(show(value));
  useEffect(() => setV(show(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = Number(v.replace(/\s/g, "").replace(",", "."));
  const valid = Number.isFinite(parsed) && parsed >= 0 && v.trim() !== "";
  const dirty = valid && Math.round(parsed * 100) !== Math.round(value * 100);
  const yes = () => dirty && onSave(parsed);
  const no = () => setV(show(value));
  return (
    <span className="relative block">
      <input
        value={v}
        inputMode="decimal"
        aria-label={label}
        onChange={(e) => setV(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") yes();
          if (e.key === "Escape") {
            no();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={cn(
          "w-full rounded-md border bg-transparent px-1 py-0.5 text-right font-mono outline-none hover:border-border focus:border-[color:var(--gold)]/60 focus:bg-background/60",
          dirty ? "border-[color:var(--gold)]/60" : "border-transparent",
          v.trim() !== "" && !valid && "border-destructive",
        )}
      />
      {dirty && <Confirm onYes={yes} onNo={no} label={t("approvals.confirmChange")} />}
    </span>
  );
}
