import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDownToLine, BookOpenText, CheckCircle2, Copy, CreditCard, FileText, Hash, Link2, Loader2, Plus, RefreshCw, Search, Sparkles, Unlink, Users, Wallet, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";
import { dateTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";

type Settings = {
  numbering: { prefix: string; next: number; digits: number };
  taxes: { gstNumber: string; qstNumber: string; gstRate: number; qstRate: number };
  company: { legalName: string; address: string; phone: string; email: string; website: string };
  template: { language: "fr" | "en"; termsDays: number; footer: string; paymentInstructions: string; showPaymentLink: boolean };
  accounts: Record<AccountUse, string | null>;
  preview: string;
};
type AccountUse = "receivable" | "bank" | "labour" | "charges" | "contracts" | "gst" | "qst";
const ACCOUNT_USES: AccountUse[] = ["receivable", "bank", "labour", "charges", "contracts", "gst", "qst"];
type LedgerType = "asset" | "liability" | "equity" | "revenue" | "expense";
const LEDGER_TYPES: LedgerType[] = ["asset", "liability", "equity", "revenue", "expense"];
type Account = { id: string; number: string; name: string; type: LedgerType; active: boolean; quickbooksId: string | null };
type QuickBooks = {
  enabled: boolean;
  environment: "sandbox" | "production";
  clientId: string;
  hasSecret: boolean;
  connected: boolean;
  realmId: string | null;
  companyName: string | null;
  connectedAt: string | null;
  sync: { invoices: boolean; payments: boolean; customers: boolean };
  lastTest: { ok: boolean; at: string; error?: string } | null;
  redirectUri: string | null;
  invoice: { itemId: string | null; taxCodeId: string | null; exemptTaxCodeId: string | null };
  imports: { accounts?: { at: string; matched: number; created: number }; items?: { at: string; items: number; categories: number; products: number } };
  paymentsPulledAt: string | null;
};
type QbCustomer = { id: string; name: string; email: string | null; phone: string | null; active: boolean };
type Mapping = { customers: QbCustomer[]; clients: { id: string; name: string; email: string | null; city: string | null; quickbooksId: string | null; suggestion: string | null }[] };
type InvoiceDefaults = { items: { id: string; name: string; sku: string | null; type: string }[]; taxCodes: { id: string; name: string; description: string | null }[]; chosen: QuickBooks["invoice"] };
type Stripe = { enabled: boolean; publishableKey: string; paymentLinks: boolean; hasSecretKey: boolean; hasWebhookSecret: boolean; mode: "test" | "live" | null; lastTest: { ok: boolean; at: string; error?: string } | null };

const KEY = ["admin", "billing"];
const GOLD = "bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105";
const TABS = ["general", "template", "ledger", "quickbooks", "stripe"] as const;
type Tab = (typeof TABS)[number];

function useBillingError() {
  const { t } = useTranslation();
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "";
    const detail = e instanceof ApiError ? e.fields?.find((f) => f.path === "quickbooks")?.message : undefined;
    return t(`billing.errors.${code}`, { defaultValue: t("common.error"), detail: detail ?? "" });
  };
}

