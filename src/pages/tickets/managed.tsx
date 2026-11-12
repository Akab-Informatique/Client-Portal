import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, EyeOff } from "lucide-react";
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

/** Hide a ticket of a self-managed client from its delegates, or show it to them again (tickets.edit) */
export function useDelegateVisibility() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: ({ id, hidden }: { id: number; hidden: boolean }) => api.post(`/tickets/${id}/delegate-visibility`, { hidden }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t(v.hidden ? "selfManaged.staff.hide.done" : "selfManaged.staff.show.done"));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  return {
    toggle: (id: number, hidden: boolean) =>
      void confirm({
        title: t(hidden ? "selfManaged.staff.hide.title" : "selfManaged.staff.show.title"),
        description: t(hidden ? "selfManaged.staff.hide.text" : "selfManaged.staff.show.text"),
        confirmLabel: t(hidden ? "selfManaged.staff.hide.cta" : "selfManaged.staff.show.cta"),
      }).then((ok) => {
        if (ok) m.mutate({ id, hidden });
      }),
    pending: m.isPending,
  };
}

/** Small tag on a ticket hidden from the client's delegates. Nothing for other tickets. */
export function HiddenBadge({ hidden, className }: { hidden?: boolean | null; className?: string }) {
  const { t } = useTranslation();
  if (!hidden) return null;
  return (
    <span
      title={t("selfManaged.staff.hiddenHint")}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-300", className)}
    >
      <EyeOff className="size-3" />
      {t("selfManaged.staff.hidden")}
    </span>
  );
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
