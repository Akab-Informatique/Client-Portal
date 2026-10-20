import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, CircleCheck, Copy, CreditCard, ExternalLink, Link2, Loader2, Search, Trash2 } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { longDateTime, shortDate } from "@/pages/tickets/shared";

type Status = { ready: boolean; mode: "test" | "live" | null; hasWebhookSecret: boolean; webhookUrl: string; minCents: number };
type Invoice = { id: string; number: string; company: string; dueOn: string | null; balanceCents: number; late: boolean; daysLate: number };
type Checkout = {
  id: string;
  invoiceId: string;
  number: string;
  company: string;
  amountCents: number;
  status: "open" | "paid" | "expired" | "failed";
  live: boolean;
  url: string | null;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
  by: string | null;
};

const STATUS_STYLE: Record<Checkout["status"], string> = {
  open: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  paid: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  expired: "border-slate-500/40 bg-slate-500/10 text-slate-400",
  failed: "border-red-500/50 bg-red-500/15 text-red-300",
};
const WEBHOOK_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"];

/** "1149,75" or "1 149.75 $" to cents (NaN when it is not an amount) */
function toCents(v: string) {
  const n = Number(v.replace(/[\s$]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : NaN;
}

function copy(text: string, done: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(done),
    () => undefined,
  );
}

/** Accounting › Paiements: take a card payment for an invoice with Stripe. */
export function PaymentsPage() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const manage = can("accounting.manage");
  const [q, setQ] = useState("");
  const [paying, setPaying] = useState<Invoice | null>(null);
  const status = useQuery({ queryKey: ["payments", "status"], queryFn: () => api.get<Status>("/billing/payments/status") });
  const invoices = useQuery({
    queryKey: ["payments", "invoices"],
    queryFn: () => api.get<{ items: Invoice[] }>("/crm/invoices?status=open"),
    refetchInterval: 15_000,
  });
  const checkouts = useQuery({ queryKey: ["payments", "checkouts"], queryFn: () => api.get<Checkout[]>("/billing/payments/checkouts"), refetchInterval: 10_000 });
  const ready = status.data?.ready && status.data.hasWebhookSecret;
  const words = q.trim().toLowerCase();
  const list = (invoices.data?.items ?? []).filter((i) => !words || `${i.number} ${i.company}`.toLowerCase().includes(words));
  const active = new Map((checkouts.data ?? []).filter((c) => c.status === "open").map((c) => [c.invoiceId, c]));

  return (
    <div className="relative isolate space-y-6">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <CreditCard className="size-6 text-primary" /> {t("payments.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("payments.subtitle")}</p>
      </div>

      <StripeStatus status={status.data} loading={status.isLoading} />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("payments.invoices.title")}</h2>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-9 bg-background/40 pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("payments.invoices.search")} />
          </div>
          <div className="glass overflow-hidden rounded-2xl border">
            {invoices.isLoading ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-14" />
                ))}
              </div>
            ) : list.length === 0 ? (
              <p className="p-10 text-center text-sm text-muted-foreground">{t("payments.invoices.none")}</p>
            ) : (
              <ul className="divide-y">
                {list.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2">
                        <span className="font-mono text-sm">{i.number}</span>
                        {active.has(i.id) && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-px text-[11px] text-sky-300">
                            <Link2 className="size-3" /> {t("payments.invoices.activeLink")}
                          </span>
                        )}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">{i.company}</p>
                      {i.dueOn && (
                        <p className={cn("text-xs", i.late ? "text-red-400" : "text-muted-foreground")}>
                          {i.late ? t("payments.invoices.late", { count: i.daysLate }) : t("payments.invoices.due", { date: shortDate(i.dueOn) })}
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">{t("payments.invoices.balance")}</p>
                      <p className="font-semibold tabular-nums">{money(i.balanceCents, i18n.language)}</p>
                    </div>
                    {manage && (
                      <Button size="sm" disabled={!ready} onClick={() => setPaying(i)}>
                        <CreditCard className="size-4" /> {t("payments.invoices.pay")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <LinksPanel items={checkouts.data} loading={checkouts.isLoading} manage={manage} />
      </div>

      {paying && <PayDialog invoice={paying} minCents={status.data?.minCents ?? 50} mode={status.data?.mode ?? null} onClose={() => setPaying(null)} />}
    </div>
  );
}

function StripeStatus({ status, loading }: { status?: Status; loading: boolean }) {
  const { t } = useTranslation();
  if (loading || !status) return <Skeleton className="h-16 rounded-2xl" />;
  if (!status.ready) {
    return (
      <div className="glass flex items-start gap-3 rounded-2xl border border-dashed p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10">
          <CreditCard className="size-4 text-primary" />
        </span>
        <div>
          <p className="font-semibold">{t("payments.status.notReady")}</p>
          <p className="text-sm text-muted-foreground">{t("payments.status.notReadyText")}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="glass flex flex-wrap items-center gap-3 rounded-2xl border p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-emerald-500/30 bg-emerald-500/10">
          <CircleCheck className="size-4 text-emerald-300" />
        </span>
        <p className="font-semibold">{t("payments.status.connected")}</p>
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium",
            status.mode === "live" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300",
          )}
        >
          {t(status.mode === "live" ? "payments.status.live" : "payments.status.test")}
        </span>
        {status.mode !== "live" && <p className="basis-full text-sm text-muted-foreground sm:ml-12 sm:basis-auto">{t("payments.status.testHint")}</p>}
      </div>
      {!status.hasWebhookSecret && (
        <div className="space-y-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="flex items-center gap-2 font-semibold text-amber-200">
            <AlertTriangle className="size-4" /> {t("payments.status.noWebhook")}
          </p>
          <p className="text-sm text-amber-100/80">{t("payments.status.noWebhookText")}</p>
          <div className="space-y-1.5">
            <Label>{t("payments.status.webhookUrl")}</Label>
            <div className="flex gap-2">
              <Input readOnly value={status.webhookUrl} className="h-9 bg-background/40 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => copy(status.webhookUrl, t("payments.copied"))}>
                <Copy className="size-4" /> {t("payments.copy")}
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label>{t("payments.status.events")}</Label>
            <ul className="space-y-0.5 font-mono text-xs text-amber-100/90">
              {WEBHOOK_EVENTS.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function LinksPanel({ items, loading, manage }: { items?: Checkout[]; loading: boolean; manage: boolean }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const expire = useMutation({
    mutationFn: (id: string) => api.post(`/billing/payments/checkouts/${id}/expire`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["payments", "checkouts"] }),
    onError: () => toast.error(t("common.error")),
  });
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{t("payments.links.title")}</h2>
      <div className="glass overflow-hidden rounded-2xl border">
        {loading ? (
          <div className="space-y-2 p-3">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : !items?.length ? (
          <p className="p-10 text-center text-sm text-muted-foreground">{t("payments.links.none")}</p>
        ) : (
          <ul className="max-h-[34rem] divide-y overflow-y-auto">
            {items.map((c) => (
              <li key={c.id} className="space-y-1 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{c.number}</span>
                  {!c.live && <span className="rounded border border-amber-500/40 px-1 text-[10px] uppercase text-amber-300">{t("payments.links.test")}</span>}
                  <span className={cn("ml-auto rounded-full border px-2 py-px text-[11px]", STATUS_STYLE[c.status])}>{t(`payments.links.status.${c.status}`)}</span>
                </div>
                <p className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-muted-foreground">{c.company}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{money(c.amountCents, i18n.language)}</span>
                </p>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">
                    {longDateTime(c.paidAt ?? c.createdAt)}
                    {c.by ? ` · ${t("payments.links.by", { name: c.by })}` : ""}
                  </span>
                  {c.url && (
                    <>
                      <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t("payments.copyLink")} onClick={() => copy(c.url!, t("payments.copied"))}>
                        <Copy className="size-3.5" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t("payments.open")} asChild>
                        <a href={c.url} target="_blank" rel="noreferrer">
                          <ExternalLink className="size-3.5" />
                        </a>
                      </Button>
                      {manage && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 hover:text-red-400"
                          aria-label={t("payments.links.expire")}
                          onClick={() => void confirm({ title: t("payments.links.expireConfirm"), destructive: true }).then((ok) => ok && expire.mutate(c.id))}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Make the payment link for an invoice, show it (and a QR code), and wait for the payment. */
function PayDialog({ invoice, minCents, mode, onClose }: { invoice: Invoice; minCents: number; mode: "test" | "live" | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState((invoice.balanceCents / 100).toFixed(2).replace(".", ","));
  const [created, setCreated] = useState<{ id: string; url: string; amountCents: number; expiresAt: string } | null>(null);
  const [qr, setQr] = useState("");
  const cents = toCents(amount);
  const valid = Number.isFinite(cents) && cents <= invoice.balanceCents && cents >= Math.min(minCents, invoice.balanceCents);

  const create = useMutation({
    mutationFn: () => api.post<{ id: string; url: string; amountCents: number; expiresAt: string }>("/billing/payments/checkouts", { invoiceId: invoice.id, amountCents: cents }),
    onSuccess: (r) => {
      setCreated(r);
      void qc.invalidateQueries({ queryKey: ["payments", "checkouts"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? t(`payments.errors.${e.code.replace(/^stripe_/, "")}`, { defaultValue: t("common.error") }) : t("common.error")),
  });
  // once the link exists: its status, checked every few seconds
  const live = useQuery({
    queryKey: ["payments", "checkouts", "watch", created?.id],
    queryFn: () => api.get<Checkout[]>("/billing/payments/checkouts"),
    enabled: Boolean(created),
    refetchInterval: 4000,
  });
  const mine = live.data?.find((c) => c.id === created?.id);
  const paid = mine?.status === "paid";
  useEffect(() => {
    if (paid) {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      void qc.invalidateQueries({ queryKey: ["crm", "invoices"] });
    }
  }, [paid, qc]);
  useEffect(() => {
    if (!created) return;
    let off = false;
    void import("qrcode").then((m) => m.default.toDataURL(created.url, { margin: 1, width: 224 })).then((u) => !off && setQr(u));
    return () => {
      off = true;
    };
  }, [created]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && !create.isPending) create.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("payments.dialog.title")}</DialogTitle>
          <DialogDescription>{t("payments.dialog.text", { number: invoice.number, company: invoice.company })}</DialogDescription>
        </DialogHeader>

        {!created ? (
          <form onSubmit={submit} className="space-y-4">
            <div className="flex items-baseline justify-between rounded-xl border bg-muted/30 px-4 py-3">
              <span className="text-sm text-muted-foreground">{t("payments.dialog.balance")}</span>
              <span className="text-lg font-semibold tabular-nums">{money(invoice.balanceCents, i18n.language)}</span>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">{t("payments.dialog.amount")}</Label>
              <div className="relative">
                <Input id="pay-amount" autoFocus inputMode="decimal" className="pr-8 tabular-nums" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!valid} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              </div>
              <p className={cn("text-xs", valid ? "text-muted-foreground" : "text-red-400")}>{t("payments.dialog.amountHelp", { min: money(Math.min(minCents, invoice.balanceCents), i18n.language) })}</p>
            </div>
            {mode !== "live" && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{t("payments.status.testHint")}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!valid || create.isPending}>
                {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />} {t("payments.dialog.create")}
              </Button>
            </div>
          </form>
        ) : paid ? (
          <div className="space-y-4 py-2 text-center">
            <span className="mx-auto grid size-14 place-items-center rounded-full border border-emerald-500/40 bg-emerald-500/10">
              <Check className="size-7 text-emerald-300" />
            </span>
            <div>
              <p className="text-lg font-semibold">{t("payments.dialog.paidTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("payments.dialog.paidText", { amount: money(created.amountCents, i18n.language) })}</p>
            </div>
            <Button onClick={onClose}>{t("payments.dialog.close")}</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3">
              {qr ? <img src={qr} alt="" width={224} height={224} className="rounded-xl bg-white p-1" /> : <Skeleton className="size-56 rounded-xl" />}
              <p className="text-center text-sm text-muted-foreground">{t("payments.dialog.linkText", { date: longDateTime(created.expiresAt) })}</p>
            </div>
            <div className="flex gap-2">
              <Input readOnly value={created.url} className="h-9 bg-background/40 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={() => copy(created.url, t("payments.copied"))}>
                <Copy className="size-4" /> {t("payments.copy")}
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" asChild>
                <a href={created.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> {t("payments.open")}
                </a>
              </Button>
            </div>
            <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t("payments.dialog.waiting")}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
