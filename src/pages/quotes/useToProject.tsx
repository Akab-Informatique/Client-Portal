import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderKanban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { money } from "@/pages/crm/shared";
import { lineAmount, projectSaleOf, TECH_TIME_SKU } from "@shared/quotes";
import type { Quote, QuoteListItem } from "./shared";

/**
 * Quote → a project of Projets (sold as a package: the hours and the price sold, from the quote's hour lines,
 * changeable) + a point for the weekly meeting. Once per quote.
 */
export function useToProject() {
  const can = useCan();
  const [open, setOpen] = useState<Pick<QuoteListItem, "id" | "number" | "clientName"> | null>(null);
  return {
    pending: false,
    /** Who can do it, and for which quote (a client, lines, not done yet) */
    allowed: (q: Pick<QuoteListItem, "clientId" | "lineCount" | "projectTicketId" | "projectId">) => can("quotes.manage") && can("projects.edit") && Boolean(q.clientId) && q.lineCount > 0 && !q.projectTicketId && !q.projectId,
    start: async (q: Pick<QuoteListItem, "id" | "number" | "clientName">) => setOpen(q),
    dialog: open ? <ToProjectDialog quote={open} onClose={() => setOpen(null)} /> : null,
  };
}

function ToProjectDialog({ quote, onClose }: { quote: Pick<QuoteListItem, "id" | "number" | "clientName">; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const nav = useNavigate();
  const full = useQuery({ queryKey: ["quotes", "one", quote.id], queryFn: () => api.get<Quote>(`/quotes/${quote.id}`) });
  const sold = full.data ? projectSaleOf(full.data.lines) : null;
  const [hours, setHours] = useState<string | null>(null);
  const [price, setPrice] = useState<string | null>(null);
  const [due, setDue] = useState("");
  const num = (v: string) => Number(v.replace(/\s/g, "").replace(",", "."));
  const h = hours ?? (sold?.hours != null ? String(sold.hours) : "");
  const pr = price ?? (sold ? String(sold.priceCents / 100) : "");
  const valid = (h === "" || (Number.isFinite(num(h)) && num(h) >= 0)) && pr !== "" && Number.isFinite(num(pr)) && num(pr) >= 0;
  const make = useMutation({
    mutationFn: () => api.post<{ projectId: string; projectNumber: string }>(`/quotes/${quote.id}/to-project`, { hours: h === "" ? null : num(h), price: num(pr), dueDate: due || null }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["quotes"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["meetings"] });
      toast.success(t("quotes.project.done", { number: r.projectNumber }), {
        action: { label: t("quotes.project.open"), onClick: () => nav(`/projects?project=${r.projectId}&tab=overview`) },
      });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? t(`quotes.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error")),
  });
  const rate = h && num(h) > 0 && pr ? (num(pr) * 100) / num(h) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderKanban className="size-5 text-primary" /> {t("quotes.project.confirmTitle", { number: quote.number })}
          </DialogTitle>
          <DialogDescription>{t("quotes.project.confirmText", { client: quote.clientName ?? "" })}</DialogDescription>
        </DialogHeader>
        {full.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tp-h">{t("quotes.project.hours")}</Label>
                <Input id="tp-h" inputMode="decimal" value={h} onChange={(e) => setHours(e.target.value)} placeholder="30" className="text-right font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tp-p">{t("quotes.project.price")}</Label>
                <Input id="tp-p" inputMode="decimal" value={pr} onChange={(e) => setPrice(e.target.value)} className="text-right font-mono" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {sold?.hours != null ? (full.data?.lines.some((l) => (l.sku ?? "").toUpperCase() === TECH_TIME_SKU) ? t("quotes.project.fromSku", { sku: TECH_TIME_SKU }) : t("quotes.project.fromLines")) : t("quotes.project.noHourLines", { sku: TECH_TIME_SKU })}
              {rate != null && ` ${t("quotes.project.rate", { rate: money(Math.round(rate), i18n.language) })}`}
            </p>
            <div className="space-y-1.5">
              <Label>{t("quotes.project.charges", { count: sold?.charges.length ?? 0 })}</Label>
              {sold?.charges.length ? (
                <ul className="max-h-36 divide-y divide-border/60 overflow-y-auto rounded-xl border bg-background/30 text-xs">
                  {sold.charges.map((l) => (
                    <li key={l.id} className="flex items-baseline gap-2 px-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate" title={l.description}>
                        {l.quantityX100 / 100} × {l.description}
                      </span>
                      <span className="shrink-0 font-mono">{money(lineAmount(l), i18n.language)}</span>
                    </li>
                  ))}
                  <li className="flex justify-between px-3 py-1.5 font-medium">
                    <span>{t("quotes.project.chargesTotal")}</span>
                    <span className="font-mono">{money(sold.chargesCents, i18n.language)}</span>
                  </li>
                </ul>
              ) : (
                <p className="rounded-xl border border-dashed px-3 py-2 text-xs text-muted-foreground">{t("quotes.project.noCharges")}</p>
              )}
              <p className="text-[11px] text-muted-foreground">{t("quotes.project.chargesHelp")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tp-d">{t("quotes.project.due")}</Label>
              <Input id="tp-d" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-44" />
            </div>
            <p className="rounded-xl border bg-background/30 p-3 text-xs text-muted-foreground">{t("quotes.project.billingHelp")}</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={!valid || make.isPending || full.isLoading} onClick={() => make.mutate()}>
            {make.isPending ? <Loader2 className="size-4 animate-spin" /> : <FolderKanban className="size-4" />} {t("quotes.project.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
