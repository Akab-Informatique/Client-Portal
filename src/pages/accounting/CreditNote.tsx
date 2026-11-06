import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CircleCheck, FileMinus, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { taxesOfLines } from "@shared/invoiceTax";

type Note = { id: string; number: string; issuedOn: string; reason: string | null; totalCents: number; appliedCents: number; quickbooks: { id: string | null; applied: boolean; error: string | null } };
type Info = {
  invoice: { id: string; number: string; client: string; totalCents: number; voided: boolean; balanceCents: number };
  exempt: boolean;
  rates: { gstRate: number; qstRate: number };
  lines: { id: string; description: string; quantityX100: number; unitPriceCents: number; amountCents: number; taxable: boolean }[];
  creditedCents: number;
  notes: Note[];
};
/** A row of the window: a line of the invoice (picked or not, its amount changeable) or a free amount */
type Row = { key: string; invoiceLineId: string | null; picked: boolean; description: string; amount: string; taxable: boolean };

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const num = (v: string) => Number(v.replace(/\s/g, "").replace(",", "."));

/** The "Note de crédit" button of an invoice (accounting.manage), opening its window */
export function InvoiceCreditButton({ invoice, compact }: { invoice: { id: string; number: string; status: string }; compact?: boolean }) {
  const { t } = useTranslation();
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (!can("accounting.manage") || invoice.status === "voided") return null;
  return (
    <>
      <Button type="button" size={compact ? "icon" : "sm"} variant="ghost" className={compact ? "size-7" : "h-7 text-xs"} onClick={() => setOpen(true)} title={t("creditNote.action")}>
        <FileMinus className="size-3.5" /> {!compact && t("creditNote.action")}
      </Button>
      {open && <CreditNoteDialog invoiceId={invoice.id} onClose={() => setOpen(false)} />}
    </>
  );
}

