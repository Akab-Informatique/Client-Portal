import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpenText, CheckCircle2, FileText, Hash, Loader2, Plus, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";
import { CleanupCard } from "./CleanupCard";

type Settings = {
  numbering: { prefix: string; next: number; digits: number };
  taxes: { gstNumber: string; qstNumber: string; gstRate: number; qstRate: number };
  company: { legalName: string; address: string; phone: string; email: string; website: string };
  template: { language: "fr" | "en"; termsDays: number; footer: string; paymentInstructions: string; showPaymentLink: boolean };
  accounts: Record<AccountUse, string | null>;
  rates: { hourly: number };
  preview: string;
};
type AccountUse = "receivable" | "bank" | "labour" | "charges" | "contracts" | "gst" | "qst";
const ACCOUNT_USES: AccountUse[] = ["receivable", "bank", "labour", "charges", "contracts", "gst", "qst"];
type LedgerType = "asset" | "liability" | "equity" | "revenue" | "expense";
const LEDGER_TYPES: LedgerType[] = ["asset", "liability", "equity", "revenue", "expense"];
type Account = { id: string; number: string; name: string; type: LedgerType; active: boolean; quickbooksId: string | null };
export const KEY = ["admin", "billing"];
const GOLD = "bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105";
const TABS = ["general", "template", "ledger"] as const;
type Tab = (typeof TABS)[number];

export function useBillingError() {
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

  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "general";

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
      </Tabs>
      <div className="mt-8">
        <CleanupCard />
      </div>
    </div>
  );
}

export function Card({ title, text, children, aside }: { title: string; text?: string; children: ReactNode; aside?: ReactNode }) {
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

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) {
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
  const [f, setF] = useState<Pick<Settings, "numbering" | "taxes" | "company" | "rates"> | null>(null);
  useEffect(() => {
    if (data) setF({ numbering: data.numbering, taxes: data.taxes, company: data.company, rates: data.rates });
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

      <Card title={t("billing.import.title")} text={t("billing.import.text")}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("billing.import.hourly")} hint={t("billing.import.hourlyHint")}>
            <Input type="number" min={0} step="0.01" value={f.rates.hourly} onChange={(e) => set("rates", { hourly: Number(e.target.value) })} />
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
export function SecretInput({ value, onChange, saved, placeholder }: { value: string; onChange: (v: string) => void; saved: boolean; placeholder?: string }) {
  return <Input type="password" autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={saved ? "••••••••••••" : placeholder} />;
}

export function Saved({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return on ? <span className="ml-2 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{t("integrations.savedValue")}</span> : null;
}

export function LastTest({ r }: { r: { ok: boolean; at: string; error?: string } | null }) {
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
