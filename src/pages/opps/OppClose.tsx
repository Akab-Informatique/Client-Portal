import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Archive, CheckCircle2, Loader2, RotateCcw, XCircle, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { OPP_LOST_REASONS } from "@shared/opps";
import { Card } from "./OppCard";
import { oppError, useOppMutation, type OppDetail, type OppLostReason } from "./shared";

type Outcome = "won" | "lost" | "canceled";

/** Close the opportunity as won, lost or canceled (it is then archived), or reopen it. */
export function OppClose({ o }: { o: OppDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const [pending, setPending] = useState<Outcome | null>(null);
  const [reason, setReason] = useState<OppLostReason>("price");
  const [note, setNote] = useState("");
  const canManage = can("opps.manage");
  const open = o.status === "new" || o.status === "working";

  const close = useOppMutation(
    (outcome: Outcome) => api.post(`/opps/${o.id}/close`, { status: outcome, ...(outcome === "lost" ? { lostReason: reason } : {}), closeNote: note.trim() || null }),
    () => {
      toast.success(t("opps.detail.close.closed"));
      setPending(null);
    },
    (e) => toast.error(oppError(e, t)),
  );
  const reopen = useOppMutation(
    () => api.post(`/opps/${o.id}/reopen`, {}),
    () => toast.success(t("opps.detail.reopened")),
    (e) => toast.error(oppError(e, t)),
  );

  if (!open) {
    const tone = o.status === "won" ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200" : o.status === "lost" ? "border-red-400/50 bg-red-400/10 text-red-200" : "border-zinc-400/40 bg-zinc-400/10 text-zinc-200";
    const Icon = o.status === "won" ? CheckCircle2 : o.status === "lost" ? XCircle : Ban;
    return (
      <div className={cn("flex flex-wrap items-center gap-3 rounded-xl border p-4 text-sm", tone)}>
        <Icon className="size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t(`opps.detail.outcome.${o.status as Outcome}`)}</div>
          {o.lostReason && <div className="text-xs opacity-80">{t(`opps.lostReasons.${o.lostReason}`)}</div>}
          {o.closeNote && <div className="whitespace-pre-wrap text-xs opacity-80">{o.closeNote}</div>}
          {o.closedAt && <div className="text-xs opacity-70">{t("opps.closedOn", { date: o.closedAt.slice(0, 10) })}</div>}
        </div>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => reopen.mutate(undefined)} disabled={reopen.isPending}>
            {reopen.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} {t("opps.detail.reopen")}
          </Button>
        )}
      </div>
    );
  }

  if (!canManage) return null;
  const noLink = o.links.length === 0;

  return (
    <Card title={t("opps.detail.close.title")}>
      <div className="flex flex-wrap gap-2">
        <span title={noLink ? t("opps.detail.close.needLink") : undefined} className="inline-flex">
          <Button size="sm" onClick={() => setPending("won")} disabled={noLink || close.isPending} className="bg-emerald-600 text-white hover:bg-emerald-500">
            <CheckCircle2 className="size-4" /> {t("opps.detail.close.won")}
          </Button>
        </span>
        <Button size="sm" variant="outline" onClick={() => setPending("lost")} disabled={close.isPending}>
          <XCircle className="size-4" /> {t("opps.detail.close.lost")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setPending("canceled")} disabled={close.isPending}>
          <Archive className="size-4" /> {t("opps.detail.close.canceled")}
        </Button>
      </div>
      {noLink && <p className="text-xs text-muted-foreground">{t("opps.detail.close.needLink")}</p>}

      {pending && (
        <div className="space-y-3 rounded-lg border border-[color:var(--gold)]/30 p-3">
          {pending === "lost" && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">{t("opps.detail.close.lostReason")}</span>
              <Select value={reason} onValueChange={(v) => setReason(v as OppLostReason)}>
                <SelectTrigger aria-label={t("opps.detail.close.lostReason")} className="h-9 w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPP_LOST_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`opps.lostReasons.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{t("opps.detail.close.note")}</span>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">{t("opps.detail.close.archiveNote")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={() => close.mutate(pending)} disabled={close.isPending}>
              {close.isPending && <Loader2 className="size-4 animate-spin" />} {t("opps.detail.close.confirm")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
