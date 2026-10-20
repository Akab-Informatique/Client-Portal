import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Landmark, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, Field, KEY, LastTest, Saved, SecretInput, useBillingError } from "./BillingSection";

export type Stripe = {
  enabled: boolean;
  publishableKey: string;
  paymentLinks: boolean;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  mode: "test" | "live" | null;
  lastTest: { ok: boolean; at: string; error?: string; account?: { id: string; name: string | null; country: string | null } | null } | null;
  /** Where Stripe sends its events, and the ones the portal listens to */
  webhookUrl: string;
  events: string[];
};
const STRIPE_KEY = [...KEY, "stripe"];

/** The card on Admin › Intégrations: connected or not, test or live. */
export function StripeStatus() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: STRIPE_KEY, queryFn: () => api.get<Stripe>("/billing/stripe") });
  if (!data) return null;
  const [key, tone] = !data.hasSecretKey ? ["notConfigured", "muted"] : !data.enabled ? ["disabled", "muted"] : data.lastTest?.ok === false ? ["error", "bad"] : ["connected", "good"];
  return (
    <div className="flex items-center gap-1.5">
      {data.mode && data.enabled && (
        <span className={cn("rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase", data.mode === "live" ? "border-emerald-500/40 text-emerald-300" : "border-amber-500/40 text-amber-300")}>
          {data.mode === "live" ? t("billing.stripe.live") : t("billing.stripe.test")}
        </span>
      )}
      <Badge
        variant="outline"
        className={cn("gap-1.5", tone === "good" && "border-emerald-500/40 text-emerald-400", tone === "bad" && "border-destructive/50 text-destructive", tone === "muted" && "text-muted-foreground")}
      >
        <span className="size-1.5 rounded-full bg-current" />
        {t(`integrations.status.${key}`)}
      </Badge>
    </div>
  );
}

/** Stripe: your account's keys, the webhook for payments received, test, on/off. */
export function StripePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useBillingError();
  const { data: s } = useQuery({ queryKey: STRIPE_KEY, queryFn: () => api.get<Stripe>("/billing/stripe") });
  const [f, setF] = useState({ publishableKey: "", secretKey: "", webhookSecret: "" });
  useEffect(() => {
    if (s) setF({ publishableKey: s.publishableKey, secretKey: "", webhookSecret: "" });
  }, [s]);
  const done = (r: Stripe) => qc.setQueryData(STRIPE_KEY, r);
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
      void qc.invalidateQueries({ queryKey: STRIPE_KEY });
      if (r.ok) toast.success(t("billing.stripe.testOk"));
      else toast.error(t("billing.testFailed", { error: r.error === "invalid_key" ? t("billing.stripe.invalidKey") : (r.error ?? "") }));
    },
    onError: (e) => toast.error(err(e)),
  });
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success(t("integrations.voipms.copied")));
  if (!s) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const account = s.lastTest?.ok ? s.lastTest.account : null;
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
          {/* whose account this is, as Stripe says it (read when the key is tested) */}
          <div className="flex items-center gap-3 rounded-xl border bg-background/40 p-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[color:var(--gold)]/10 text-primary">
              <Landmark className="size-4" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("integrations.stripe.account")}</p>
              {account ? (
                <p className="truncate">
                  <span className="font-medium">{account.name ?? t("integrations.stripe.noName")}</span> <span className="font-mono text-xs text-muted-foreground">{account.id}</span>
                  {account.country && <span className="text-xs text-muted-foreground"> · {account.country}</span>}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{s.hasSecretKey ? t("integrations.stripe.accountTest") : t("integrations.stripe.accountNone")}</p>
              )}
            </div>
          </div>
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

      {/* The webhook: how Stripe tells the portal that a card payment went through */}
      <Card title={t("integrations.stripe.webhookTitle")} text={t("integrations.stripe.webhookText")}>
        <form
          className="grid gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label={t("integrations.stripe.webhookUrl")}>
            <div className="flex gap-2">
              <Input readOnly value={s.webhookUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" onClick={() => copy(s.webhookUrl)}>
                <Copy className="size-4" /> {t("integrations.voipms.copy")}
              </Button>
            </div>
          </Field>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("integrations.stripe.events")}</Label>
            <ul className="flex flex-wrap gap-1.5">
              {s.events.map((e) => (
                <li key={e}>
                  <button type="button" onClick={() => copy(e)} title={t("integrations.voipms.copy")} className="rounded-md border bg-background/40 px-2 py-0.5 font-mono text-[11px] hover:border-[color:var(--gold)]/40">
                    {e}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t("billing.stripe.webhookSecret")}
              <Saved on={s.hasWebhookSecret} />
            </Label>
            <SecretInput value={f.webhookSecret} onChange={(v) => setF({ ...f, webhookSecret: v.trim() })} saved={s.hasWebhookSecret} placeholder="whsec_…" />
            <p className="text-[11px] text-muted-foreground">{t("integrations.stripe.webhookSecretHint")}</p>
          </div>
          <div>
            <Button type="submit" variant="outline" disabled={save.isPending || !f.webhookSecret}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("billing.save")}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
