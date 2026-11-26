import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Receipt, Tag, Trash2 } from "lucide-react";
import { ChargeLabelDialog } from "@/pages/tickets/ChargeLabel";
import { AddCharge, errorText } from "@/pages/projects/ChargesTab";
import { useConfirm } from "@/components/ConfirmDialog";
import { SupplySelect } from "@/components/SupplySelect";
import { afterRebate } from "@/components/RebateInput";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { shortDate } from "@/pages/tickets/shared";
import type { ProjDetail } from "./shared";

type Charge = {
  id: string;
  name: string;
  description: string;
  quantity: number;
  unitPrice: number | null;
  rebate: number;
  unitCost: number | null;
  billable: boolean;
  date: string | null;
  author: string | null;
  supply: "ordered" | "received" | null;
  billing: { status: string; invoice: { id: string; number: string } | null } | null;
  total: number;
  removable: boolean;
};
type Charges = { items: Charge[]; totals: { count: number; billable: number } };

const money = (n: number) => new Intl.NumberFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(n);
const BILLING_STYLE: Record<string, string> = { pending: "border-amber-400/40 text-amber-300", approved: "border-emerald-400/40 text-emerald-300", excluded: "border-muted-foreground/40 text-muted-foreground", posted: "border-sky-400/40 text-sky-300", billed_before: "border-sky-400/40 text-sky-300" };

function useCharges(id: string) {
  return useQuery({ queryKey: ["proj", "charges", id], queryFn: () => api.get<Charges>(`/proj/${id}/charges`) });
}

/** The "Frais" tile of an opened project: how many charges and what is billable; a click opens the list. */
export function ChargesTile({ d, canEdit, className }: { d: ProjDetail; canEdit: boolean; className: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data } = useCharges(d.id);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <Receipt className="size-5 shrink-0 text-violet-300" aria-hidden />
        <span className="min-w-0">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.tile.charges")}</span>
          <span className="block text-sm">{data && data.totals.count > 0 ? t("proj.charges.tileValue", { count: data.totals.count, total: money(data.totals.billable) }) : t("proj.charges.tileEmpty")}</span>
        </span>
      </button>
      {open && <ChargesDialog d={d} canEdit={canEdit} onClose={() => setOpen(false)} />}
    </>
  );
}

function ChargesDialog({ d, canEdit, onClose }: { d: ProjDetail; canEdit: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState<Charge | null>(null);
  const key = ["proj", "charges", d.id];
  const { data, isLoading } = useCharges(d.id);
  const closed = d.status === "done" || d.status === "cancelled";
  const remove = useMutation({
    mutationFn: (id: string) => api.del<Charges>(`/proj/${d.id}/charges/${id}`),
    onSuccess: (next) => qc.setQueryData(key, next),
    onError: (e) => toast.error(errorText(t, e)),
  });
  const setSupply = useMutation({
    mutationFn: (v: { id: string; supply: string | null }) => api.put<Charges>(`/proj/${d.id}/charges/${v.id}/supply`, { supply: v.supply }),
    onSuccess: (next) => qc.setQueryData(key, next),
    onError: (e) => toast.error(errorText(t, e)),
  });
  const items = data?.items ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("projects.charges.title")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-violet-300">{d.number}</span> · {d.name}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">{t("proj.charges.hint")}</p>
          <span className="ml-auto font-mono text-sm">
            {t("projects.charges.total")} : <span className="font-semibold text-foreground">{money(data?.totals.billable ?? 0)}</span>
          </span>
          {canEdit && !closed && (
            <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> {t("projects.charges.add")}
            </Button>
          )}
        </div>
        {isLoading ? (
          <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{t("proj.charges.none")}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block truncate font-medium">{c.name}</span>
                  {c.description && <span className="block truncate text-xs text-muted-foreground">{c.description}</span>}
                  <span className="block text-[11px] text-muted-foreground">{[c.date ? shortDate(c.date) : null, c.author].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {c.quantity.toLocaleString()} ×{" "}
                  {c.unitPrice != null ? (c.rebate > 0 ? <><s>{money(c.unitPrice)}</s> {money(afterRebate(c.unitPrice, c.rebate))}</> : money(c.unitPrice)) : "—"}
                  {c.rebate > 0 && <span className="ml-1 text-emerald-300">−{c.rebate} %</span>}
                </span>
                <span className="w-24 text-right font-mono">{c.billable ? money(c.total) : <span className="text-muted-foreground">{t("projects.charges.notBilled")}</span>}</span>
                <button
                  type="button"
                  onClick={() => setLabel(c)}
                  title={t("tickets.charges.label.button")}
                  aria-label={t("tickets.charges.label.button")}
                  className="inline-flex items-center gap-1 rounded-md border border-[color:var(--gold)]/40 px-2 py-1 text-[11px] font-medium text-primary transition hover:bg-[color:var(--gold)]/10"
                >
                  <Tag className="size-3.5" /> {t("proj.charges.labelShort")}
                </button>
                <SupplySelect value={c.supply} disabled={!canEdit || setSupply.isPending} onChange={(v) => setSupply.mutate({ id: c.id, supply: v })} />
                {c.billable && c.billing && (
                  <span className={cn("rounded-full border px-2 py-0.5 text-[10px]", BILLING_STYLE[c.billing.status] ?? "text-muted-foreground")}>
                    {t(`projects.charges.billing.${c.billing.status === "billed_before" ? "posted" : c.billing.status}`)}
                    {c.billing.invoice ? ` · ${c.billing.invoice.number}` : ""}
                  </span>
                )}
                {canEdit && c.removable ? (
                  <button
                    type="button"
                    onClick={() => void confirm({ title: t("projects.charges.removeTitle"), description: t("projects.charges.removeText"), confirmLabel: t("common.delete"), destructive: true }).then((ok) => ok && remove.mutate(c.id))}
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                    className="rounded p-1 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                ) : (
                  <span className="text-[10px] text-muted-foreground">{t("chargeMove.locked")}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {label && (
          <ChargeLabelDialog
            charge={{ ...label, unitPrice: label.unitPrice === null ? null : afterRebate(label.unitPrice, label.rebate) }}
            context={{ number: d.number, title: d.name, client: d.client?.name ?? "" }}
            sizeText={t("projects.charges.labelSize")}
            onClose={() => setLabel(null)}
          />
        )}
        {adding && <AddCharge<Charges> p={d} base={`/proj/${d.id}/charges`} onClose={() => setAdding(false)} onAdded={(next) => qc.setQueryData(key, next)} />}
      </DialogContent>
    </Dialog>
  );
}
