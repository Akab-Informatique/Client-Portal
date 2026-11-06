import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Hash, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";

/** A duplicate number in QuickBooks (a credit memo or an invoice typed there took it) */
export const isDuplicateNumber = (error: string) => /duplicate|doublon|d[ée]j[àa] utilis|6140/i.test(error);

/**
 * The red "Erreur" of an invoice's QuickBooks column, as a button: the whole error, and what fixes it right there —
 * send it again, or (a portal invoice not in QuickBooks yet) take a new number when QuickBooks already has this one.
 */
export function QbErrorBadge({ invoice }: { invoice: { id: string; number: string; source?: string; status: string; quickbooks?: { id: string | null; error: string | null } | null } }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const error = invoice.quickbooks?.error ?? "";
  const manage = can("accounting.manage") && invoice.status !== "voided";
  const canRenumber = manage && !invoice.quickbooks?.id && invoice.source === "portal";
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? t(`crm.invoices.qb.errors.${e.code}`, { defaultValue: e.message || t("crm.invoices.qb.failed") }) : t("crm.invoices.qb.failed"));
  const refresh = () => void qc.invalidateQueries({ queryKey: ["crm"] });
  const send = useMutation({ mutationFn: () => api.post(`/crm/invoices/${invoice.id}/quickbooks`), onSuccess: () => toast.success(t("crm.invoices.qb.sent")), onError: fail, onSettled: refresh });
  const renumber = useMutation({
    mutationFn: () => api.post<{ from: string; number: string; quickbooks: { quickbooksId?: string } }>(`/crm/invoices/${invoice.id}/renumber`),
    onSuccess: (r) => (r.quickbooks?.quickbooksId ? toast.success(t("crm.invoices.qb.renumbered", { from: r.from, to: r.number })) : toast.warning(t("crm.invoices.qb.renumberedNotSent", { from: r.from, to: r.number }))),
    onError: fail,
    onSettled: refresh,
  });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10" title={error}>
          {t("allInvoices.qbErrorShort")}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2 text-xs">
        <p className="flex items-center gap-1.5 font-medium text-red-300">
          <AlertTriangle className="size-3.5" /> {t("qbFix.title", { number: invoice.number })}
        </p>
        <p className="whitespace-pre-wrap break-words rounded-lg border bg-background/40 p-2 font-mono text-[11px]">{error}</p>
        {isDuplicateNumber(error) && <p className="text-muted-foreground">{t("qbFix.duplicate")}</p>}
        {manage && (
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {canRenumber && (
              <Button
                size="sm"
                className="h-7 bg-grad-gold text-xs font-semibold text-[#1a1204] hover:brightness-105"
                disabled={renumber.isPending}
                onClick={() => void confirm({ title: t("crm.invoices.qb.renumberTitle", { number: invoice.number }), description: t("crm.invoices.qb.renumberText"), confirmLabel: t("crm.invoices.qb.renumber") }).then((ok) => ok && renumber.mutate())}
              >
                {renumber.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Hash className="size-3.5" />} {t("crm.invoices.qb.renumber")}
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("crm.invoices.qb.resend")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
