import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ticketErrorText } from "./shared";

/** A self-managed client company, as the tickets list shows it (tickets.selfManaged) */
export type ManagedCompany = { companyId: number; clientId: string; name: string; hidden: number; open: number };

/** The self-managed companies, for the "Clients autogérés" filter (only with the right) */
export function useManagedCompanies(enabled: boolean) {
  return useQuery({
    queryKey: ["tickets", "self-managed"],
    queryFn: () => api.get<ManagedCompany[]>("/tickets/self-managed-companies"),
    enabled,
    staleTime: 30_000,
  });
}

/** Take a hidden ticket of a self-managed client for AKAB, or send it back to the client's delegates */
export function useManagedMutations() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["tickets"] });
  const take = useMutation({
    mutationFn: (id: number) => api.post(`/tickets/${id}/take`),
    onSuccess: () => {
      refresh();
      toast.success(t("selfManaged.staff.takeDone"));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const sendBack = useMutation({
    mutationFn: (id: number) => api.post(`/tickets/${id}/send-back`),
    onSuccess: () => {
      refresh();
      toast.success(t("selfManaged.staff.sendBackDone"));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  return { take, sendBack };
}

/** Same actions behind a confirmation: what the buttons, the row menu and the window use */
export function useTakeOver() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const m = useManagedMutations();
  return {
    take: (id: number) =>
      void confirm({ title: t("selfManaged.staff.takeTitle"), description: t("selfManaged.staff.takeText"), confirmLabel: t("selfManaged.staff.takeCta") }).then((ok) => {
        if (ok) m.take.mutate(id);
      }),
    sendBack: (id: number) =>
      void confirm({ title: t("selfManaged.staff.sendBackTitle"), description: t("selfManaged.staff.sendBackText"), confirmLabel: t("selfManaged.staff.sendBackCta") }).then((ok) => {
        if (ok) m.sendBack.mutate(id);
      }),
    pending: m.take.isPending || m.sendBack.isPending,
  };
}

/** Small tag on a ticket: "Chez le client" (muted) or "AKAB" (gold). Nothing for other tickets. */
export function ManagedBadge({ managed, className }: { managed?: "client" | "akab" | null; className?: string }) {
  const { t } = useTranslation();
  if (!managed) return null;
  if (managed === "akab") {
    return (
      <span
        title={t("selfManaged.staff.badge.akabHint")}
        className={cn("inline-flex shrink-0 items-center rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-primary", className)}
      >
        {t("selfManaged.staff.badge.akab")}
      </span>
    );
  }
  return (
    <span
      title={t("selfManaged.staff.badge.clientHint")}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium text-muted-foreground", className)}
    >
      <Building2 className="size-3" />
      {t("selfManaged.staff.badge.client")}
    </span>
  );
}
