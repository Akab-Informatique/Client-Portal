import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Copy, Loader2, Mail, Phone, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { OPP_HANDLINGS, type OppHandling } from "@shared/opps";
import { useTicketWorkspace } from "@/pages/tickets/workspace";
import { Card } from "./OppCard";
import { OppClose } from "./OppClose";
import { OppJournal } from "./OppJournal";
import { OppLinks } from "./OppLinks";
import { oppError, SOURCE_ICON, STATUS_TONE, useOpp, useOppCandidates, useOppMutation, type OppDetail } from "./shared";

/** The opportunity window: origin, who has it, what it became (links), how it ends, and the journal. */
export function OppDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const q = useOpp(id);
  const o = q.data;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        {!o ? (
          <div className="flex justify-center py-16">
            {q.isError ? <p className="text-sm text-muted-foreground">{t("opps.common.error")}</p> : <Loader2 className="size-6 animate-spin text-muted-foreground" />}
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10 px-1.5 py-0.5 font-mono text-xs text-[color:var(--gold)]">{o.number}</span>
                <Badge variant="outline" className={STATUS_TONE[o.status]}>
                  {t(`opps.statuses.${o.status}`)}
                </Badge>
              </div>
              <DialogTitle className="text-xl">
                {o.client ? (
                  <Link to={`/crm/${o.client.id}`} className="hover:text-[color:var(--gold)] hover:underline">
                    {o.client.name}
                  </Link>
                ) : (
                  t("opps.unknownClient")
                )}
              </DialogTitle>
              <DialogDescription className="sr-only">{t("opps.detail.number", { number: o.number })}</DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-2">
              <Card title={t("opps.detail.contact")}>
                <ContactBlock o={o} />
              </Card>
              <Card title={t("opps.detail.origin")}>
                <OriginBlock o={o} />
              </Card>
            </div>

            <Card title={t("opps.detail.description")}>
              <p className="whitespace-pre-wrap break-words text-sm">{o.description}</p>
            </Card>

            <OwnerCard o={o} canManage={can("opps.manage")} />

            <OppLinks o={o} />

            <OppClose o={o} />

            <OppJournal o={o} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ContactBlock({ o }: { o: OppDetail }) {
  const { t } = useTranslation();
  if (!o.contact) return <p className="text-sm text-muted-foreground">{t("opps.noContact")}</p>;
  const c = o.contact;
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value).then(() => toast.success(t("opps.detail.copied")), () => undefined);
  };
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <UserRound className="size-4 text-muted-foreground" /> {c.name}
      </div>
      {c.phone ? (
        <div className="flex items-center gap-2">
          <Phone className="size-4 text-muted-foreground" />
          <a href={`tel:${c.phone}`} className="hover:underline">{c.phone}</a>
          <button type="button" onClick={() => copy(c.phone!)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label={`${t("opps.detail.copy")} ${c.phone}`}>
            <Copy className="size-3.5" />
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("opps.detail.noPhone")}</p>
      )}
      {c.email ? (
        <div className="flex items-center gap-2">
          <Mail className="size-4 text-muted-foreground" />
          <a href={`mailto:${c.email}`} className="truncate hover:underline">{c.email}</a>
          <button type="button" onClick={() => copy(c.email!)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label={`${t("opps.detail.copy")} ${c.email}`}>
            <Copy className="size-3.5" />
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("opps.detail.noEmail")}</p>
      )}
    </div>
  );
}

function OriginBlock({ o }: { o: OppDetail }) {
  const { t } = useTranslation();
  const ws = useTicketWorkspace();
  const Icon = SOURCE_ICON[o.source];
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <Icon className="size-4 text-muted-foreground" /> {t(`opps.sources.${o.source}`)}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("opps.detail.flaggedBy", { name: o.createdBy ?? t("opps.detail.system"), date: `${o.createdAt.slice(0, 10)} · ${relativeTime(o.createdAt)}` })}
      </p>
      {o.ticket ? (
        <button
          type="button"
          onClick={() => ws.open(o.ticket!.id)}
          className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-[color:var(--gold)]/40 px-2.5 py-1 text-xs text-[color:var(--gold)] hover:bg-[color:var(--gold)]/10"
          title={t("opps.detail.originTicket")}
        >
          <span className="font-mono">{o.ticket.number}</span>
          <span className="truncate">{o.ticket.title}</span>
        </button>
      ) : (
        <p className="text-xs text-muted-foreground">{t("opps.detail.originNone")}</p>
      )}
    </div>
  );
}

/** Who has it, and what to do: take it, hand it to another sales technician, the handling. */
function OwnerCard({ o, canManage }: { o: OppDetail; canManage: boolean }) {
  const { t } = useTranslation();
  const candidates = useOppCandidates(canManage);
  const [assignTo, setAssignTo] = useState<string | null>(null);
  const take = useOppMutation(
    () => api.post(`/opps/${o.id}/take`, {}),
    () => toast.success(t("opps.detail.take_done")),
    (e) => toast.error(oppError(e, t)),
  );
  const patch = useOppMutation(
    (body: { ownerId?: string | null; handling?: OppHandling }) => api.patch(`/opps/${o.id}`, body),
    () => {
      setAssignTo(null);
      toast.success(t("opps.detail.assignSaved"));
    },
    (e) => toast.error(oppError(e, t)),
  );
  const open = o.status === "new" || o.status === "working";
  return (
    <Card title={t("opps.detail.owner")}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">{o.owner?.name ?? t("opps.notAssigned")}</span>
        {!o.owner && <span className="text-xs text-muted-foreground">{t("opps.detail.ownerNone")}</span>}
        {canManage && open && !o.owner && (
          <Button size="sm" variant="outline" onClick={() => take.mutate()} disabled={take.isPending}>
            {take.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("opps.detail.take")}
          </Button>
        )}
        {canManage && open && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("opps.detail.assign")}</span>
            <Select value={assignTo ?? o.owner?.id ?? "none"} onValueChange={(v) => setAssignTo(v)}>
              <SelectTrigger aria-label={t("opps.detail.assign")} className="h-8 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("opps.detail.assignNone")}</SelectItem>
                {(candidates.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {assignTo !== null && assignTo !== (o.owner?.id ?? "none") && (
              <Button size="sm" onClick={() => patch.mutate({ ownerId: assignTo === "none" ? null : assignTo })} disabled={patch.isPending}>
                {t("opps.create.save")}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs text-muted-foreground">{t("opps.detail.handling")}</span>
        {canManage && open ? (
          <Select value={o.handling} onValueChange={(v) => patch.mutate({ handling: v as OppHandling })}>
            <SelectTrigger aria-label={t("opps.detail.handling")} className="h-8 w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPP_HANDLINGS.map((h) => (
                <SelectItem key={h} value={h}>
                  {t(`opps.handling.${h}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant="outline">{t(`opps.handling.${o.handling}`)}</Badge>
        )}
      </div>
    </Card>
  );
}
