import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CornerDownRight, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ticketErrorText } from "@/pages/tickets/shared";
import { crmErrorText } from "./shared";

type Own = "on" | "off" | null;
type Choice = "inherit" | "on" | "off";
type SelfState = {
  own: Own;
  effective: boolean;
  inheritedFrom: { id: string; name: string } | null;
  children: { id: string; name: string; own: Own; effective: boolean }[];
};
type Preview = {
  clients: { id: string; name: string }[];
  openTickets: number;
  withTechnician: { name: string; count: number }[];
  timers: number;
  pins: number;
  plannedBlocks: number;
  alerts: number;
};

/** The state a company shows: its own setting, else what it inherits from its parent */
function stateText(t: (k: string, o?: Record<string, unknown>) => string, own: Own, effective: boolean, from: { name: string } | null) {
  if (own === "off" || !effective) return t("selfManaged.staff.card.off");
  if (own === "on") return t("selfManaged.staff.card.on");
  return from ? t("selfManaged.staff.card.onInherited", { name: from.name }) : t("selfManaged.staff.card.on");
}

/** Autogestion des billets on the client's Info tab: the state, the children, and (admin.clients) the setting with a preview */
export function SelfManagedCard({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const canSet = can("admin.clients");
  const qc = useQueryClient();
  const [choice, setChoice] = useState<Choice | null>(null);
  const { data } = useQuery({
    queryKey: ["crm", "client", clientId, "self-managed"],
    queryFn: () => api.get<SelfState>(`/crm/clients/${clientId}/self-managed`),
    enabled: can("crm.view"),
  });
  const preview = useQuery({
    queryKey: ["crm", "client", clientId, "self-managed-preview", choice],
    queryFn: () => api.get<Preview>(`/crm/clients/${clientId}/self-managed/preview?value=${choice}`),
    enabled: choice !== null && canSet,
  });
  const save = useMutation({
    mutationFn: (value: Choice) => api.put(`/crm/clients/${clientId}/self-managed`, { value: value === "inherit" ? null : value }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm"] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("selfManaged.staff.card.saved"));
      setChoice(null);
    },
    onError: (e) => toast.error(crmErrorText(t, e) ?? ticketErrorText(t, e)),
  });

  if (!data || !can("crm.view")) return null;
  const current: Choice = data.own ?? "inherit";
  const p = preview.data;

  return (
    <section className="glass space-y-4 rounded-2xl border p-4 lg:col-span-full">
      <div className="flex items-center gap-2">
        <span className="text-primary">
          <Users className="size-4" />
        </span>
        <h2 className="text-sm font-semibold">{t("selfManaged.staff.card.title")}</h2>
      </div>
      <p className="text-xs text-muted-foreground">{t("selfManaged.staff.card.hint")}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("selfManaged.staff.card.current")}</p>
          <p className={cn("text-sm font-semibold", data.effective ? "text-primary" : "text-muted-foreground")}>{stateText(t, data.own, data.effective, data.inheritedFrom)}</p>
          {canSet && (
            <select
              aria-label={t("selfManaged.staff.card.setting")}
              value={current}
              disabled={save.isPending}
              onChange={(e) => {
                const v = e.target.value as Choice;
                if (v !== current) setChoice(v);
              }}
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40 disabled:opacity-60"
            >
              <option value="inherit">{t("selfManaged.staff.card.inherit")}</option>
              <option value="on">{t("selfManaged.staff.card.on")}</option>
              <option value="off">{t("selfManaged.staff.card.off")}</option>
            </select>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("selfManaged.staff.card.children")}</p>
          {data.children.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("selfManaged.staff.card.noChildren")}</p>
          ) : (
            <ul className="space-y-1">
              {data.children.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm">
                  <CornerDownRight className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className={cn("text-xs", c.effective ? "text-primary" : "text-muted-foreground")}>
                    {c.own == null ? (c.effective ? t("selfManaged.staff.card.onFromParent") : t("selfManaged.staff.card.offFromParent")) : stateText(t, c.own, c.effective, null)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Dialog open={choice !== null} onOpenChange={(o) => !o && setChoice(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("selfManaged.staff.preview.title")}</DialogTitle>
            <DialogDescription>{t(choice === "off" ? "selfManaged.staff.preview.textOff" : choice === "on" ? "selfManaged.staff.preview.textOn" : "selfManaged.staff.preview.textInherit")}</DialogDescription>
          </DialogHeader>
          {preview.isLoading || !p ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <Row label={t("selfManaged.staff.preview.companies")} value={p.clients.map((c) => c.name).join(", ") || "—"} />
              <Row label={t("selfManaged.staff.preview.open")} value={String(p.openTickets)} />
              <div className="space-y-1">
                <p className="text-muted-foreground">{t("selfManaged.staff.preview.technicians")}</p>
                {p.withTechnician.length === 0 ? (
                  <p className="text-xs text-muted-foreground">—</p>
                ) : (
                  <ul className="space-y-0.5 pl-2">
                    {p.withTechnician.map((x) => (
                      <li key={x.name} className="flex justify-between">
                        <span>{x.name}</span>
                        <span className="font-mono tabular-nums">{x.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Row label={t("selfManaged.staff.preview.timers")} value={String(p.timers)} />
              <Row label={t("selfManaged.staff.preview.pins")} value={String(p.pins)} />
              <Row label={t("selfManaged.staff.preview.blocks")} value={String(p.plannedBlocks)} />
              <Row label={t("selfManaged.staff.preview.alerts")} value={String(p.alerts)} />
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{t("selfManaged.staff.preview.warning")}</p>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setChoice(null)} disabled={save.isPending}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!p || save.isPending || choice === null} onClick={() => choice && save.mutate(choice)} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("selfManaged.staff.preview.confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b pb-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
