import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Copy, CreditCard, Loader2, Send, ShieldCheck, X } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { shortDate } from "@/pages/tickets/shared";

type Autopay = {
  id: string;
  status: "pending" | "active";
  email: string | null;
  requestedAt: string;
  acceptedName: string | null;
  acceptedAt: string | null;
  card: { brand: string | null; last4: string; expMonth: number | null; expYear: number | null; funding: string | null } | null;
  live: boolean;
  lastChargeAt: string | null;
  lastError: string | null;
  url: string | null;
};
type State = { ready: boolean; defaultEmail: string | null; autopay: Autopay | null };

export const autopayKey = (contractId: string) => ["crm", "autopay", contractId];
export const brandName = (b: string | null | undefined) => (b ? b.charAt(0).toUpperCase() + b.slice(1) : "");

/** The contract's state of automatic card payment, for the window's header */
export function useContractAutopay(contractId: string) {
  return useQuery({ queryKey: autopayKey(contractId), queryFn: () => api.get<State>(`/autopay/contracts/${contractId}`) });
}

/**
 * The contract window's "Paiement par carte" tab: send the client the link to accept the contract and save a card,
 * follow where it stands, replace the card or take automatic payment off. Approving the contract's lines then makes
 * its invoice and charges the card (server side).
 */
export function ContractAutopay({ contractId }: { contractId: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const editable = can("crm.billing");
  const { data, isLoading } = useContractAutopay(contractId);
  const [email, setEmail] = useState("");
  // the billing email by default; another address only when asked
  const [other, setOther] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: autopayKey(contractId) });
  const err = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "";
    toast.error(["stripe_not_ready", "no_email", "contract_inactive", "mail_not_configured", "mail_failed", "stripe_failed"].includes(code) ? t(`autopay.error.${code}`) : t("common.error"));
  };
  const send = useMutation({
    mutationFn: (p: { send: boolean }) => api.post<{ url: string; emailed: string | null }>(`/autopay/contracts/${contractId}/send`, { send: p.send, ...(other && email.trim() ? { email: email.trim() } : {}) }),
    onSuccess: async (r) => {
      refresh();
      if (r.emailed) toast.success(t("autopay.sent", { to: r.emailed }));
      else {
        await navigator.clipboard.writeText(r.url).catch(() => undefined);
        toast.success(t("autopay.copied"));
      }
    },
    onError: err,
  });
  const revoke = useMutation({
    mutationFn: () => api.del(`/autopay/contracts/${contractId}`),
    onSuccess: () => {
      refresh();
      toast.success(t("autopay.revoked"));
    },
    onError: err,
  });
  if (isLoading || !data) return <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />;
  const a = data.autopay;
  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url).catch(() => undefined);
    toast.success(t("autopay.copied"));
  };

  return (
    <div className="space-y-4">
      <p className="max-w-[70ch] text-sm text-muted-foreground">{t("autopay.text")}</p>
      {!data.ready && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {t("autopay.notReady")}
        </p>
      )}

      {a?.status === "active" && a.card && (
        <section className="space-y-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300">
              <CreditCard className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold">
                {brandName(a.card.brand)} •••• {a.card.last4}
                {a.card.expMonth && a.card.expYear && <span className="ml-2 text-xs font-normal text-muted-foreground">{t("autopay.expires", { date: `${String(a.card.expMonth).padStart(2, "0")}/${String(a.card.expYear).slice(-2)}` })}</span>}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(a.card.funding === "credit" ? "autopay.credit" : a.card.funding === "debit" ? "autopay.debit" : "autopay.otherCard")}
                {!a.live && ` · ${t("autopay.testMode")}`}
              </p>
            </div>
            <span className="ml-auto flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-300">
              <ShieldCheck className="size-3.5" /> {t("autopay.active")}
            </span>
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t("autopay.acceptedBy")}</dt>
              <dd>{a.acceptedName ?? ""}{a.acceptedAt && <span className="text-muted-foreground">, {shortDate(a.acceptedAt.slice(0, 10))}</span>}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("autopay.lastCharge")}</dt>
              <dd>{a.lastChargeAt ? shortDate(a.lastChargeAt.slice(0, 10)) : t("autopay.never")}</dd>
            </div>
          </dl>
          {a.lastError && (
            <p className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {t("autopay.lastError", { why: a.lastError })}
            </p>
          )}
        </section>
      )}

      {a?.status === "pending" && (
        <section className="space-y-2 rounded-2xl border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/5 p-4 text-sm">
          <p className="font-semibold">{t("autopay.pending")}</p>
          <p className="text-muted-foreground">{a.email ? t("autopay.pendingTo", { to: a.email, date: shortDate(a.requestedAt.slice(0, 10)) }) : t("autopay.pendingNoMail", { date: shortDate(a.requestedAt.slice(0, 10)) })}</p>
          {a.acceptedAt && <p className="text-muted-foreground">{t("autopay.acceptedNoCard", { name: a.acceptedName ?? "" })}</p>}
          {a.url && (
            <Button type="button" size="sm" variant="outline" onClick={() => void copy(a.url!)}>
              <Copy className="size-3.5" /> {t("autopay.copy")}
            </Button>
          )}
        </section>
      )}

      {editable && (
        <section className="space-y-2">
          {other || !data.defaultEmail ? (
            <label className="block max-w-md space-y-1.5 text-xs">
              <span className="text-muted-foreground">{t("autopay.email")}</span>
              <Input type="email" value={email} autoFocus={other} placeholder={data.defaultEmail ?? t("autopay.emailHint")} onChange={(e) => setEmail(e.target.value)} />
              {!data.defaultEmail && <span className="block text-amber-300">{t("autopay.noBillingEmail")}</span>}
              {other && data.defaultEmail && (
                <button type="button" className="text-primary hover:underline" onClick={() => { setOther(false); setEmail(""); }}>
                  {t("autopay.useBilling", { to: data.defaultEmail })}
                </button>
              )}
            </label>
          ) : (
            <p className="text-sm">
              {t("autopay.sendsTo")} <span className="font-medium">{data.defaultEmail}</span> <span className="text-xs text-muted-foreground">{t("autopay.billingEmail")}</span>{" "}
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => setOther(true)}>
                {t("autopay.change")}
              </button>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={!data.ready || send.isPending || (!data.defaultEmail && !email.trim()) || (other && !email.trim())} onClick={() => send.mutate({ send: true })} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t(a?.status === "active" ? "autopay.replace" : a ? "autopay.resend" : "autopay.send")}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={!data.ready || send.isPending} onClick={() => send.mutate({ send: false })}>
              <Copy className="size-3.5" /> {t("autopay.linkOnly")}
            </Button>
            {a && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-red-300"
                disabled={revoke.isPending}
                onClick={() => void confirm({ title: t("autopay.revokeTitle"), description: t("autopay.revokeText"), confirmLabel: t("autopay.revoke"), destructive: true }).then((ok) => ok && revoke.mutate())}
              >
                <X className="size-3.5" /> {t("autopay.revoke")}
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