function CreditNoteDialog({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const m = (c: number) => money(c, i18n.language);
  const info = useQuery({ queryKey: ["crm", "credit-info", invoiceId], queryFn: () => api.get<Info>(`/crm/invoices/${invoiceId}/credit-info`) });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [reason, setReason] = useState("");
  const [day, setDay] = useState(today());
  const shown: Row[] = rows ?? (info.data?.lines ?? []).map((l) => ({ key: l.id, invoiceLineId: l.id, picked: false, description: l.description, amount: String(l.amountCents / 100), taxable: l.taxable }));
  const set = (key: string, p: Partial<Row>) => setRows(shown.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const chosen = shown.filter((r) => r.picked && num(r.amount) > 0);
  const totals = useMemo(() => {
    const d = info.data;
    const cents = chosen.map((r) => ({ cents: Math.round(num(r.amount) * 100), taxable: r.taxable }));
    const sub = cents.reduce((n, x) => n + x.cents, 0);
    const tax = d && !d.exempt ? taxesOfLines(cents.filter((x) => x.taxable).map((x) => x.cents), d.rates.gstRate, d.rates.qstRate) : { gst: 0, qst: 0 };
    return { sub, gst: tax.gst, qst: tax.qst, total: sub + tax.gst + tax.qst };
  }, [chosen, info.data]);
  const room = info.data ? info.data.invoice.totalCents - info.data.creditedCents : 0;
  const over = totals.total > room;
  const make = useMutation({
    mutationFn: () =>
      api.post<Note>(`/crm/invoices/${invoiceId}/credit-notes`, {
        issuedOn: day,
        reason: reason.trim() || null,
        lines: chosen.map((r) => ({ invoiceLineId: r.invoiceLineId, description: r.description, quantity: 1, unitPrice: num(r.amount), taxable: r.taxable })),
      }),
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: ["crm"] });
      setRows(null);
      setReason("");
      toast.success(t("creditNote.made", { number: n.number, total: m(n.totalCents) }), {
        description: n.quickbooks.error ? t("creditNote.qbFailed", { error: n.quickbooks.error }) : n.quickbooks.id ? t("creditNote.qbSent") : undefined,
      });
    },
    onError: (e) => toast.error(e instanceof ApiError ? t(`creditNote.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error")),
  });
  const resend = useMutation({
    mutationFn: (id: string) => api.post(`/crm/credit-notes/${id}/quickbooks`),
    onSuccess: () => toast.success(t("creditNote.qbSent")),
    onError: (e) => toast.error(e instanceof ApiError ? (e.message || t("common.error")) : t("common.error")),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["crm", "credit-info", invoiceId] }),
  });
  const d = info.data;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileMinus className="size-5 text-primary" /> {t("creditNote.title", { number: d?.invoice.number ?? "" })}
          </DialogTitle>
          <DialogDescription>{d ? t("creditNote.text", { client: d.invoice.client }) : ""}</DialogDescription>
        </DialogHeader>
        {!d ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-4 text-sm">
            {/* the credit notes already made on this invoice */}
            {d.notes.length > 0 && (
              <ul className="space-y-1 rounded-xl border p-2 text-xs">
                {d.notes.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-primary">{n.number}</span>
                    <span className="text-muted-foreground">{n.issuedOn}</span>
                    <span className="min-w-0 flex-1 truncate">{n.reason}</span>
                    <span className="font-mono">−{m(n.totalCents)}</span>
                    {n.quickbooks.id && (n.quickbooks.applied || n.appliedCents === 0) ? (
                      <span className="flex items-center gap-1 text-emerald-300">
                        <CircleCheck className="size-3.5" /> QuickBooks
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled={resend.isPending} onClick={() => resend.mutate(n.id)} title={n.quickbooks.error ?? undefined}>
                        {n.quickbooks.error && <AlertTriangle className="size-3 text-red-300" />} <RefreshCw className="size-3" /> {t("creditNote.sendQb")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="grid grid-cols-3 gap-2 text-xs">
              <Fig label={t("creditNote.invoiceTotal")} value={m(d.invoice.totalCents)} />
              <Fig label={t("creditNote.balance")} value={m(d.invoice.balanceCents)} />
              <Fig label={t("creditNote.room")} value={m(room)} />
            </div>

            {/* what is credited: lines of the invoice (amount changeable for a part) or a free amount */}
            <div className="space-y-1.5">
              <Label>{t("creditNote.lines")}</Label>
              <ul className="space-y-1.5">
                {shown.map((r) => (
                  <li key={r.key} className={cn("flex items-center gap-2 rounded-lg border px-2 py-1.5", r.picked ? "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/5" : "opacity-80")}>
                    <Checkbox checked={r.picked} onCheckedChange={(v) => set(r.key, { picked: Boolean(v) })} aria-label={r.description} />
                    {r.invoiceLineId ? (
                      <span className="min-w-0 flex-1 truncate" title={r.description}>
                        {r.description}
                      </span>
                    ) : (
                      <Input value={r.description} onChange={(e) => set(r.key, { description: e.target.value })} className="h-7 min-w-0 flex-1" placeholder={t("creditNote.freeLine")} />
                    )}
                    <div className="relative w-28">
                      <Input inputMode="decimal" value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value, picked: true })} className="h-7 pr-5 text-right font-mono" />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                    </div>
                    {r.invoiceLineId ? (
                      <span className="w-14 text-[10px] text-muted-foreground">{r.taxable ? t("creditNote.taxable") : t("creditNote.notTaxable")}</span>
                    ) : (
                      <label className="flex w-14 items-center gap-1 text-[10px] text-muted-foreground">
                        <Switch checked={r.taxable} onCheckedChange={(v) => set(r.key, { taxable: v })} className="scale-75" /> {t("creditNote.taxShort")}
                      </label>
                    )}
                    {!r.invoiceLineId && (
                      <button type="button" className="text-muted-foreground hover:text-red-400" onClick={() => setRows(shown.filter((x) => x.key !== r.key))} aria-label={t("common.delete")}>
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <button type="button" className="flex items-center gap-1 text-xs text-primary hover:underline" onClick={() => setRows([...shown, { key: crypto.randomUUID(), invoiceLineId: null, picked: true, description: t("creditNote.freeDefault", { number: d.invoice.number }), amount: "", taxable: true }])}>
                <Plus className="size-3.5" /> {t("creditNote.addFree")}
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
              <div className="space-y-1.5">
                <Label htmlFor="cn-reason">{t("creditNote.reason")}</Label>
                <Textarea id="cn-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("creditNote.reasonHint")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cn-day">{t("creditNote.date")}</Label>
                <Input id="cn-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
              </div>
            </div>

            <dl className="space-y-1 rounded-xl border bg-background/30 p-3">
              <Line label={t("creditNote.subtotal")} value={m(totals.sub)} />
              {totals.gst > 0 && <Line label={t("creditNote.gst")} value={m(totals.gst)} muted />}
              {totals.qst > 0 && <Line label={t("creditNote.qst")} value={m(totals.qst)} muted />}
              <Line label={t("creditNote.total")} value={`−${m(totals.total)}`} strong />
              {totals.total > 0 && <p className="pt-1 text-xs text-muted-foreground">{totals.total <= d.invoice.balanceCents ? t("creditNote.applied") : t("creditNote.partlyApplied", { applied: m(d.invoice.balanceCents), left: m(totals.total - d.invoice.balanceCents) })}</p>}
              {over && <p className="text-xs text-red-400">{t("creditNote.errors.credit_over_invoice")}</p>}
            </dl>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={!d || !chosen.length || over || totals.total <= 0 || make.isPending} onClick={() => make.mutate()}>
            {make.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileMinus className="size-4" />} {t("creditNote.make")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono">{value}</p>
    </div>
  );
}

function Line({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3", muted && "text-muted-foreground", strong && "border-t pt-1 font-semibold")}>
      <dt>{label}</dt>
      <dd className={cn("font-mono", strong && "text-primary")}>{value}</dd>
    </div>
  );
}
