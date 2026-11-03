import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CreditCard, Download, ExternalLink, Eye, FileText, Loader2, Receipt, ShieldCheck, X } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";
import { PageHeader, Pane } from "./ui";

type Invoice = { id: string; number: string; issuedOn: string; dueOn: string | null; totalCents: number; balanceCents: number; status: "due" | "overdue" | "partial" | "paid" | "voided"; paidByCard: boolean; payUrl: string | null; cardFee: { percent: number; feeCents: number; taxCents: number } | null };
type Terms = {
  id: string;
  name: string;
  period: "monthly" | "yearly";
  startDate: string | null;
  endDate: string | null;
  perPeriodCents: number | null;
  yearlyExtraCents: number;
  next: { date: string; amountCents: number } | null;
  bundle: { quantity: number; unitCents: number } | null;
  lines: { name: string; quantity: number; yearly: boolean; unitCents: number }[];
  autopay: { status: "pending" | "active"; card: { brand: string | null; last4: string; expMonth: number | null; expYear: number | null } | null; acceptedName: string | null; acceptedAt: string | null; lastChargeAt: string | null; declined: boolean } | null;
};

const STATUS_CLASS: Record<Invoice["status"], string> = {
  due: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
  overdue: "border-red-500/40 bg-red-500/10 text-red-300",
  partial: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  paid: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  voided: "border-border text-muted-foreground",
};
const brandName = (b: string | null | undefined) => (b ? b.charAt(0).toUpperCase() + b.slice(1) : "");

