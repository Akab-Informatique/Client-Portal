import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Files, Loader2, Receipt, Send, Undo2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useSearchParams } from "react-router-dom";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { AiTextarea } from "@/components/AiPolish";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InvoiceSheet } from "@/components/InvoiceSheet";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";
import { KEY, TAB_ICON, type Group, type Item, type Kind } from "./ApprovalsPage";
import { PeriodBar, usePeriod, type Period } from "./period";
import { AllInvoices } from "./AllInvoices";

const TABS = [
  { key: "all", icon: Files },
  { key: "items", icon: Receipt },
] as const;
type Tab = (typeof TABS)[number]["key"];

/**
 * Accounting › Factures, two tabs: every invoice, filtered (Toutes les
 * factures, the default), and the approved work of the time frame to put on
 * invoices (Éléments à facturer: client by client — the kinds or lines, dates,
 * terms, PO, notes, a live preview — or every client at once; only what is
 * within the time frame goes on the invoices).
 */
export function ItemsToInvoice() {
  const { t, i18n } = useTranslation();
  const { period, set } = usePeriod();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "items" ? "items" : "all";
  const go = (k: Tab) =>
    setParams(
      (q) => {
        if (k === "all") q.delete("tab");
        else q.set("tab", k);
        return q;
      },
      { replace: true },
    );
  const { data: ready = [] } = useQuery({
    queryKey: [...KEY, "ready", `from=${period.from}&to=${period.to}`],
    queryFn: () => api.get<Ready[]>(`/billables/clients?from=${period.from}&to=${period.to}`),
  });
  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Receipt className="size-6 text-primary" /> {t("accounting.invoices")}
        </h1>
        <p className="text-sm text-muted-foreground">{t(tab === "all" ? "allInvoices.subtitle" : "invoicing.subtitle")}</p>
      </div>
      <div>
        <div className="flex flex-wrap items-end gap-1 px-2" role="tablist">
          {TABS.map((x) => {
            const active = x.key === tab;
            const n = x.key === "items" ? ready.length : 0;
            return (
              <button
                key={x.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => go(x.key)}
                className={cn(
                  "relative -mb-px flex items-center gap-2 rounded-t-xl border border-b-0 px-4 py-2.5 text-sm font-medium transition-colors",
                  active ? "z-10 border-[color:var(--gold)]/40 bg-card text-foreground" : "border-transparent bg-background/40 text-muted-foreground hover:bg-card/60 hover:text-foreground",
                )}
              >
                {active && <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-grad-gold" />}
                <x.icon className={cn("size-4", active && "text-primary")} /> {t(x.key === "all" ? "allInvoices.tab" : "invoicing.tab")}
                {n > 0 && <span className="rounded-full bg-emerald-500/20 px-1.5 font-mono text-[10px] text-emerald-300">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="space-y-4 rounded-2xl rounded-tl-none border border-[color:var(--gold)]/30 bg-card/60 p-4">
          {tab === "all" ? (
            <AllInvoices />
          ) : (
            <>
              <PeriodBar period={period} onChange={set} />
              <InvoiceFolder lang={i18n.language} period={period} />
              <MadeInvoices lang={i18n.language} period={period} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type Made = { id: string; number: string; company: string; issuedOn: string; totalCents: number; paidCents: number; status: string; quickbooks: { id: string | null } | null };

/** Invoices made by the portal in the time frame: take one back and its items are approved again */
function MadeInvoices({ lang, period }: { lang: string; period: Period }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data } = useQuery({
    queryKey: [...KEY, "made", period.from, period.to],
    queryFn: () => api.get<{ items: Made[] }>(`/crm/invoices?source=portal&from=${period.from}&to=${period.to}`),
  });
  const unpost = useMutation({
    mutationFn: (id: string) => api.post<{ number: string; items: number }>("/billables/unpost", { invoiceId: id }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      toast.success(t("invoicing.unposted", { number: r.number, count: r.items }));
    },
    onError: (e: unknown) => {
      const code = (e as { code?: string }).code;
      toast.error(code && ["invoice_has_payments", "invoice_in_quickbooks", "invoice_voided", "invoice_not_portal"].includes(code) ? t(`invoicing.unpostError.${code}`) : t("common.error"));
    },
  });
  const list = (data?.items ?? []).filter((x) => x.status !== "voided");
  if (!list.length || !can("accounting.manage")) return null;
  return (
    <section className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("invoicing.madeTitle", { count: list.length })}</p>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
        {list.map((x) => {
          const locked = x.paidCents > 0 || Boolean(x.quickbooks?.id);
          return (
            <li key={x.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="font-mono text-xs">{x.number}</span>
              <span className="min-w-0 flex-1 truncate">{x.company}</span>
              <span className="text-xs text-muted-foreground">{shortDate(x.issuedOn)}</span>
              <span className="w-24 text-right font-mono text-xs">{money(x.totalCents, lang)}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={locked || unpost.isPending}
                title={locked ? t("invoicing.unpostLocked") : t("invoicing.unpostHint")}
                onClick={() =>
                  void confirm({ title: t("invoicing.unpostTitle", { number: x.number }), description: t("invoicing.unpostText"), confirmLabel: t("invoicing.unpost"), destructive: true }).then((ok) => ok && unpost.mutate(x.id))
                }
              >
                <Undo2 className="size-3.5" /> {t("invoicing.unpost")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
  lines: { itemId: string; date?: string | null; contractName?: string | null; kind: Kind; description: string; quantity: number; unitPriceCents: number; amountCents: number; taxable: boolean }[];
  subtotalCents: number;
  gstCents: number;
  qstCents: number;
  totalCents: number;
  company: { legalName: string; address: string; phone: string; email: string; website: string };
  taxes: { gstNumber: string; qstNumber: string; gstRate: number; qstRate: number };
  template: { language: "fr" | "en"; footer: string; paymentInstructions: string; showPaymentLink: boolean };
};
const INVOICE_KINDS: Kind[] = ["labour", "charge", "contract", "milestone", "expense", "project"];

function InvoiceFolder({ lang, period }: { lang: string; period: Period }) {
  const { t } = useTranslation();
  const can = useCan();
  const pq = `from=${period.from}&to=${period.to}`;
  const { data: ready = [], isLoading } = useQuery({ queryKey: [...KEY, "ready", pq], queryFn: () => api.get<Ready[]>(`/billables/clients?${pq}`) });
  const [clientId, setClientId] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const current = ready.find((r) => r.client.id === clientId) ?? ready[0] ?? null;
  const m = (c: number) => money(c, lang);
  if (isLoading) return <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />;
  if (!ready.length) return <p className="py-12 text-center text-sm text-muted-foreground">{t("invoicing.none")}</p>;
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
      {current && <InvoiceEditor key={`${current.client.id}:${pq}`} ready={current} lang={lang} period={period} />}
      {bulk && <PostDialog period={period} onClose={() => setBulk(false)} />}
    </div>
  );
}

function InvoiceEditor({ ready, lang, period }: { ready: Ready; lang: string; period: Period }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const m = (c: number) => money(c, lang);
  const today = new Date().toLocaleDateString("en-CA");
  const { data: items = [] } = useQuery({
    queryKey: [...KEY, "approved", ready.client.id, period.from, period.to],
    queryFn: () => api.get<Item[]>(`/billables?status=approved&clientId=${ready.client.id}&from=${period.from}&to=${period.to}`),
  });
  const [kinds, setKinds] = useState<Set<Kind>>(new Set(ready.kinds.map((k) => k.kind)));
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Kind | null>(null);
  const [f, setF] = useState({ issuedOn: today, due: "terms" as "terms" | "date", termsDays: "", dueOn: "", poNumber: "", notes: "" });
  // the QuickBooks item and tax code sent on every line of this invoice (filled in from the defaults, changed here when needed)
  const { data: qbCodes } = useQuery({
    queryKey: [...KEY, "qb-codes"],
    queryFn: () => api.get<{ connected: boolean; items: { id: string; name: string }[]; taxCodes: { id: string; name: string }[]; defaults: { itemId: string | null; taxCodeId: string | null } }>("/billables/quickbooks-codes"),
    staleTime: 60_000,
  });
  // one line's own QuickBooks item or tax code (kept on the line, so every invoice made from it carries it)
  const setCodes = useMutation({
    mutationFn: (p: { id: string; qbItemId?: string | null; qbTaxCodeId?: string | null }) => api.patch(`/billables/${p.id}`, { ...(p.qbItemId !== undefined ? { qbItemId: p.qbItemId } : {}), ...(p.qbTaxCodeId !== undefined ? { qbTaxCodeId: p.qbTaxCodeId } : {}) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY, "approved", ready.client.id] }),
    onError: () => toast.error(t("common.error")),
  });
  // a new QuickBooks item, made from the item select (for the invoice, or for one line)
  const [newItemFor, setNewItemFor] = useState<{ line: string | null } | null>(null);
  const [qb, setQb] = useState<{ itemId: string | null; taxCodeId: string | null }>({ itemId: null, taxCodeId: null });
  const qbItem = qb.itemId ?? qbCodes?.defaults.itemId ?? "";
  const qbTax = qb.taxCodeId ?? qbCodes?.defaults.taxCodeId ?? "";
  const itemIds = items.filter((i) => kinds.has(i.kind) && !left.has(i.id)).map((i) => i.id);
  const draft = {
    clientId: ready.client.id,
    itemIds,
    issuedOn: f.issuedOn,
    ...(f.due === "date" && f.dueOn ? { dueOn: f.dueOn } : {}),
    ...(f.due === "terms" && f.termsDays !== "" ? { termsDays: Number(f.termsDays) } : {}),
    poNumber: f.poNumber || null,
    notes: f.notes || null,
    // only the work of the time frame
    from: period.from,
    to: period.to,
  };
  const { data: pv, isFetching } = useQuery({
    queryKey: [...KEY, "preview", draft],
    queryFn: () => api.post<Draft>("/billables/invoice/preview", draft),
    enabled: itemIds.length > 0,
    placeholderData: (p) => p,
  });
  const create = useMutation({
    mutationFn: () => api.post<{ number: string }>("/billables/invoice", { ...draft, ...(qbCodes?.connected ? { qbItemId: qbItem || null, qbTaxCodeId: qbTax || null } : {}) }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      toast.success(t("approvals.invoice.created", { number: r.number }));
    },
    onError: () => toast.error(t("common.error")),
  });
  const confirm = useConfirm();
  const unpostItems = useMutation({
    mutationFn: () => api.post<{ changed: number }>("/billables/status", { ids: itemIds, status: "pending" }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t("approvals.moved.pending", { count: r.changed }));
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
                          {qbCodes?.connected && (
                            <div className="mb-1 ml-6 mt-0.5 grid gap-1 sm:grid-cols-2">
                              <select
                                value={i.qbItemId ?? ""}
                                onChange={(e) => (e.target.value === NEW_ITEM ? setNewItemFor({ line: i.id }) : setCodes.mutate({ id: i.id, qbItemId: e.target.value || null }))}
                                aria-label={t("approvals.invoice.qbItem")}
                                className="h-7 rounded border bg-transparent px-1.5 text-[11px]"
                              >
                                <option value="">{t("approvals.invoice.qbSameItem")}</option>
                                {qbCodes.items.map((x) => (
                                  <option key={x.id} value={x.id}>
                                    {x.name}
                                  </option>
                                ))}
                                <option value={NEW_ITEM}>{t("approvals.invoice.qbNew")}</option>
                              </select>
                              <select
                                value={i.qbTaxCodeId ?? ""}
                                onChange={(e) => setCodes.mutate({ id: i.id, qbTaxCodeId: e.target.value || null })}
                                aria-label={t("approvals.invoice.qbTax")}
                                className="h-7 rounded border bg-transparent px-1.5 text-[11px]"
                              >
                                <option value="">{t("approvals.invoice.qbSameTax")}</option>
                                {qbCodes.taxCodes.map((x) => (
                                  <option key={x.id} value={x.id}>
                                    {x.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {can("accounting.manage") && itemIds.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={unpostItems.isPending}
              onClick={() =>
                void confirm({ title: t("invoicing.unpostItemsTitle", { count: itemIds.length }), description: t("invoicing.unpostItemsText"), confirmLabel: t("invoicing.unpostItems") }).then((ok) => ok && unpostItems.mutate())
              }
            >
              <Undo2 className="size-3.5" /> {t("invoicing.unpostItems")} ({itemIds.length})
            </Button>
          )}
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
            <p className="text-[10px] leading-snug text-muted-foreground">{f.due === "terms" ? t("approvals.invoice.dueHint", { due: pv ? shortDate(pv.dueOn) : "" }) : t("approvals.invoice.dueHintExact")}</p>
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
            <AiTextarea rows={3} value={f.notes} maxLength={2000} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </label>
          {qbCodes?.connected && (
            <>
              <label className="space-y-1.5 text-xs">
                <span className="text-muted-foreground">{t("approvals.invoice.qbItem")}</span>
                <select value={qbItem} onChange={(e) => (e.target.value === NEW_ITEM ? setNewItemFor({ line: null }) : setQb({ ...qb, itemId: e.target.value }))} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
                  <option value="">—</option>
                  {qbCodes.items.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                  <option value={NEW_ITEM}>{t("approvals.invoice.qbNew")}</option>
                </select>
              </label>
              <label className="space-y-1.5 text-xs">
                <span className="text-muted-foreground">{t("approvals.invoice.qbTax")}</span>
                <select value={qbTax} onChange={(e) => setQb({ ...qb, taxCodeId: e.target.value })} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
                  <option value="">—</option>
                  {qbCodes.taxCodes.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-muted-foreground sm:col-span-2">{t("approvals.invoice.qbHint")}</p>
            </>
          )}
        </section>
        {newItemFor && (
          <NewItemDialog
            onClose={() => setNewItemFor(null)}
            onCreated={(id) => {
              void qc.invalidateQueries({ queryKey: [...KEY, "qb-codes"] });
              if (newItemFor.line) setCodes.mutate({ id: newItemFor.line, qbItemId: id });
              else setQb((x) => ({ ...x, itemId: id }));
              setNewItemFor(null);
            }}
          />
        )}
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

/** The invoice as the client will see it (the same sheet as the template preview in Admin › Facturation). */
function InvoicePaper({ d }: { d: Draft }) {
  return <InvoiceSheet d={d} />;
}

/** What posting will make, client by client; then the invoices are made. */
function PostDialog({ period, onClose }: { period: Period; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const pq = `from=${period.from}&to=${period.to}`;
  const { data: groups = [], isLoading } = useQuery({ queryKey: [...KEY, "post", pq], queryFn: () => api.get<Group[]>(`/billables/post?${pq}`), gcTime: 0 });
  const [sel, setSel] = useState<Set<string> | null>(null);
  const chosen = sel ?? new Set(groups.map((g) => g.client.id));
  const m = (c: number) => money(c, i18n.language);
  const post = useMutation({
    mutationFn: () => api.post<{ number: string; client: string }[]>("/billables/post", { clientIds: [...chosen], from: period.from, to: period.to }),
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

const NEW_ITEM = "__new__";

/** Makes the item when it does not exist: a service in the portal and an item in QuickBooks, at once. */
function NewItemDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ name: "", sku: "", price: "" });
  const make = useMutation({
    mutationFn: () => {
      const n = f.price.trim() === "" ? null : Math.round((Number(f.price.replace(",", ".")) || 0) * 100);
      return api.post<{ id: string; name: string; created: boolean }>("/billables/quickbooks-items", { name: f.name.trim(), sku: f.sku.trim() || null, priceCents: n });
    },
    onSuccess: (r) => {
      toast.success(t(r.created ? "approvals.invoice.qbNewDone" : "approvals.invoice.qbNewExists", { name: r.name }));
      onCreated(r.id);
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "quickbooks_no_account" ? t("approvals.invoice.qbNewNoAccount") : t("common.error")),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("approvals.invoice.qbNewTitle")}</DialogTitle>
          <DialogDescription>{t("approvals.invoice.qbNewText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (f.name.trim()) make.mutate();
          }}
        >
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("approvals.invoice.qbNewName")}</span>
            <Input autoFocus required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("approvals.invoice.qbNewSku")}</span>
              <Input maxLength={60} value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{t("approvals.invoice.qbNewPrice")}</span>
              <Input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="$" />
            </label>
          </div>
          <Button type="submit" disabled={make.isPending || !f.name.trim()} className="w-full bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {make.isPending ? <Loader2 className="size-4 animate-spin" /> : null} {t("approvals.invoice.qbNewCreate")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
