import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDownToLine, BookOpenText, CheckCircle2, Copy, FileText, Link2, Loader2, Plus, RefreshCw, Search, Sparkles, Unlink, Users, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, Field, KEY, LastTest, Saved, SecretInput, useBillingError } from "./BillingSection";

/**
 * QuickBooks Online, in Admin › Integrations: the connection (Intuit sign-in), the two-way sync of the clients, the
 * chart of accounts and the vendors you choose, and what goes with it (invoices, payments, items).
 */
type LedgerType = "asset" | "liability" | "equity" | "revenue" | "expense";
const GOLD = "bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105";

type QuickBooks = {
  enabled: boolean;
  environment: "sandbox" | "production";
  clientId: string;
  hasSecret: boolean;
  connected: boolean;
  realmId: string | null;
  companyName: string | null;
  connectedAt: string | null;
  sync: { invoices: boolean; invoicesIn: boolean; payments: boolean; customers: boolean; accounts: boolean; vendors: boolean; bills: boolean; timesheets: boolean; expenses: boolean };
  runs: { clients?: SyncRun; accounts?: SyncRun; vendors?: SyncRun };
  invoicesFromNumber: number;
  invoicesFromDate: string | null;
  invoicesMode: "number" | "date";
  lastTest: { ok: boolean; at: string; error?: string } | null;
  redirectUri: string | null;
  invoice: { itemId: string | null; taxCodeId: string | null; exemptTaxCodeId: string | null };
  imports: { accounts?: { at: string; matched: number; created: number }; items?: { at: string; items: number; categories: number; products: number }; invoices?: { at: string; added: number; updated: number; unmapped: number; total: number } };
  paymentsPulledAt: string | null;
};
type SyncRun = { at: string; pulled: number; pushed: number; created: number; linked: number; failed: number; errors: string[] };
type QbCustomer = { id: string; name: string; email: string | null; phone: string | null; active: boolean };
type Mapping = { customers: QbCustomer[]; clients: { id: string; name: string; email: string | null; city: string | null; quickbooksId: string | null; suggestion: string | null; reason: "name" | "email" | null }[] };
type InvoiceDefaults = { items: { id: string; name: string; sku: string | null; type: string }[]; taxCodes: { id: string; name: string; description: string | null }[]; chosen: QuickBooks["invoice"] };

/** The card of the integrations list: where the connection stands */
export function QuickBooksStatus() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: [...KEY, "quickbooks"], queryFn: () => api.get<QuickBooks>("/billing/quickbooks") });
  if (!data) return null;
  const [key, tone] = !data.connected ? ["notConfigured", "muted"] : !data.enabled ? ["disabled", "muted"] : data.lastTest?.ok === false ? ["error", "bad"] : ["connected", "good"];
  return (
    <Badge variant="outline" className={cn("gap-1.5", tone === "good" && "border-emerald-500/40 text-emerald-400", tone === "bad" && "border-destructive/50 text-destructive", tone === "muted" && "text-muted-foreground")}>
      <span className="size-1.5 rounded-full bg-current" />
      {t(`integrations.status.${key}`)}
    </Badge>
  );
}

/** The page of the integration (?integration=quickbooks); it also takes the answer of the Intuit sign-in. */
export function QuickBooksPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const r = params.get("quickbooks");
    if (!r) return;
    if (r === "connected") toast.success(t("billing.qb.connectedToast"));
    else toast.error(t(r === "cancelled" ? "billing.qb.cancelled" : "billing.qb.failed"));
    setParams(
      (p) => {
        p.delete("quickbooks");
        return p;
      },
      { replace: true },
    );
  }, [params, setParams, t]);
  return <QuickBooksTab />;
}

function QuickBooksTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const confirm = useConfirm();
  const { data: q } = useQuery({ queryKey: [...KEY, "quickbooks"], queryFn: () => api.get<QuickBooks>("/billing/quickbooks") });
  const [f, setF] = useState({ clientId: "", clientSecret: "", environment: "sandbox" as QuickBooks["environment"] });
  useEffect(() => {
    if (q) setF({ clientId: q.clientId, clientSecret: "", environment: q.environment });
  }, [q]);
  const put = (p: Record<string, unknown>) => api.put<QuickBooks>("/billing/quickbooks", p);
  const done = (r: QuickBooks) => qc.setQueryData([...KEY, "quickbooks"], r);
  const save = useMutation({
    mutationFn: () => put({ clientId: f.clientId, environment: f.environment, ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}) }),
    onSuccess: (r) => {
      done(r);
      toast.success(t("billing.saved"));
    },
    onError: (e) => toast.error(err(e)),
  });
  const toggle = useMutation({ mutationFn: put, onSuccess: done, onError: (e) => toast.error(err(e)) });
  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>("/billing/quickbooks/connect"),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (e) => toast.error(err(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>("/billing/quickbooks/test"),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [...KEY, "quickbooks"] });
      if (r.ok) toast.success(t("billing.qb.testOk"));
      else toast.error(t("billing.testFailed", { error: r.error ?? "" }));
    },
  });
  const disconnect = useMutation({ mutationFn: () => api.del<QuickBooks>("/billing/quickbooks/connection"), onSuccess: done });
  if (!q) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-5">
      <Card
        title={t("billing.qb.connection")}
        text={t("billing.qb.connectionText")}
        aside={
          q.connected ? (
            <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">
              <CheckCircle2 className="size-3.5" /> {q.companyName ?? t("billing.qb.connected")}
            </span>
          ) : (
            <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">{t("billing.qb.notConnected")}</span>
          )
        }
      >
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label={t("billing.qb.environment")}>
            <Select value={f.environment} onValueChange={(v) => setF({ ...f, environment: v as QuickBooks["environment"] })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sandbox">{t("billing.qb.sandbox")}</SelectItem>
                <SelectItem value="production">{t("billing.qb.production")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("billing.qb.clientId")}>
            <Input value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
          </Field>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">
              {t("billing.qb.clientSecret")}
              <Saved on={q.hasSecret} />
            </Label>
            <SecretInput value={f.clientSecret} onChange={(v) => setF({ ...f, clientSecret: v })} saved={q.hasSecret} />
          </div>
          {q.redirectUri && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">{t("billing.qb.redirectUri")}</Label>
              <div className="flex gap-2">
                <Input readOnly value={q.redirectUri} className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={t("common.copy")}
                  onClick={() => {
                    void navigator.clipboard.writeText(q.redirectUri!);
                    toast.success(t("common.copied"));
                  }}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">{t("billing.qb.redirectHint")}</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit" variant="outline" disabled={save.isPending}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("billing.save")}
            </Button>
            {q.connected ? (
              <>
                <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("billing.test")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={async () => {
                    if (await confirm({ title: t("billing.qb.disconnect"), description: t("billing.qb.disconnectText"), confirmLabel: t("billing.qb.disconnect"), destructive: true })) disconnect.mutate();
                  }}
                >
                  <Unlink className="size-4" /> {t("billing.qb.disconnect")}
                </Button>
              </>
            ) : (
              <Button type="button" disabled={!q.clientId || !q.hasSecret || connect.isPending} onClick={() => connect.mutate()} className={GOLD}>
                {connect.isPending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />} {t("billing.qb.connect")}
              </Button>
            )}
          </div>
          {q.connected && (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {t("billing.qb.connectedInfo", { realm: q.realmId, at: q.connectedAt ? dateTime(q.connectedAt) : "—" })}
            </p>
          )}
          <div className="sm:col-span-2">
            <LastTest r={q.lastTest} />
          </div>
        </form>
      </Card>

      {q.connected && <TwoWayCard q={q} />}
      {q.connected && <QuickBooksData q={q} />}
      {q.connected && <VendorsCard />}

      <Card title={t("billing.qb.sync")} text={t("billing.qb.syncText")} aside={<Switch checked={q.enabled} disabled={!q.connected} onCheckedChange={(v) => toggle.mutate({ enabled: v })} aria-label={t("billing.enabled")} />}>
        <div className="grid gap-2 sm:grid-cols-3">
          {(["customers", "accounts", "vendors", "bills", "invoicesIn", "invoices", "payments", "timesheets", "expenses"] as const).map((k) => (
            <label key={k} className="flex items-start gap-2 rounded-xl border p-3 text-sm">
              {/* timesheets and expenses are paused (accounting marks them paid in the portal) */}
              <Switch
                checked={k === "timesheets" || k === "expenses" ? false : q.sync[k]}
                disabled={k === "timesheets" || k === "expenses"}
                onCheckedChange={(v) => toggle.mutate({ sync: { [k]: v } })}
              />
              <span>
                <span className="block font-medium">{t(`billing.qb.syncItems.${k}`)}</span>
                <span className="block text-[11px] text-muted-foreground">{t(`billing.qb.syncItems.${k}Text`)}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">{t("billing.qb.syncNow")}</p>
      </Card>
    </div>
  );
}

/** Once connected: invoice defaults, imports (chart, items), clients ↔ customers, payments. */
function QuickBooksData({ q }: { q: QuickBooks }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const [review, setReview] = useState<"accounts" | "items" | null>(null);
  const pull = useMutation({
    mutationFn: () => api.post<{ added: number; updated: number }>("/billing/quickbooks/payments/pull"),
    onSuccess: (r) => {
      refresh();
      void qc.invalidateQueries({ queryKey: ["crm"] });
      toast.success(t("billing.qb.paymentsDone", r));
    },
    onError: (e) => toast.error(err(e)),
  });
  return (
    <>
      <Card title={t("billing.qb.importTitle")} text={t("billing.qb.importText")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2 rounded-xl border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <BookOpenText className="size-4 text-primary" /> {t("billing.qb.importAccounts")}
            </p>
            <p className="text-[11px] text-muted-foreground">{t("billing.qb.importAccountsText")}</p>
            {q.imports.accounts && <p className="text-[11px] text-emerald-400">{t("billing.qb.accountsLast", { ...q.imports.accounts, at: dateTime(q.imports.accounts.at) })}</p>}
            <Button size="sm" variant="outline" onClick={() => setReview("accounts")}>
              <ArrowDownToLine className="size-3.5" /> {t("billing.qb.review")}
            </Button>
          </div>
          <div className="space-y-2 rounded-xl border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <FileText className="size-4 text-primary" /> {t("billing.qb.importItems")}
            </p>
            <p className="text-[11px] text-muted-foreground">{t("billing.qb.importItemsText")}</p>
            {q.imports.items && <p className="text-[11px] text-emerald-400">{t("billing.qb.itemsLast", { ...q.imports.items, at: dateTime(q.imports.items.at) })}</p>}
            <Button size="sm" variant="outline" onClick={() => setReview("items")}>
              <ArrowDownToLine className="size-3.5" /> {t("billing.qb.review")}
            </Button>
          </div>
        </div>
      </Card>
      {review === "accounts" && <AccountsReview onClose={() => setReview(null)} />}
      {review === "items" && <ItemsReview onClose={() => setReview(null)} />}
      <MappingCard />
      <InvoicesInCard q={q} />
      <InvoiceDefaultsCard />
      <Card
        title={t("billing.qb.paymentsTitle")}
        text={t("billing.qb.paymentsText")}
        aside={
          <Button size="sm" variant="outline" disabled={pull.isPending} onClick={() => pull.mutate()}>
            {pull.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Wallet className="size-3.5" />} {t("billing.qb.pullNow")}
          </Button>
        }
      >
        <p className="text-xs text-muted-foreground">{q.paymentsPulledAt ? t("billing.qb.pulledAt", { at: dateTime(q.paymentsPulledAt) }) : t("billing.qb.neverPulled")}</p>
      </Card>
    </>
  );
}

/** QuickBooks invoices brought in from a number on, with their status; for the clients mapped to a customer. */
function InvoicesInCard({ q }: { q: QuickBooks }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const [from, setFrom] = useState(String(q.invoicesFromNumber));
  const [date, setDate] = useState(q.invoicesFromDate ?? "");
  useEffect(() => setFrom(String(q.invoicesFromNumber)), [q.invoicesFromNumber]);
  useEffect(() => setDate(q.invoicesFromDate ?? ""), [q.invoicesFromDate]);
  const save = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.put<QuickBooks>("/billing/quickbooks", p),
    onSuccess: (r) => {
      qc.setQueryData([...KEY, "quickbooks"], r);
      void qc.invalidateQueries({ queryKey: [...KEY, "qb-invoice-preview"] });
    },
    onError: (e) => toast.error(err(e)),
  });
  const preview = useQuery({
    queryKey: [...KEY, "qb-invoice-preview", q.invoicesMode, q.invoicesFromNumber, q.invoicesFromDate],
    queryFn: () => api.get<{ total: number; unmapped: number; firstNumber: number | null; lastNumber: number | null; firstDate: string | null }>("/billing/quickbooks/invoices/preview"),
    retry: false,
    staleTime: 30_000,
  });
  const numbering = useQuery({
    queryKey: [...KEY, "qb-numbering"],
    queryFn: () => api.get<{ portalNext: number; qbNext: number; qbHighest: number; status: "aligned" | "behind" | "ahead" }>("/billing/quickbooks/numbering"),
    retry: false,
  });
  const align = useMutation({
    mutationFn: () => api.post<{ portalNext: number; qbNext: number; raised: boolean }>("/billing/quickbooks/numbering/align"),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [...KEY, "qb-numbering"] });
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(r.raised ? t("billing.qb.numbering.raised", { next: r.portalNext }) : t("billing.qb.numbering.already"));
    },
    onError: (e) => toast.error(err(e)),
  });
  const pull = useMutation({
    mutationFn: () => api.post<{ added: number; updated: number; unmapped: number; total: number }>("/billing/quickbooks/invoices/pull"),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      toast.success(t("billing.qb.invoicesInDone", r));
    },
    onError: (e) => toast.error(err(e)),
  });
  const commit = () => {
    const n = Number(from.replace(/\D/g, ""));
    if (!Number.isFinite(n) || from.trim() === "") return setFrom(String(q.invoicesFromNumber));
    if (n !== q.invoicesFromNumber) save.mutate({ invoicesFromNumber: n });
  };
  const mode = q.invoicesMode;
  const p = preview.data;
  const nb = numbering.data;
  return (
    <Card
      title={t("billing.qb.invoicesInTitle")}
      text={t("billing.qb.invoicesInText")}
      aside={
        <Button size="sm" variant="outline" disabled={pull.isPending || (mode === "date" && !q.invoicesFromDate)} onClick={() => pull.mutate()}>
          {pull.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowDownToLine className="size-3.5" />} {t("billing.qb.invoicesInPull")}
        </Button>
      }
    >
      {/* where the first copy starts: an invoice number, or a day */}
      <div className="space-y-3">
        <p className="text-xs font-medium text-muted-foreground">{t("billing.qb.invoicesStart")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["number", "date"] as const).map((m) => (
            <div key={m} className={cn("space-y-2 rounded-xl border p-3 transition-colors", mode === m && "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/[0.05]")}>
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input type="radio" name="qb-invoices-mode" checked={mode === m} onChange={() => save.mutate({ invoicesMode: m })} className="accent-[color:var(--gold)]" />
                {t(`billing.qb.invoicesMode.${m}`)}
              </label>
              {m === "number" ? (
                <Input value={from} disabled={mode !== "number"} onChange={(e) => setFrom(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} inputMode="numeric" className="w-40 font-mono" placeholder="10000" />
              ) : (
                <Input type="date" value={date} disabled={mode !== "date"} onChange={(e) => setDate(e.target.value)} onBlur={() => date !== (q.invoicesFromDate ?? "") && save.mutate({ invoicesFromDate: date || null })} className="w-44" />
              )}
              <p className="text-[11px] text-muted-foreground">{t(`billing.qb.invoicesMode.${m}Hint`)}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {preview.isLoading ? <Loader2 className="inline size-3 animate-spin" /> : p ? t("billing.qb.invoicesPreview", { total: p.total, first: p.firstNumber ?? "—", last: p.lastNumber ?? "—", unmapped: p.unmapped }) : ""}
        </p>
        <p className="text-xs text-muted-foreground">{q.imports.invoices ? t("billing.qb.invoicesInLast", { ...q.imports.invoices, when: dateTime(q.imports.invoices.at) }) : t("billing.qb.invoicesInNever")}</p>
      </div>

      {/* the next invoice number: the same here as in QuickBooks */}
      <div className="space-y-2 rounded-xl border p-3">
        <p className="text-sm font-medium">{t("billing.qb.numbering.title")}</p>
        {nb ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span>
              {t("billing.qb.numbering.portal")} <span className="font-mono font-semibold">{nb.portalNext}</span>
            </span>
            <span>
              QuickBooks <span className="font-mono font-semibold">{nb.qbNext}</span>
            </span>
            <span className={cn("flex items-center gap-1 text-xs", nb.status === "aligned" ? "text-emerald-400" : nb.status === "behind" ? "text-orange-300" : "text-sky-300")}>
              {nb.status === "aligned" && <CheckCircle2 className="size-3.5" />} {t(`billing.qb.numbering.${nb.status}`)}
            </span>
            {nb.status === "behind" && (
              <Button size="sm" variant="outline" className="h-8" disabled={align.isPending} onClick={() => align.mutate()}>
                {align.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("billing.qb.numbering.align")}
              </Button>
            )}
          </div>
        ) : numbering.isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <p className="text-xs text-destructive">{err(numbering.error)}</p>
        )}
        <p className="text-[11px] text-muted-foreground">{t("billing.qb.numbering.hint")}</p>
      </div>
    </Card>
  );
}