/** Client portal › Comptabilité › Factures: the company's invoices, the PDF of each, and "Pay online" when it applies. */
export function ClientInvoicesPage() {
  const { t, i18n } = useTranslation();
  const { data = [], isLoading } = useQuery({ queryKey: ["client-billing", "invoices"], queryFn: () => api.get<Invoice[]>("/client-billing/invoices") });
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const shown = data.filter((v) => (filter === "open" ? v.balanceCents > 0 && v.status !== "voided" : true));
  const owed = data.filter((v) => v.status !== "voided").reduce((n, v) => n + v.balanceCents, 0);
  const m = (c: number) => money(c, i18n.language);
  return (
    <div className="space-y-5">
      <PageHeader
        icon={Receipt}
        title={t("clientBilling.invoicesTitle")}
        subtitle={owed > 0 ? t("clientBilling.owed", { amount: m(owed) }) : t("clientBilling.nothingOwed")}
        actions={
          <div className="flex gap-1">
            {(["open", "all"] as const).map((f) => (
              <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)} className={filter === f ? "bg-grad-gold text-[#1a1204]" : ""}>
                {t(f === "open" ? "clientBilling.filterOpen" : "clientBilling.filterAll")}
              </Button>
            ))}
          </div>
        }
      />
      {isLoading ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : shown.length === 0 ? (
        <Pane className="p-10 text-center text-sm text-muted-foreground">{t(filter === "open" ? "clientBilling.noneOpen" : "clientBilling.none")}</Pane>
      ) : (
        <Pane className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2.5 font-medium">{t("clientBilling.number")}</th>
                <th className="px-3 py-2.5 font-medium">{t("clientBilling.date")}</th>
                <th className="px-3 py-2.5 font-medium">{t("clientBilling.due")}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t("clientBilling.total")}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t("clientBilling.balance")}</th>
                <th className="px-3 py-2.5 font-medium">{t("clientBilling.status")}</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {shown.map((v) => (
                <tr key={v.id}>
                  <td className="px-4 py-2.5 font-mono">{v.number}</td>
                  <td className="px-3 py-2.5">{shortDate(v.issuedOn)}</td>
                  <td className="px-3 py-2.5">{v.dueOn ? shortDate(v.dueOn) : "—"}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{m(v.totalCents)}</td>
                  <td className="px-3 py-2.5 text-right font-mono font-semibold">{m(v.balanceCents)}</td>
                  <td className="px-3 py-2.5">
                    <span className={cn("inline-block rounded-md border px-1.5 py-0.5 text-[11px] font-semibold", STATUS_CLASS[v.status])}>{t(`clientBilling.state.${v.status}`)}</span>
                    {v.paidByCard && <span className="ml-1 text-[11px] text-muted-foreground">{t("clientBilling.byCard")}</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    {v.payUrl && (
                      <Button size="sm" className="h-7 bg-grad-gold text-xs font-semibold text-[#1a1204] hover:brightness-105" onClick={() => setPaying(v)}>
                        <CreditCard className="size-3.5" /> {t("clientBilling.pay")}
                      </Button>
                    )}
                    <Button asChild size="icon" variant="ghost" className="size-7" title={t("clientBilling.view")}>
                      <a href={`/api/client-billing/invoices/${v.id}/pdf`} target="_blank" rel="noopener noreferrer" aria-label={t("clientBilling.view")}>
                        <Eye className="size-3.5" />
                      </a>
                    </Button>
                    <Button asChild size="icon" variant="ghost" className="size-7" title={t("clientBilling.download")}>
                      <a href={`/api/client-billing/invoices/${v.id}/pdf?download=1`} aria-label={t("clientBilling.download")}>
                        <Download className="size-3.5" />
                      </a>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Pane>
      )}
      {paying && <PayDialog invoice={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}

/** Before Stripe's page: what will be paid, and the credit card fee said plainly (refunded with a debit card) */
function PayDialog({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const m = (c: number) => money(c, i18n.language);
  const fee = invoice.cardFee && invoice.cardFee.feeCents > 0 ? invoice.cardFee : null;
  const feeTotal = fee ? fee.feeCents + fee.taxCents : 0;
  const pct = fee ? fee.percent.toLocaleString(i18n.language === "en" ? "en-CA" : "fr-CA", { maximumFractionDigits: 2 }) : "";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("clientBilling.payTitle", { number: invoice.number })}</DialogTitle>
          <DialogDescription>{t("clientBilling.payText")}</DialogDescription>
        </DialogHeader>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t("clientBilling.payBalance")}</dt>
            <dd className="font-mono">{m(invoice.balanceCents)}</dd>
          </div>
          {fee && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t(fee.taxCents ? "clientBilling.payFeeTaxed" : "clientBilling.payFee", { pct })}</dt>
              <dd className="font-mono">{m(feeTotal)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3 border-t pt-1.5 font-semibold">
            <dt>{t("clientBilling.payTotal")}</dt>
            <dd className="font-mono text-primary">{m(invoice.balanceCents + feeTotal)}</dd>
          </div>
        </dl>
        {fee && <p className="rounded-xl border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/5 p-3 text-xs text-muted-foreground">{t("clientBilling.payFeeNote", { pct })}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button asChild className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            <a href={invoice.payUrl!} onClick={() => setTimeout(onClose, 300)}>
              <CreditCard className="size-4" /> {t("clientBilling.payGo")}
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Client portal › Comptabilité › Contrats: the company's running contracts (what each charges and when), and their
 * automatic card payment — turn it on for one or several contracts (one card), replace the card, or turn it off.
 */
export function ClientContractsPage() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const manage = can("clientContracts.autopay");
  const { data, isLoading } = useQuery({ queryKey: ["client-billing", "contracts"], queryFn: () => api.get<{ ready: boolean; contracts: Terms[] }>("/client-billing/contracts") });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const m = (c: number) => money(c, i18n.language);
  const err = (e: unknown) => toast.error(e instanceof ApiError && e.code === "stripe_not_ready" ? t("clientBilling.notReady") : t("common.error"));
  const start = useMutation({
    mutationFn: (ids: string[]) => api.post<{ path: string }>("/client-billing/contracts/autopay", { contractIds: ids }),
    onSuccess: (r) => window.location.assign(r.path),
    onError: err,
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.del(`/client-billing/contracts/${id}/autopay`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["client-billing"] });
      toast.success(t("clientBilling.turnedOff"));
    },
    onError: err,
  });
  const contracts = data?.contracts ?? [];
  const without = contracts.filter((k) => k.autopay?.status !== "active");
  const pick = (id: string, on: boolean) => {
    const s = new Set(picked);
    if (on) s.add(id);
    else s.delete(id);
    setPicked(s);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={FileText}
        title={t("clientBilling.contractsTitle")}
        subtitle={t("clientBilling.contractsSubtitle")}
        actions={
          manage && data?.ready && picked.size > 0 ? (
            <Button disabled={start.isPending} onClick={() => start.mutate([...picked])} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {start.isPending ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />} {t("clientBilling.turnOnPicked", { count: picked.size })}
            </Button>
          ) : null
        }
      />
      {manage && data && !data.ready && <Pane className="p-3 text-sm text-muted-foreground">{t("clientBilling.notReady")}</Pane>}
      {isLoading ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : contracts.length === 0 ? (
        <Pane className="p-10 text-center text-sm text-muted-foreground">{t("clientBilling.noContracts")}</Pane>
      ) : (
        <div className="space-y-3">
          {manage && data?.ready && without.length > 1 && (
            <p className="text-xs text-muted-foreground">{t("clientBilling.pickHint")}</p>
          )}
          {contracts.map((k) => {
            const a = k.autopay;
            const active = a?.status === "active";
            return (
              <Pane key={k.id} edge={active} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start gap-3">
                  {manage && data?.ready && !active && without.length > 1 && <Checkbox className="mt-1" checked={picked.has(k.id)} onCheckedChange={(v) => pick(k.id, v === true)} aria-label={k.name} />}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{k.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {k.startDate ? shortDate(k.startDate) : "…"} → {k.endDate ? shortDate(k.endDate) : "…"}
                    </p>
                  </div>
                  {k.perPeriodCents != null && (
                    <p className="text-right text-sm">
                      <span className="font-mono text-lg font-bold text-primary">{m(k.perPeriodCents)}</span>{" "}
                      <span className="text-muted-foreground">{t(k.period === "yearly" ? "cardPage.perYear" : "cardPage.perMonth")}</span>
                    </p>
                  )}
                </div>
                {(k.bundle || k.lines.length > 0) && (
                  <ul className="space-y-1 text-sm">
                    {k.bundle ? (
                      <li className="flex justify-between gap-3">
                        <span>{t("cardPage.bundle", { qty: k.bundle.quantity })}</span>
                        <span className="font-mono">{m(k.bundle.unitCents * k.bundle.quantity)}</span>
                      </li>
                    ) : (
                      k.lines.map((l, i) => (
                        <li key={i} className="flex justify-between gap-3">
                          <span className="min-w-0">
                            {l.name} {l.quantity > 1 && <span className="text-muted-foreground">× {l.quantity}</span>}
                          </span>
                          <span className="shrink-0 font-mono">
                            {m(l.unitCents * l.quantity)} <span className="text-xs text-muted-foreground">{t(l.yearly ? "cardPage.yearly" : "cardPage.monthly")}</span>
                          </span>
                        </li>
                      ))
                    )}
                  </ul>
                )}
                {k.next && <p className="text-xs text-muted-foreground">{t(k.period === "yearly" ? "cardPage.nextYearly" : "cardPage.next", { date: shortDate(k.next.date), amount: m(k.next.amountCents) })}</p>}

                <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
                  {active && a.card ? (
                    <span className="flex items-center gap-1.5 text-emerald-300">
                      <ShieldCheck className="size-4" /> {t("clientBilling.paidBy", { card: `${brandName(a.card.brand)} •••• ${a.card.last4}` })}
                    </span>
                  ) : a?.status === "pending" ? (
                    <span className="text-muted-foreground">{t("clientBilling.pending")}</span>
                  ) : (
                    <span className="text-muted-foreground">{t("clientBilling.noAutopay")}</span>
                  )}
                  {active && a.declined && <span className="text-red-300">{t("clientBilling.declined")}</span>}
                  {manage && data?.ready && (
                    <span className="ml-auto flex gap-2">
                      <Button size="sm" variant={active ? "outline" : "default"} disabled={start.isPending} onClick={() => start.mutate([k.id])} className={active ? "" : "bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105"}>
                        <CreditCard className="size-3.5" /> {t(active ? "clientBilling.replace" : a?.status === "pending" ? "clientBilling.finish" : "clientBilling.turnOn")}
                      </Button>
                      {a && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-300"
                          disabled={stop.isPending}
                          onClick={() => void confirm({ title: t("clientBilling.turnOffTitle"), description: t("clientBilling.turnOffText"), confirmLabel: t("clientBilling.turnOff"), destructive: true }).then((ok) => ok && stop.mutate(k.id))}
                        >
                          <X className="size-3.5" /> {t("clientBilling.turnOff")}
                        </Button>
                      )}
                    </span>
                  )}
                </div>
              </Pane>
            );
          })}
        </div>
      )}
      {manage && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ExternalLink className="size-3" /> {t("clientBilling.secure")}</p>}
    </div>
  );
}
