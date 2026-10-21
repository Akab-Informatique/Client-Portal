import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import type { QuoteListItem } from "./shared";

/** Quote → project ticket + a point for the weekly meeting (asks first, once per quote). */
export function useToProject() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const can = useCan();
  const make = useMutation({
    mutationFn: (id: string) => api.post<{ ticketId: number; ticketNumber: string; meetingPointId: string }>(`/quotes/${id}/to-project`, {}),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["quotes"] });
      void qc.invalidateQueries({ queryKey: ["meetings"] });
      toast.success(t("quotes.project.done", { number: r.ticketNumber }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? t(`quotes.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error")),
  });
  return {
    pending: make.isPending,
    /** Who can do it, and for which quote (a client, lines, not done yet) */
    allowed: (q: Pick<QuoteListItem, "clientId" | "lineCount" | "projectTicketId">) => can("quotes.manage") && can("tickets.edit") && Boolean(q.clientId) && q.lineCount > 0 && !q.projectTicketId,
    start: async (q: Pick<QuoteListItem, "id" | "number" | "clientName">) => {
      const ok = await confirm({ title: t("quotes.project.confirmTitle", { number: q.number }), description: t("quotes.project.confirmText", { client: q.clientName ?? "" }), confirmLabel: t("quotes.project.confirm") });
      if (ok) make.mutate(q.id);
    },
  };
}