type AccountProposal = {
  key: string;
  action: "same" | "link" | "update" | "create" | "deactivate";
  reason?: "linked" | "number" | "name";
  qb?: { id: string; number: string | null; name: string; type: LedgerType };
  local?: { id: string; number: string; name: string; type: string; active: boolean };
  changes: { name?: { from: string; to: string }; number?: { from: string; to: string }; type?: { from: string; to: string }; active?: { from: boolean; to: boolean } };
  blocked?: "in_use";
};
type ItemsPlan = {
  categories: { id: string; name: string; isNew: boolean; products: number }[];
  items: { total: number; isNew: number };
  products: { key: string; action: "same" | "link" | "update"; product: { id: string; sku: string; name: string; category: string | null }; item: { id: string; name: string; sku: string; category: string | null }; changes: { category?: { from: string | null; to: string | null }; link?: { from: string | null; to: string | null } } }[];
};

/** A window listing proposed changes, each one to accept or not. */
function ReviewDialog({ title, text, loading, error, children, footer, onClose }: { title: string; text: string; loading: boolean; error: unknown; children: ReactNode; footer: ReactNode; onClose: () => void }) {
  const err = useBillingError();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{text}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 scrollbar-thin">
          {loading && <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />}
          {error ? <p className="text-sm text-destructive">{err(error)}</p> : null}
          {children}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">{footer}</div>
      </DialogContent>
    </Dialog>
  );
}