/** Admin › Facturation: how invoices are numbered, taxed, laid out, booked and paid. */
export function BillingSection() {
  const { t } = useTranslation();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const money = can("admin.integrations");
  const tabs = TABS.filter((x) => money || (x !== "quickbooks" && x !== "stripe"));
  const tab = (tabs as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "general";

  // back from the Intuit sign-in
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

  return (
    <div>
      <SectionHeader title={t("billing.title")} subtitle={t("billing.subtitle")} />
      <Tabs
        value={tab}
        onValueChange={(v) =>
          setParams(
            (p) => {
              p.set("tab", v);
              return p;
            },
            { replace: true },
          )
        }
      >
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="general">
            <Hash className="size-4" /> {t("billing.tabs.general")}
          </TabsTrigger>
          <TabsTrigger value="template">
            <FileText className="size-4" /> {t("billing.tabs.template")}
          </TabsTrigger>
          <TabsTrigger value="ledger">
            <BookOpenText className="size-4" /> {t("billing.tabs.ledger")}
          </TabsTrigger>
          {money && (
            <>
              <TabsTrigger value="quickbooks">
                <RefreshCw className="size-4" /> QuickBooks
              </TabsTrigger>
              <TabsTrigger value="stripe">
                <CreditCard className="size-4" /> Stripe
              </TabsTrigger>
            </>
          )}
        </TabsList>
        <TabsContent value="general" className="mt-5">
          <GeneralTab />
        </TabsContent>
        <TabsContent value="template" className="mt-5">
          <TemplateTab />
        </TabsContent>
        <TabsContent value="ledger" className="mt-5">
          <LedgerTab />
        </TabsContent>
        {money && (
          <>
            <TabsContent value="quickbooks" className="mt-5">
              <QuickBooksTab />
            </TabsContent>
            <TabsContent value="stripe" className="mt-5">
              <StripeTab />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}

function Card({ title, text, children, aside }: { title: string; text?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl border bg-card/40 p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{title}</h3>
          {text && <p className="text-xs text-muted-foreground">{text}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function useSettings() {
  return useQuery({ queryKey: [...KEY, "settings"], queryFn: () => api.get<Settings>("/billing/settings") });
}
function useSaveSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  return useMutation({
    mutationFn: (p: Partial<Omit<Settings, "preview">>) => api.put<Settings>("/billing/settings", p),
    onSuccess: (s) => {
      qc.setQueryData([...KEY, "settings"], s);
      toast.success(t("billing.saved"));
    },
    onError: (e) => toast.error(err(e)),
  });
}

// ── Numbering, taxes, company ──
function GeneralTab() {
  const { t } = useTranslation();
  const { data } = useSettings();
  const save = useSaveSettings();
  const [f, setF] = useState<Pick<Settings, "numbering" | "taxes" | "company"> | null>(null);
  useEffect(() => {
    if (data) setF({ numbering: data.numbering, taxes: data.taxes, company: data.company });
  }, [data]);
  if (!f) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const preview = `${f.numbering.prefix}${String(f.numbering.next || 0).padStart(f.numbering.digits || 1, "0")}`;
  const set = <K extends keyof typeof f>(k: K, v: Partial<(typeof f)[K]>) => setF({ ...f, [k]: { ...f[k], ...v } });
  return (
    <form
      className="space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate(f);
      }}
    >
      <Card title={t("billing.numbering.title")} text={t("billing.numbering.text")} aside={<span className="rounded-lg border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-3 py-1.5 font-mono text-sm text-primary">{preview}</span>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("billing.numbering.prefix")} hint={t("billing.numbering.prefixHint")}>
            <Input value={f.numbering.prefix} maxLength={10} onChange={(e) => set("numbering", { prefix: e.target.value.replace(/[^A-Za-z0-9-]/g, "") })} />
          </Field>
          <Field label={t("billing.numbering.next")} hint={t("billing.numbering.nextHint")}>
            <Input type="number" min={1} value={f.numbering.next} onChange={(e) => set("numbering", { next: Number(e.target.value) })} />
          </Field>
          <Field label={t("billing.numbering.digits")}>
            <Input type="number" min={1} max={10} value={f.numbering.digits} onChange={(e) => set("numbering", { digits: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>

      <Card title={t("billing.taxes.title")} text={t("billing.taxes.text")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("billing.taxes.gstNumber")}>
            <Input value={f.taxes.gstNumber} placeholder="123456789 RT0001" onChange={(e) => set("taxes", { gstNumber: e.target.value })} />
          </Field>
          <Field label={t("billing.taxes.qstNumber")}>
            <Input value={f.taxes.qstNumber} placeholder="1234567890 TQ0001" onChange={(e) => set("taxes", { qstNumber: e.target.value })} />
          </Field>
          <Field label={t("billing.taxes.gstRate")}>
            <Input type="number" step="0.001" min={0} max={30} value={f.taxes.gstRate} onChange={(e) => set("taxes", { gstRate: Number(e.target.value) })} />
          </Field>
          <Field label={t("billing.taxes.qstRate")}>
            <Input type="number" step="0.001" min={0} max={30} value={f.taxes.qstRate} onChange={(e) => set("taxes", { qstRate: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>

      <Card title={t("billing.company.title")} text={t("billing.company.text")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("billing.company.legalName")}>
            <Input value={f.company.legalName} onChange={(e) => set("company", { legalName: e.target.value })} />
          </Field>
          <Field label={t("billing.company.email")}>
            <Input type="email" value={f.company.email} onChange={(e) => set("company", { email: e.target.value })} />
          </Field>
          <Field label={t("billing.company.address")} className="sm:col-span-2">
            <Textarea rows={2} value={f.company.address} onChange={(e) => set("company", { address: e.target.value })} />
          </Field>
          <Field label={t("billing.company.phone")}>
            <Input value={f.company.phone} onChange={(e) => set("company", { phone: e.target.value })} />
          </Field>
          <Field label={t("billing.company.website")}>
            <Input value={f.company.website} onChange={(e) => set("company", { website: e.target.value })} />
          </Field>
        </div>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" disabled={save.isPending} className={GOLD}>
          {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("billing.save")}
        </Button>
      </div>
    </form>
  );
}

// ── Invoice template ──
function TemplateTab() {
  const { t } = useTranslation();
  const { data } = useSettings();
  const save = useSaveSettings();
  const [f, setF] = useState<Settings["template"] | null>(null);
  useEffect(() => {
    if (data) setF(data.template);
  }, [data]);
  if (!f || !data) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
      <form
        className="space-y-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate({ template: f });
        }}
      >
        <Card title={t("billing.template.title")} text={t("billing.template.text")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("billing.template.language")}>
              <Select value={f.language} onValueChange={(v) => setF({ ...f, language: v as "fr" | "en" })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fr">Français</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("billing.template.terms")} hint={t("billing.template.termsHint")}>
              <Select value={String(f.termsDays)} onValueChange={(v) => setF({ ...f, termsDays: Number(v) })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0, 15, 30, 45, 60].map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d === 0 ? t("crm.invoice.onReceipt") : t("crm.invoice.days", { days: d })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("billing.template.paymentInstructions")} className="sm:col-span-2" hint={t("billing.template.paymentInstructionsHint")}>
              <Textarea rows={3} value={f.paymentInstructions} onChange={(e) => setF({ ...f, paymentInstructions: e.target.value })} />
            </Field>
            <Field label={t("billing.template.footer")} className="sm:col-span-2">
              <Textarea rows={2} value={f.footer} onChange={(e) => setF({ ...f, footer: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch checked={f.showPaymentLink} onCheckedChange={(v) => setF({ ...f, showPaymentLink: v })} /> {t("billing.template.showPaymentLink")}
            </label>
          </div>
        </Card>
        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending} className={GOLD}>
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("billing.save")}
          </Button>
        </div>
      </form>
      <InvoicePreview s={{ ...data, template: f }} />
    </div>
  );
}

/** A sketch of the invoice with the settings (the real PDF comes with Accounting). */
function InvoicePreview({ s }: { s: Settings }) {
  const { t } = useTranslation();
  const L = (k: string) => t(`billing.preview.${k}`, { lng: s.template.language });
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{t("billing.template.preview")}</p>
      <div className="rounded-2xl bg-[#f4f4f1] p-6 text-[13px] text-[#0a0a0b] shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-base font-bold">{s.company.legalName || "—"}</p>
            <p className="whitespace-pre-line text-[11px] text-black/60">{[s.company.address, s.company.phone, s.company.email, s.company.website].filter(Boolean).join("\n")}</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold tracking-wide">{L("invoice")}</p>
            <p className="font-mono text-xs">{s.preview}</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-[1fr_auto] gap-y-1 border-y border-black/10 py-3 text-[12px]">
          <span>{L("line")}</span>
          <span className="font-mono">500,00 $</span>
          <span className="text-black/60">TPS ({s.taxes.gstRate} %)</span>
          <span className="font-mono text-black/60">{(500 * s.taxes.gstRate / 100).toFixed(2).replace(".", ",")} $</span>
          <span className="text-black/60">TVQ ({s.taxes.qstRate} %)</span>
          <span className="font-mono text-black/60">{(500 * s.taxes.qstRate / 100).toFixed(2).replace(".", ",")} $</span>
          <span className="font-semibold">{L("total")}</span>
          <span className="font-mono font-semibold">{(500 * (1 + (s.taxes.gstRate + s.taxes.qstRate) / 100)).toFixed(2).replace(".", ",")} $</span>
        </div>
        <p className="mt-3 text-[11px] text-black/60">
          {s.template.termsDays === 0 ? L("onReceipt") : L("terms").replace("{{days}}", String(s.template.termsDays))}
          {(s.taxes.gstNumber || s.taxes.qstNumber) && ` · TPS ${s.taxes.gstNumber || "—"} · TVQ ${s.taxes.qstNumber || "—"}`}
        </p>
        {s.template.paymentInstructions && <p className="mt-2 whitespace-pre-line text-[11px]">{s.template.paymentInstructions}</p>}
        {s.template.showPaymentLink && <p className="mt-3 inline-block rounded-md bg-[#0a0a0b] px-3 py-1.5 text-[11px] font-semibold text-[#ffce1a]">{L("payOnline")}</p>}
        {s.template.footer && <p className="mt-4 border-t border-black/10 pt-2 text-center text-[11px] text-black/60">{s.template.footer}</p>}
      </div>
    </div>
  );
}

// ── Chart of accounts ──
function LedgerTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const { data: accounts = [], isLoading } = useQuery({
    queryKey: [...KEY, "ledger"],
    queryFn: async () => {
      const r = await api.get<Account[]>("/billing/ledger");
      // the first time, the starter chart also sets the default accounts
      void qc.invalidateQueries({ queryKey: [...KEY, "settings"] });
      return r;
    },
  });
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [add, setAdd] = useState({ number: "", name: "", type: "revenue" as LedgerType });
  const refresh = () => void qc.invalidateQueries({ queryKey: [...KEY, "ledger"] });
  const create = useMutation({
    mutationFn: () => api.post<Account>("/billing/ledger", add),
    onSuccess: () => {
      refresh();
      setAdd({ number: "", name: "", type: add.type });
      toast.success(t("billing.saved"));
    },
    onError: (e) => toast.error(err(e)),
  });
  const update = useMutation({
    mutationFn: ({ id, ...p }: Partial<Account> & { id: string }) => api.patch<Account>(`/billing/ledger/${id}`, p),
    onSuccess: refresh,
    onError: (e) => toast.error(err(e)),
  });
  const active = accounts.filter((a) => a.active);
  return (
    <div className="space-y-5">
      <Card title={t("billing.accounts.title")} text={t("billing.accounts.text")}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {ACCOUNT_USES.map((use) => (
            <Field key={use} label={t(`billing.accounts.${use}`)}>
              <Select value={settings?.accounts[use] ?? "none"} onValueChange={(v) => save.mutate({ accounts: { ...settings!.accounts, [use]: v === "none" ? null : v } })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-72">
                  <SelectItem value="none">—</SelectItem>
                  {active.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="font-mono text-xs">{a.number}</span> {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ))}
        </div>
      </Card>

      <Card title={t("billing.ledger.title")} text={t("billing.ledger.text")}>
        <form
          className="grid gap-2 sm:grid-cols-[110px_minmax(0,1fr)_160px_auto]"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input required placeholder={t("billing.ledger.number")} value={add.number} onChange={(e) => setAdd({ ...add, number: e.target.value })} className="font-mono" />
          <Input required placeholder={t("billing.ledger.name")} value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
          <Select value={add.type} onValueChange={(v) => setAdd({ ...add, type: v as LedgerType })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEDGER_TYPES.map((x) => (
                <SelectItem key={x} value={x}>
                  {t(`billing.ledger.types.${x}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" variant="outline" disabled={create.isPending}>
            <Plus className="size-4" /> {t("billing.ledger.add")}
          </Button>
        </form>
        {isLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
        {LEDGER_TYPES.map((type) => {
          const list = accounts.filter((a) => a.type === type);
          if (!list.length) return null;
          return (
            <div key={type} className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t(`billing.ledger.types.${type}`)}</p>
              <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
                {list.map((a) => (
                  <li key={a.id} className={cn("flex items-center gap-3 px-3 py-2", !a.active && "opacity-50")}>
                    <span className="w-16 shrink-0 font-mono text-sm">{a.number}</span>
                    <Input
                      defaultValue={a.name}
                      onBlur={(e) => e.target.value.trim() && e.target.value !== a.name && update.mutate({ id: a.id, name: e.target.value.trim() })}
                      className="h-8 flex-1 border-transparent bg-transparent px-2 hover:border-border focus:border-border"
                    />
                    {Object.values(settings?.accounts ?? {}).includes(a.id) && (
                      <span className="shrink-0 rounded-md border border-[color:var(--gold)]/40 px-1.5 py-0.5 text-[10px] text-primary">{t("billing.ledger.default")}</span>
                    )}
                    {a.quickbooksId && <span className="shrink-0 text-[10px] text-emerald-400">QuickBooks</span>}
                    <Switch checked={a.active} onCheckedChange={(v) => update.mutate({ id: a.id, active: v })} aria-label={t("billing.ledger.active")} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ── QuickBooks ──
function SecretInput({ value, onChange, saved, placeholder }: { value: string; onChange: (v: string) => void; saved: boolean; placeholder?: string }) {
  return <Input type="password" autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={saved ? "••••••••••••" : placeholder} />;
}

function Saved({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return on ? <span className="ml-2 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{t("integrations.savedValue")}</span> : null;
}

function LastTest({ r }: { r: { ok: boolean; at: string; error?: string } | null }) {
  const { t } = useTranslation();
  if (!r) return null;
  return r.ok ? (
    <p className="flex items-center gap-1.5 text-xs text-emerald-400">
      <CheckCircle2 className="size-3.5" /> {t("billing.testOk", { at: dateTime(r.at) })}
    </p>
  ) : (
    <p className="flex items-center gap-1.5 text-xs text-destructive">
      <XCircle className="size-3.5" /> {t("billing.testFailed", { error: r.error ?? "" })}
    </p>
  );
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

      {q.connected && <QuickBooksData q={q} />}

      <Card title={t("billing.qb.sync")} text={t("billing.qb.syncText")} aside={<Switch checked={q.enabled} disabled={!q.connected} onCheckedChange={(v) => toggle.mutate({ enabled: v })} aria-label={t("billing.enabled")} />}>
        <div className="grid gap-2 sm:grid-cols-3">
          {(["customers", "invoices", "payments"] as const).map((k) => (
            <label key={k} className="flex items-start gap-2 rounded-xl border p-3 text-sm">
              <Switch checked={q.sync[k]} onCheckedChange={(v) => toggle.mutate({ sync: { [k]: v } })} />
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
  const accounts = useMutation({
    mutationFn: () => api.post<{ matched: number; created: number }>("/billing/quickbooks/import/accounts"),
    onSuccess: (r) => {
      refresh();
      toast.success(t("billing.qb.accountsDone", r));
    },
    onError: (e) => toast.error(err(e)),
  });
  const items = useMutation({
    mutationFn: () => api.post<{ items: number; categories: number; products: number }>("/billing/quickbooks/import/items"),
    onSuccess: (r) => {
      refresh();
      toast.success(t("billing.qb.itemsDone", r));
    },
    onError: (e) => toast.error(err(e)),
  });
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
            <Button size="sm" variant="outline" disabled={accounts.isPending} onClick={() => accounts.mutate()}>
              {accounts.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowDownToLine className="size-3.5" />} {t("billing.qb.import")}
            </Button>
          </div>
          <div className="space-y-2 rounded-xl border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <FileText className="size-4 text-primary" /> {t("billing.qb.importItems")}
            </p>
            <p className="text-[11px] text-muted-foreground">{t("billing.qb.importItemsText")}</p>
            {q.imports.items && <p className="text-[11px] text-emerald-400">{t("billing.qb.itemsLast", { ...q.imports.items, at: dateTime(q.imports.items.at) })}</p>}
            <Button size="sm" variant="outline" disabled={items.isPending} onClick={() => items.mutate()}>
              {items.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowDownToLine className="size-3.5" />} {t("billing.qb.import")}
            </Button>
          </div>
        </div>
      </Card>
      <InvoiceDefaultsCard />
      <MappingCard />
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
  const auto = useMutation({
    mutationFn: () => api.post<{ mapped: number }>("/billing/quickbooks/mapping/auto"),
    onSuccess: (r) => {
      refresh();
      toast.success(t("billing.qb.autoDone", { count: r.mapped }));
    },
    onError: (e) => toast.error(err(e)),
  });
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
        <Button size="sm" disabled={!sure || auto.isPending} onClick={() => auto.mutate()} className={GOLD}>
          {auto.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} {t("billing.qb.auto", { count: sure })}
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
        </>
      )}
    </Card>
  );
}

// ── Stripe ──
function StripeTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const { data: s } = useQuery({ queryKey: [...KEY, "stripe"], queryFn: () => api.get<Stripe>("/billing/stripe") });
  const [f, setF] = useState({ publishableKey: "", secretKey: "", webhookSecret: "" });
  useEffect(() => {
    if (s) setF({ publishableKey: s.publishableKey, secretKey: "", webhookSecret: "" });
  }, [s]);
  const done = (r: Stripe) => qc.setQueryData([...KEY, "stripe"], r);
  const put = (p: Record<string, unknown>) => api.put<Stripe>("/billing/stripe", p);
  const save = useMutation({
    mutationFn: () => put({ publishableKey: f.publishableKey, ...(f.secretKey ? { secretKey: f.secretKey } : {}), ...(f.webhookSecret ? { webhookSecret: f.webhookSecret } : {}) }),
    onSuccess: (r) => {
      done(r);
      toast.success(t("billing.saved"));
    },
    onError: (e) => toast.error(err(e)),
  });
  const toggle = useMutation({ mutationFn: put, onSuccess: done, onError: (e) => toast.error(err(e)) });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>("/billing/stripe/test"),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [...KEY, "stripe"] });
      if (r.ok) toast.success(t("billing.stripe.testOk"));
      else toast.error(t("billing.testFailed", { error: r.error === "invalid_key" ? t("billing.stripe.invalidKey") : (r.error ?? "") }));
    },
    onError: (e) => toast.error(err(e)),
  });
  if (!s) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-5">
      <Card
        title={t("billing.stripe.title")}
        text={t("billing.stripe.text")}
        aside={
          <div className="flex items-center gap-2">
            {s.mode && (
              <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase", s.mode === "live" ? "border-emerald-500/40 text-emerald-300" : "border-amber-500/40 text-amber-300")}>
                {s.mode === "live" ? t("billing.stripe.live") : t("billing.stripe.test")}
              </span>
            )}
            <Switch checked={s.enabled} onCheckedChange={(v) => toggle.mutate({ enabled: v })} aria-label={t("billing.enabled")} />
          </div>
        }
      >
        <form
          className="grid gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label={t("billing.stripe.publishableKey")}>
            <Input value={f.publishableKey} placeholder="pk_live_…" onChange={(e) => setF({ ...f, publishableKey: e.target.value.trim() })} className="font-mono text-xs" />
          </Field>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t("billing.stripe.secretKey")}
              <Saved on={s.hasSecretKey} />
            </Label>
            <SecretInput value={f.secretKey} onChange={(v) => setF({ ...f, secretKey: v.trim() })} saved={s.hasSecretKey} placeholder="sk_live_… / rk_live_…" />
            <p className="text-[11px] text-muted-foreground">{t("billing.stripe.secretHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t("billing.stripe.webhookSecret")}
              <Saved on={s.hasWebhookSecret} />
            </Label>
            <SecretInput value={f.webhookSecret} onChange={(v) => setF({ ...f, webhookSecret: v.trim() })} saved={s.hasWebhookSecret} placeholder="whsec_…" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={s.paymentLinks} onCheckedChange={(v) => toggle.mutate({ paymentLinks: v })} /> {t("billing.stripe.paymentLinks")}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="outline" disabled={save.isPending}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("billing.save")}
            </Button>
            <Button type="button" variant="outline" disabled={!s.hasSecretKey || test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("billing.test")}
            </Button>
          </div>
          <LastTest r={s.lastTest} />
        </form>
      </Card>
    </div>
  );
}
