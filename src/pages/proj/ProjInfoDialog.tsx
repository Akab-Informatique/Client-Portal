import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AiTextarea } from "@/components/AiPolish";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import type { ProjDetail, QuoteSnapshot } from "./shared";
import { projError } from "./ProjComposer";

/**
 * "Info du projet": the description and the sales notes (saved when the box is left), and the copy of the quote the
 * project was made from (read only).
 */
export function ProjInfoDialog({ project, onClose }: { project: ProjDetail; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const lang = i18n.language === "en" ? "en" : "fr";
  const closed = project.status === "done" || project.status === "cancelled";
  const canEdit = can("proj.edit") && !closed;

  const [description, setDescription] = useState(project.description);
  const [salesNotes, setSalesNotes] = useState(project.salesNotes);

  const save = useMutation({
    mutationFn: (fields: Record<string, string>) => api.patch(`/proj/${project.id}`, fields),
    onSuccess: () => {
      toast.success(t("projWork.info.saved"));
      void qc.invalidateQueries({ queryKey: ["proj"] });
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const blurSave = (field: "description" | "salesNotes", value: string, saved: string) => {
    if (!canEdit || value === saved) return;
    save.mutate({ [field]: value });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("projWork.info.title")}</DialogTitle>
          <DialogDescription className="text-xs">
            {project.number} · {project.name}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-3">
            <div className="space-y-1">
              <label htmlFor={`pi-desc-${project.id}`} className="text-xs font-medium text-muted-foreground">
                {t("projWork.info.description")}
              </label>
              <AiTextarea
                id={`pi-desc-${project.id}`}
                rows={5}
                maxLength={8000}
                value={description}
                disabled={!canEdit}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => blurSave("description", description, project.description)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`pi-sales-${project.id}`} className="text-xs font-medium text-muted-foreground">
                {t("projWork.info.salesNotes")}
              </label>
              <AiTextarea
                id={`pi-sales-${project.id}`}
                rows={4}
                maxLength={8000}
                value={salesNotes}
                disabled={!canEdit}
                onChange={(e) => setSalesNotes(e.target.value)}
                onBlur={() => blurSave("salesNotes", salesNotes, project.salesNotes)}
              />
            </div>
            {!canEdit && <p className="text-xs text-muted-foreground">{t("projWork.info.readOnly")}</p>}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t("projWork.quote.title")}</h3>
            {project.quote ? <QuoteCopy quote={project.quote} lang={lang} /> : <p className="text-sm text-muted-foreground">{t("projWork.quote.none")}</p>}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QuoteCopy({ quote, lang }: { quote: QuoteSnapshot; lang: "fr" | "en" }) {
  const { t } = useTranslation();
  const locale = lang === "en" ? "en-CA" : "fr-CA";
  const qty = (x100: number) => (x100 / 100).toLocaleString(locale, { maximumFractionDigits: 2 });
  const recurrenceLabel = (r: string | undefined) => (r === "monthly" ? t("projWork.quote.monthly") : r === "yearly" ? t("projWork.quote.yearly") : t("projWork.quote.once"));
  const recurrenceTone = (r: string | undefined) => (r === "monthly" ? "border-sky-400/40 text-sky-200" : r === "yearly" ? "border-amber-400/40 text-amber-200" : "border-border text-muted-foreground");

  return (
    <div className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-semibold">
          {t("projWork.quote.number")} {quote.number}
        </span>
        <span className="min-w-0 flex-1 truncate">{quote.title}</span>
        <span className="rounded-full border px-2 py-px text-xs text-muted-foreground">
          {t("projWork.quote.status")}: {quote.status}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1.5 pr-3 font-medium">
                {t("projWork.quote.description")}
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                {t("projWork.quote.qty")}
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                {t("projWork.quote.unit")}
              </th>
              <th scope="col" className="py-1.5 font-medium">
                {t("projWork.quote.recurrence")}
              </th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((l, i) => (
              <tr key={i} className={cn("border-b border-border/60 align-top", l.optional && "opacity-60")}>
                <td className="py-2 pr-3">
                  <div className="font-medium">{l.description}</div>
                  {l.details && <div className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{l.details}</div>}
                  {l.optional && <span className="mt-1 inline-block rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground">{t("projWork.quote.optional")}</span>}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{qty(l.quantityX100)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(l.unitPriceCents, lang)}</td>
                <td className="py-2">
                  <span className={cn("rounded-full border px-2 py-px text-xs", recurrenceTone(l.recurrence))}>{recurrenceLabel(l.recurrence)}</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2} className="pt-2 text-right text-xs font-medium text-muted-foreground">
                {t("projWork.quote.total")}
              </th>
              <td colSpan={2} className="pt-2 text-right font-semibold tabular-nums">
                {money(quote.totalCents, lang)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {quote.notes && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("projWork.quote.notes")}</p>
          <p className="whitespace-pre-wrap text-sm">{quote.notes}</p>
        </div>
      )}
    </div>
  );
}