function useChecked(initial: string[] | null) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (initial && !ready) {
      setSel(new Set(initial));
      setReady(true);
    }
  }, [initial, ready]);
  const toggle = (k: string, on: boolean) => setSel((s) => (on ? new Set([...s, k]) : new Set([...s].filter((x) => x !== k))));
  const setMany = (keys: string[], on: boolean) => setSel((s) => (on ? new Set([...s, ...keys]) : new Set([...s].filter((x) => !keys.includes(x)))));
  return { sel, toggle, setMany };
}

const ACTION_STYLE: Record<string, string> = {
  link: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  update: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  create: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  deactivate: "border-red-500/40 bg-red-500/10 text-red-300",
};

function AccountsReview({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const { data, isLoading, error } = useQuery({ queryKey: [...KEY, "plan-accounts"], queryFn: () => api.get<AccountProposal[]>("/billing/quickbooks/plan/accounts"), retry: false, gcTime: 0 });
  // proposed by default: tie, update and add; turning off is chosen by hand
  const { sel, toggle, setMany } = useChecked(data ? data.filter((p) => ["link", "update", "create"].includes(p.action)).map((p) => p.key) : null);
  const apply = useMutation({
    mutationFn: () => api.post<{ linked: number; updated: number; created: number; deactivated: number }>("/billing/quickbooks/plan/accounts", { accept: [...sel] }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t("billing.qb.accountsApplied", r));
      onClose();
    },
    onError: (e) => toast.error(err(e)),
  });
  const groups = (["link", "update", "create", "deactivate"] as const).map((a) => ({ a, rows: (data ?? []).filter((p) => p.action === a) })).filter((g) => g.rows.length);
  const same = (data ?? []).filter((p) => p.action === "same").length;
  const typeName = (x: string) => t(`billing.ledger.types.${x}`, { defaultValue: x });
  return (
    <ReviewDialog
      title={t("billing.qb.reviewAccountsTitle")}
      text={t("billing.qb.reviewAccountsText")}
      loading={isLoading}
      error={error}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-xs text-muted-foreground">{t("billing.qb.selected", { count: sel.size })}</span>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!sel.size || apply.isPending} onClick={() => apply.mutate()} className={GOLD}>
            {apply.isPending && <Loader2 className="size-4 animate-spin" />} {t("billing.qb.accept")}
          </Button>
        </>
      }
    >
      {data && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2 className="size-3.5" /> {t("billing.qb.sameCount", { count: same })}
        </p>
      )}
      {data && !groups.length && <p className="py-6 text-center text-sm text-muted-foreground">{t("billing.qb.nothingToDo")}</p>}
      {groups.map((g) => {
        const keys = g.rows.filter((r) => !r.blocked).map((r) => r.key);
        const all = keys.length > 0 && keys.every((k) => sel.has(k));
        return (
          <section key={g.a} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Checkbox checked={all ? true : keys.some((k) => sel.has(k)) ? "indeterminate" : false} disabled={!keys.length} onCheckedChange={(v) => setMany(keys, Boolean(v))} />
              <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-semibold", ACTION_STYLE[g.a])}>{t(`billing.qb.actions.${g.a}`)}</span>
              <span className="text-xs text-muted-foreground">{t(`billing.qb.actionsText.${g.a}`)}</span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">{g.rows.length}</span>
            </div>
            <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
              {g.rows.map((p) => (
                <li key={p.key}>
                  <label className={cn("flex items-start gap-3 px-3 py-2 text-sm", p.blocked ? "opacity-60" : "cursor-pointer hover:bg-accent/30")}>
                    <Checkbox className="mt-0.5" disabled={Boolean(p.blocked)} checked={sel.has(p.key)} onCheckedChange={(v) => toggle(p.key, Boolean(v))} />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex flex-wrap items-center gap-x-2">
                        {p.local && (
                          <span>
                            <span className="font-mono text-xs">{p.local.number}</span> {p.local.name}
                          </span>
                        )}
                        {p.local && p.qb && <span className="text-muted-foreground">↔</span>}
                        {p.qb && (
                          <span className="text-emerald-300">
                            QuickBooks : {p.qb.number && <span className="font-mono text-xs">{p.qb.number} </span>}
                            {p.qb.name} <span className="text-[11px] text-muted-foreground">({typeName(p.qb.type)})</span>
                          </span>
                        )}
                        {p.reason && p.reason !== "linked" && <span className="rounded border px-1 text-[10px] text-muted-foreground">{t(`billing.qb.reasons.${p.reason}`)}</span>}
                      </span>
                      {(p.changes.name || p.changes.number || p.changes.type) && (
                        <span className="block text-[11px] text-amber-300">
                          {[
                            p.changes.number && p.action !== "create" && t("billing.qb.changeNumber", p.changes.number),
                            p.changes.name && t("billing.qb.changeName", p.changes.name),
                            p.changes.type && t("billing.qb.changeType", { from: typeName(p.changes.type.from), to: typeName(p.changes.type.to) }),
                            p.action === "create" && p.changes.number && t("billing.qb.createAs", { number: p.changes.number.to }),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                      {p.blocked && <span className="block text-[11px] text-muted-foreground">{t("billing.qb.blockedInUse")}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </ReviewDialog>
  );
}

function ItemsReview({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const { data, isLoading, error } = useQuery({ queryKey: [...KEY, "plan-items"], queryFn: () => api.get<ItemsPlan>("/billing/quickbooks/plan/items"), retry: false, gcTime: 0 });
  const todo = (data?.products ?? []).filter((p) => p.action !== "same");
  const { sel, toggle, setMany } = useChecked(data ? todo.map((p) => p.key) : null);
  const apply = useMutation({
    mutationFn: () => api.post<{ items: number; categories: number; products: number }>("/billing/quickbooks/plan/items", { accept: [...sel] }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t("billing.qb.itemsDone", r));
      onClose();
    },
    onError: (e) => toast.error(err(e)),
  });
  const keys = todo.map((p) => p.key);
  return (
    <ReviewDialog
      title={t("billing.qb.reviewItemsTitle")}
      text={t("billing.qb.reviewItemsText")}
      loading={isLoading}
      error={error}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-xs text-muted-foreground">{t("billing.qb.selected", { count: sel.size })}</span>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!data || apply.isPending} onClick={() => apply.mutate()} className={GOLD}>
            {apply.isPending && <Loader2 className="size-4 animate-spin" />} {t("billing.qb.accept")}
          </Button>
        </>
      }
    >
      {data && (
        <>
          <section className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("billing.qb.categories", { count: data.categories.length })}</p>
            <div className="flex flex-wrap gap-1.5">
              {data.categories.map((c) => (
                <span key={c.id} className={cn("rounded-md border px-2 py-0.5 text-xs", c.isNew && "border-emerald-500/40 text-emerald-300")}>
                  {c.name} <span className="text-[10px] text-muted-foreground">· {c.products}</span>
                  {c.isNew && <span className="ml-1 text-[10px]">{t("billing.qb.new")}</span>}
                </span>
              ))}
              {!data.categories.length && <span className="text-xs text-muted-foreground">—</span>}
            </div>
            <p className="text-[11px] text-muted-foreground">{t("billing.qb.itemsCount", data.items)}</p>
          </section>
          <section className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Checkbox checked={keys.length > 0 && keys.every((k) => sel.has(k)) ? true : keys.some((k) => sel.has(k)) ? "indeterminate" : false} disabled={!keys.length} onCheckedChange={(v) => setMany(keys, Boolean(v))} />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("billing.qb.productsTitle", { count: todo.length })}</span>
            </div>
            {!todo.length && <p className="text-xs text-muted-foreground">{t("billing.qb.productsNone")}</p>}
            {todo.length > 0 && (
              <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
                {todo.map((p) => (
                  <li key={p.key}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm hover:bg-accent/30">
                      <Checkbox className="mt-0.5" checked={sel.has(p.key)} onCheckedChange={(v) => toggle(p.key, Boolean(v))} />
                      <span className="min-w-0 flex-1">
                        <span className="block">
                          <span className="font-mono text-xs">{p.product.sku}</span> {p.product.name} <span className="text-muted-foreground">↔</span> <span className="text-emerald-300">QuickBooks : {p.item.name}</span>
                        </span>
                        {p.changes.category && <span className="block text-[11px] text-amber-300">{t("billing.qb.changeCategory", { from: p.changes.category.from ?? "—", to: p.changes.category.to ?? "—" })}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </ReviewDialog>
  );
}

function MappingReview({ data, onClose }: { data: Mapping; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const rows = data.clients.filter((c) => !c.quickbooksId && c.suggestion);
  const byId = new Map(data.customers.map((c) => [c.id, c]));
  const { sel, toggle, setMany } = useChecked(rows.map((r) => r.id));
  const apply = useMutation({
    mutationFn: () => api.post<{ mapped: number; skipped: string[] }>("/billing/quickbooks/mapping/accept", { accept: rows.filter((r) => sel.has(r.id)).map((r) => ({ clientId: r.id, quickbooksId: r.suggestion! })) }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [...KEY, "qb-mapping"] });
      toast.success(t("billing.qb.autoDone", { count: r.mapped }));
      onClose();
    },
    onError: (e) => toast.error(err(e)),
  });
  const keys = rows.map((r) => r.id);
  return (
    <ReviewDialog
      title={t("billing.qb.reviewMappingTitle")}
      text={t("billing.qb.reviewMappingText")}
      loading={false}
      error={null}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-xs text-muted-foreground">{t("billing.qb.selected", { count: sel.size })}</span>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!sel.size || apply.isPending} onClick={() => apply.mutate()} className={GOLD}>
            {apply.isPending && <Loader2 className="size-4 animate-spin" />} {t("billing.qb.accept")}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <Checkbox checked={keys.length > 0 && keys.every((k) => sel.has(k)) ? true : keys.some((k) => sel.has(k)) ? "indeterminate" : false} onCheckedChange={(v) => setMany(keys, Boolean(v))} />
        <span className="text-xs text-muted-foreground">{t("billing.qb.selectAll")}</span>
      </div>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
        {rows.map((r) => {
          const q = byId.get(r.suggestion!);
          return (
            <li key={r.id}>
              <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-sm hover:bg-accent/30">
                <Checkbox checked={sel.has(r.id)} onCheckedChange={(v) => toggle(r.id, Boolean(v))} />
                <span className="min-w-0">
                  <span className="block truncate">{r.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{r.email ?? r.city ?? ""}</span>
                </span>
                <span className="text-muted-foreground">↔</span>
                <span className="min-w-0">
                  <span className="block truncate text-emerald-300">{q?.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{q?.email ?? ""}</span>
                </span>
                <span className="rounded border px-1 text-[10px] text-muted-foreground">{t(`billing.qb.reasons.${r.reason ?? "name"}`)}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </ReviewDialog>
  );
}

function InvoiceDefaultsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const { data, isLoading, error } = useQuery({ queryKey: [...KEY, "qb-defaults"], queryFn: () => api.get<InvoiceDefaults>("/billing/quickbooks/invoice-defaults"), retry: false });
  const save = useMutation({
    mutationFn: (p: Partial<QuickBooks["invoice"]>) => api.put<QuickBooks["invoice"]>("/billing/quickbooks/invoice-defaults", p),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, "qb-defaults"] });
      toast.success(t("billing.saved"));
    },
    onError: (e) => toast.error(err(e)),
  });
  const pick = (k: keyof QuickBooks["invoice"], label: string, list: { id: string; name: string }[], hint?: string) => (
    <Field label={label} hint={hint}>
      <Select value={data?.chosen[k] ?? "none"} onValueChange={(v) => save.mutate({ [k]: v === "none" ? null : v })}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-72">
          <SelectItem value="none">—</SelectItem>
          {list.map((x) => (
            <SelectItem key={x.id} value={x.id}>
              {x.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
  return (
    <Card title={t("billing.qb.defaultsTitle")} text={t("billing.qb.defaultsText")}>
      {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {error && <p className="text-xs text-destructive">{err(error)}</p>}
      {data && (
        <div className="grid gap-3 sm:grid-cols-3">
          {pick("itemId", t("billing.qb.item"), data.items.map((i) => ({ id: i.id, name: i.sku ? `${i.name} (${i.sku})` : i.name })), data.items.length ? undefined : t("billing.qb.importItemsFirst"))}
          {pick("taxCodeId", t("billing.qb.taxCode"), data.taxCodes)}
          {pick("exemptTaxCodeId", t("billing.qb.exemptTaxCode"), data.taxCodes)}
        </div>
      )}
    </Card>
  );
}

function MappingCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const [q, setQ] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(true);
  const { data, isLoading, error } = useQuery({ queryKey: [...KEY, "qb-mapping"], queryFn: () => api.get<Mapping>("/billing/quickbooks/mapping"), retry: false });
  const refresh = () => void qc.invalidateQueries({ queryKey: [...KEY, "qb-mapping"] });
  const map = useMutation({
    mutationFn: ({ clientId, quickbooksId }: { clientId: string; quickbooksId: string | null }) => api.put(`/billing/quickbooks/mapping/${clientId}`, { quickbooksId }),
    onSuccess: refresh,
    onError: (e) => toast.error(err(e)),
  });
  const [reviewing, setReviewing] = useState(false);
  const create = useMutation({
    mutationFn: (clientId: string) => api.post<QbCustomer>(`/billing/quickbooks/mapping/${clientId}/create`),
    onSuccess: (c) => {
      refresh();
      toast.success(t("billing.qb.created", { name: c.name }));
    },
    onError: (e) => toast.error(err(e)),
  });
  const byId = new Map((data?.customers ?? []).map((c) => [c.id, c]));
  const used = new Set((data?.clients ?? []).map((c) => c.quickbooksId).filter(Boolean));
  const shown = (data?.clients ?? []).filter((c) => (!onlyOpen || !c.quickbooksId) && c.name.toLowerCase().includes(q.toLowerCase()));
  const mapped = (data?.clients ?? []).filter((c) => c.quickbooksId).length;
  const sure = (data?.clients ?? []).filter((c) => c.suggestion).length;
  return (
    <Card
      title={t("billing.qb.mappingTitle")}
      text={t("billing.qb.mappingText")}
      aside={
        <Button size="sm" disabled={!sure} onClick={() => setReviewing(true)} className={GOLD}>
          <Sparkles className="size-3.5" /> {t("billing.qb.auto", { count: sure })}
        </Button>
      }
    >
      {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {error && <p className="text-xs text-destructive">{err(error)}</p>}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="size-3.5" /> {t("billing.qb.mappedCount", { mapped, total: data.clients.length, customers: data.customers.length })}
            </span>
            <div className="relative ml-auto w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} className="h-8 pl-8" />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch checked={onlyOpen} onCheckedChange={setOnlyOpen} /> {t("billing.qb.onlyUnmapped")}
            </label>
          </div>
          <ul className="max-h-[28rem] divide-y divide-border/60 overflow-y-auto rounded-xl border scrollbar-thin">
            {shown.map((c) => (
              <li key={c.id} className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{c.name}</span>
                  {c.city && <span className="block truncate text-[11px] text-muted-foreground">{c.city}</span>}
                </span>
                <Select value={c.quickbooksId ?? "none"} onValueChange={(v) => map.mutate({ clientId: c.id, quickbooksId: v === "none" ? null : v })}>
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" className="max-h-72">
                    <SelectItem value="none">{t("billing.qb.notMapped")}</SelectItem>
                    {data.customers
                      .filter((x) => x.id === c.quickbooksId || !used.has(x.id))
                      .map((x) => (
                        <SelectItem key={x.id} value={x.id}>
                          {x.name}
                          {x.id === c.suggestion ? ` — ${t("billing.qb.suggested")}` : ""}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <span className="flex justify-end gap-1">
                  {!c.quickbooksId && c.suggestion && (
                    <Button size="sm" variant="ghost" className="h-8 text-xs text-primary" onClick={() => map.mutate({ clientId: c.id, quickbooksId: c.suggestion })} title={byId.get(c.suggestion)?.name}>
                      <Sparkles className="size-3.5" /> {t("billing.qb.useSuggestion")}
                    </Button>
                  )}
                  {!c.quickbooksId && !c.suggestion && (
                    <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={create.isPending} onClick={() => create.mutate(c.id)}>
                      <Plus className="size-3.5" /> {t("billing.qb.createCustomer")}
                    </Button>
                  )}
                  {c.quickbooksId && <CheckCircle2 className="size-4 text-emerald-400" />}
                </span>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted-foreground">{t("billing.qb.allMapped")}</li>}
          </ul>
          {reviewing && <MappingReview data={data} onClose={() => setReviewing(false)} />}
        </>
      )}
    </Card>
  );
}


/** The two-way sync: what is kept in step, how, and when it last ran */
function TwoWayCard({ q }: { q: QuickBooks }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const run = useMutation({
    mutationFn: () => api.post("/billing/quickbooks/sync", {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      void qc.invalidateQueries({ queryKey: ["admin", "vendors"] });
      toast.success(t("billing.qb.twoWay.done"));
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "quickbooks_sync_running" ? t("billing.qb.twoWay.running") : err(e)),
  });
  const rows = [
    ["clients", "customers", Users],
    ["accounts", "accounts", BookOpenText],
    ["vendors", "vendors", Wallet],
  ] as const;
  return (
    <Card
      title={t("billing.qb.twoWay.title")}
      text={t("billing.qb.twoWay.text")}
      aside={
        <Button size="sm" variant="outline" disabled={run.isPending || !q.enabled} onClick={() => run.mutate()}>
          {run.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("billing.qb.twoWay.now")}
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-3">
        {rows.map(([part, flag, Icon]) => {
          const r = q.runs[part];
          const on = q.enabled && q.sync[flag];
          return (
            <div key={part} className="space-y-1.5 rounded-xl border p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4 text-primary" /> {t(`billing.qb.twoWay.${part}`)}
                <span className={cn("ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium", on ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground")}>{on ? t("billing.qb.twoWay.on") : t("billing.qb.twoWay.off")}</span>
              </p>
              <p className="text-[11px] text-muted-foreground">{t(`billing.qb.twoWay.${part}Text`)}</p>
              {r ? (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    {dateTime(r.at)} · {t("billing.qb.twoWay.counts", { pulled: r.pulled, pushed: r.pushed, created: r.created + r.linked })}
                  </p>
                  {r.failed > 0 && (
                    <p className="text-[11px] text-destructive" title={r.errors.join("\n")}>
                      {t("billing.qb.twoWay.failed", { count: r.failed })}
                      {r.errors[0] ? ` — ${r.errors[0]}` : ""}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground">{t("billing.qb.twoWay.never")}</p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">{t("billing.qb.twoWay.rule")}</p>
    </Card>
  );
}

type VendorList = { vendors: { id: string; name: string; email: string | null; phone: string | null; active: boolean; selected: boolean; portalId: string | null }[]; portalOnly: { id: string; name: string }[] };

/** The QuickBooks vendors to keep in step with the portal's: tick the ones you want, save */
function VendorsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const { data, isLoading, error } = useQuery({ queryKey: [...KEY, "qb-vendors"], queryFn: () => api.get<VendorList>("/billing/quickbooks/vendors"), retry: false });
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [search, setSearch] = useState("");
  const chosen = sel ?? new Set((data?.vendors ?? []).filter((v) => v.selected).map((v) => v.id));
  const dirty = Boolean(data && sel && (sel.size !== data.vendors.filter((v) => v.selected).length || data.vendors.some((v) => v.selected !== sel.has(v.id))));
  const save = useMutation({
    mutationFn: () => api.put<{ tied: number; created: number; untied: number }>("/billing/quickbooks/vendors/selection", { ids: [...chosen] }),
    onSuccess: (r) => {
      setSel(null);
      void qc.invalidateQueries({ queryKey: [...KEY, "qb-vendors"] });
      void qc.invalidateQueries({ queryKey: [...KEY, "quickbooks"] });
      void qc.invalidateQueries({ queryKey: ["admin", "vendors"] });
      toast.success(t("billing.qb.vendors.saved", r));
    },
    onError: (e) => toast.error(err(e)),
  });
  const create = useMutation({
    mutationFn: (id: string) => api.post(`/billing/quickbooks/vendors/${id}/create`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, "qb-vendors"] });
      void qc.invalidateQueries({ queryKey: ["admin", "vendors"] });
      toast.success(t("billing.qb.vendors.created"));
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "quickbooks_customer_exists" ? t("billing.qb.vendors.exists") : err(e)),
  });
  const q = search.trim().toLowerCase();
  const shown = (data?.vendors ?? []).filter((v) => !q || v.name.toLowerCase().includes(q));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setSel(next);
  };
  return (
    <Card
      title={t("billing.qb.vendors.title")}
      text={t("billing.qb.vendors.text")}
      aside={
        <Button size="sm" className={GOLD} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("common.save")}
        </Button>
      }
    >
      {isLoading ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : error || !data ? (
        <p className="text-sm text-destructive">{err(error)}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("billing.qb.vendors.search")} className="h-9 pl-8" />
            </div>
            <span className="text-xs text-muted-foreground">{t("billing.qb.vendors.count", { chosen: chosen.size, total: data.vendors.length })}</span>
            <Button size="sm" variant="ghost" className="ml-auto h-8 text-xs" onClick={() => setSel(new Set(shown.map((v) => v.id).concat([...chosen])))}>
              {t("billing.qb.vendors.all")}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setSel(new Set([...chosen].filter((id) => !shown.some((v) => v.id === id))))}>
              {t("billing.qb.vendors.none")}
            </Button>
          </div>
          <ul className="max-h-80 divide-y divide-[color:var(--glass-border)] overflow-y-auto rounded-xl border">
            {shown.map((v) => (
              <li key={v.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/30">
                  <Checkbox checked={chosen.has(v.id)} onCheckedChange={(x) => toggle(v.id, x === true)} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-sm font-medium", !v.active && "text-muted-foreground line-through")}>{v.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{[v.email, v.phone].filter(Boolean).join(" · ") || "—"}</span>
                  </span>
                  {v.selected && <span className="shrink-0 text-[10px] text-emerald-400">{t("billing.qb.vendors.inStep")}</span>}
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">{t("billing.qb.vendors.none404")}</li>}
          </ul>
          {data.portalOnly.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("billing.qb.vendors.portalOnly")}</p>
              <ul className="divide-y divide-[color:var(--glass-border)] rounded-xl border">
                {data.portalOnly.map((v) => (
                  <li key={v.id} className="flex items-center gap-3 px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm">{v.name}</span>
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={create.isPending} onClick={() => create.mutate(v.id)}>
                      <Plus className="size-3" /> {t("billing.qb.vendors.create")}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
