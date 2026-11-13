import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { projError } from "./ProjComposer";

/**
 * "Make a project" from a ticket or a quote: asks first, then POST /api/proj/from-ticket|from-quote, then opens the new
 * project in the Tickets list (?pj=). `after` runs once it is made (the ticket window closes: the ticket is now closed).
 */
export function useMakeProject(after?: () => void) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const run = useMutation({
    mutationFn: (p: { path: string }) => api.post<{ id: string; number: string; billed?: boolean }>(p.path, {}),
    onSuccess: (r, p) => {
      void qc.invalidateQueries({ queryKey: ["proj"] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      void qc.invalidateQueries({ queryKey: ["quotes"] });
      void qc.invalidateQueries({ queryKey: ["billables"] });
      toast.success(t(p.path.includes("from-ticket") ? "projBill.fromTicket.done" : "projBill.fromQuote.done", { number: r.number }));
      if (r.billed) toast.success(t("projBill.fromQuote.billed"));
      after?.();
      navigate(`/pipeline?section=tickets&pj=${r.id}`);
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const fromTicket = async (ticketId: number) => {
    const ok = await confirm({ title: t("projBill.fromTicket.title"), description: t("projBill.fromTicket.text"), confirmLabel: t("projBill.fromTicket.confirm") });
    if (ok) run.mutate({ path: `/proj/from-ticket/${ticketId}` });
  };
  const fromQuote = async (quoteId: string) => {
    const ok = await confirm({ title: t("projBill.fromQuote.title"), description: t("projBill.fromQuote.text"), confirmLabel: t("projBill.fromQuote.confirm") });
    if (ok) run.mutate({ path: `/proj/from-quote/${quoteId}` });
  };
  return { fromTicket, fromQuote, pending: run.isPending };
}
