import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileSignature, FilePlus2, FolderKanban, Link2, Loader2, Receipt, ReceiptText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { useTicketWorkspace } from "@/pages/tickets/workspace";
import { NewProjDialog } from "@/pages/proj/NewProjDialog";
import type { OppLinkKind } from "@shared/opps";
import { LinkDialog } from "./LinkDialog";
import { Card } from "./OppCard";
import { oppError, useOppMutation, type OppDetail, type OppLink } from "./shared";

const KIND_ICON: Record<OppLinkKind, typeof FileSignature> = { quote: FileSignature, contract: Receipt, charge: ReceiptText, project: FolderKanban };

/** "Ce que c'est devenu": the quote, contract, charge or project this opportunity became, and the ways to make or link one. */
export function OppLinks({ o }: { o: OppDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const navigate = useNavigate();
  const ws = useTicketWorkspace();
  const [linking, setLinking] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const open = o.status === "new" || o.status === "working";

  const createQuote = useOppMutation(
    async () => {
      const quote = await api.post<{ id: string; number: string }>("/quotes", {
        clientId: o.client?.id ?? null,
        prospectName: "",
        contactName: o.contact?.name ?? "",
        contactEmail: o.contact?.email ?? null,
        title: `Opportunité ${o.number}`,
        notes: "",
        internalNotes: o.description,
        lines: [],
      });
      await api.post(`/opps/${o.id}/links`, { kind: "quote", refId: quote.id });
      return quote;
    },
    (quote) => {
      toast.success(t("opps.detail.quoteCreated", { number: quote.number }));
      navigate(`/accounting/quotes/${quote.id}`);
    },
    (e) => toast.error(oppError(e, t) || t("opps.detail.quoteFailed")),
  );

  const unlink = useOppMutation(
    (linkId: string) => api.del(`/opps/${o.id}/links/${linkId}`),
    () => toast.success(t("opps.detail.linkRemoved")),
    (e) => toast.error(oppError(e, t)),
  );

  const addProject = useOppMutation(
    (refId: string) => api.post(`/opps/${o.id}/links`, { kind: "project", refId }),
    () => toast.success(t("opps.detail.linkAdded")),
    (e) => toast.error(oppError(e, t)),
  );

  const openLink = (l: OppLink) => {
    if (l.kind === "quote") navigate(`/accounting/quotes/${l.refId}`);
    else if (l.kind === "contract" && o.client) navigate(`/crm/${o.client.id}?tab=contracts&opp=${o.id}`);
    else if (l.kind === "project") navigate(`/pipeline?section=tickets&pj=${l.refId}`);
    else if (l.kind === "charge" && o.ticket) ws.open(o.ticket.id);
  };

  return (
    <Card title={t("opps.detail.whatBecame")}>
      {o.links.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("opps.detail.whatBecameNone")}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {o.links.map((l) => {
            const Icon = KIND_ICON[l.kind];
            return (
              <li key={l.id} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background/40 py-1 pl-2.5 pr-1 text-xs">
                <Icon className="size-3.5 shrink-0 text-[color:var(--gold)]" />
                <span className="text-muted-foreground">{t(`opps.link.kinds.${l.kind}`)}</span>
                <button type="button" onClick={() => openLink(l)} className="min-w-0 truncate font-medium hover:text-[color:var(--gold)] hover:underline" title={t("opps.detail.linkOpen")}>
                  {l.label}
                </button>
                {can("opps.manage") && open && (
                  <button type="button" onClick={() => unlink.mutate(l.id)} disabled={unlink.isPending} className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={`${t("opps.detail.linkRemove")} ${l.label}`}>
                    <X className="size-3" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {open && can("opps.manage") && (
        <div className="flex flex-wrap gap-2 pt-2">
          {can("quotes.manage") && o.client && (
            <Button size="sm" variant="outline" onClick={() => createQuote.mutate()} disabled={createQuote.isPending}>
              {createQuote.isPending ? <Loader2 className="size-4 animate-spin" /> : <FilePlus2 className="size-4" />} {t("opps.detail.createQuote")}
            </Button>
          )}
          {can("crm.view") && o.client && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/crm/${o.client!.id}?tab=contracts&opp=${o.id}`)}>
              <Receipt className="size-4" /> {t("opps.detail.createContract")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => (o.ticket ? ws.open(o.ticket.id) : toast.info(t("opps.detail.chargeNoTicket")))}
          >
            <ReceiptText className="size-4" /> {t("opps.detail.createCharge")}
          </Button>
          {can("proj.edit") && (
            <Button size="sm" variant="outline" onClick={() => setProjectOpen(true)}>
              <FolderKanban className="size-4" /> {t("opps.detail.createProject")}
            </Button>
          )}
          <Button size="sm" onClick={() => setLinking(true)}>
            <Link2 className="size-4" /> {t("opps.detail.linkExisting")}
          </Button>
        </div>
      )}
      {linking && <LinkDialog o={o} onClose={() => setLinking(false)} />}
      {projectOpen && (
        <NewProjDialog
          onClose={() => setProjectOpen(false)}
          onCreated={(id) => {
            setProjectOpen(false);
            addProject.mutate(id);
          }}
        />
      )}
    </Card>
  );
}
