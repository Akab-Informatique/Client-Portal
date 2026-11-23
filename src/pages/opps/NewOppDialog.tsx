import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, PhoneCall, Wrench } from "lucide-react";
import { AiTextarea } from "@/components/AiPolish";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/api";
import { useDraft } from "@/lib/useDraft";
import { cn } from "@/lib/utils";
import { OPP_HANDLINGS, OPP_SOURCES, type OppHandling, type OppSource } from "@shared/opps";
import { ClientPick } from "./ClientPick";
import { NotifyPicker } from "./NotifyPicker";
import { oppError, useOppCandidates, useOppClients, useOppContacts, useOppMutation, type OppClient } from "./shared";

/**
 * What the new window starts from when it is made from a ticket: the server takes the client and, when it can, the
 * contact from the ticket itself. The client is only searched here to help pick a contact when the server cannot.
 */
export type OppPrefill = { ticketId: number; number: string; clientName: string | null; contactId: string | null };

type Created = { id: string; number: string; notified?: number; notifyFailed?: number };

/** Flag a new opportunity: client, contact, what is asked, origin, what to do, and who is told by email. */
export function NewOppDialog({ onClose, onCreated, prefill }: { onClose: () => void; onCreated: (id: string) => void; prefill?: OppPrefill }) {
  const { t } = useTranslation();
  const [client, setClient] = useState<OppClient | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [needContact, setNeedContact] = useState(false);
  const [source, setSource] = useState<OppSource>("tech_call");
  const [handling, setHandling] = useState<OppHandling>("quote_only");
  const [notify, setNotify] = useState<string[]>([]);
  const [text, setText, clearText] = useDraft(prefill ? `opp:ticket:${prefill.ticketId}` : "opp:new");
  const candidates = useOppCandidates();
  // the ticket's company is searched by its name, to preselect it
  const byName = useOppClients(prefill?.clientName ?? "", Boolean(prefill?.clientName));
  const contacts = useOppContacts(client?.id ?? null);
  const seeded = useRef(false);

  useEffect(() => {
    if (!prefill || client || !byName.data) return;
    const want = (prefill.clientName ?? "").trim().toLowerCase();
    const hit = byName.data.find((c) => c.name.trim().toLowerCase() === want);
    if (hit) setClient(hit);
  }, [prefill, client, byName.data]);
  useEffect(() => {
    if (seeded.current || !candidates.data) return;
    seeded.current = true;
    setNotify(candidates.data.filter((c) => c.sales).map((c) => c.id));
  }, [candidates.data]);
  // the ticket's contact, once the client's contacts are loaded
  useEffect(() => {
    if (!prefill?.contactId || !contacts.data || contactId) return;
    if (contacts.data.some((c) => c.id === prefill.contactId)) setContactId(prefill.contactId);
  }, [prefill, contacts.data, contactId]);

  const activeContacts = contacts.data ?? [];
  // from a ticket the server finds the client; without one the client and the contact are both required
  const ready = Boolean(text.trim()) && (prefill ? !needContact || Boolean(contactId) : Boolean(client && contactId));

  const save = useOppMutation(
    () =>
      api.post<Created>("/opps", {
        description: text.trim(),
        handling,
        notifyUserIds: notify,
        ...(prefill
          ? { ticketId: prefill.ticketId, ...(contactId ? { contactId } : {}) }
          : { clientId: client?.id, contactId, source }),
      }),
    (r) => {
      clearText();
      const n = r.notified ?? 0;
      toast.success(n > 0 ? t("opps.create.savedNotified", { number: r.number, count: n }) : t("opps.create.saved", { number: r.number }));
      if (r.notifyFailed) toast.error(t("opps.create.notifyFailed"));
      onCreated(r.id);
    },
    (e) => {
      // the server could not match a contact to the ticket: the contact picker is shown for the client
      if (e instanceof ApiError && e.code === "contact_required") setNeedContact(true);
      toast.error(oppError(e, t));
    },
  );

  const showContact = !prefill || needContact || Boolean(client);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("opps.create.title")}</DialogTitle>
          <DialogDescription>{prefill ? t("opps.create.ticketPrefill", { number: prefill.number }) : t("opps.create.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          {(!prefill || needContact || client) && (
            <div className="space-y-1.5">
              <Label>{t("opps.create.client")}</Label>
              <ClientPick
                value={client}
                onChange={(c) => {
                  setClient(c);
                  setContactId(null);
                }}
                label={t("opps.create.client")}
                placeholder={t("opps.create.clientPick")}
              />
            </div>
          )}
          {showContact && (
            <div className="space-y-1.5">
              <Label>{t("opps.create.contact")}</Label>
              <Select value={contactId ?? ""} onValueChange={setContactId} disabled={!client}>
                <SelectTrigger aria-label={t("opps.create.contact")} className="h-9 w-full">
                  <SelectValue placeholder={client && contacts.isSuccess && activeContacts.length === 0 ? t("opps.create.contactNone") : t("opps.create.contactPick")} />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {activeContacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.email ? ` · ${c.email}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {prefill && needContact && <p className="text-xs text-muted-foreground">{t("opps.errors.contact_required")}</p>}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="opp-what">{t("opps.create.what")}</Label>
          <AiTextarea id="opp-what" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("opps.create.whatPlaceholder")} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {!prefill && (
            <div className="space-y-1.5">
              <Label>{t("opps.create.source")}</Label>
              <Select value={source} onValueChange={(v) => setSource(v as OppSource)}>
                <SelectTrigger aria-label={t("opps.create.source")} className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPP_SOURCES.filter((s) => s !== "ticket").map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`opps.sources.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t("opps.create.notify")}</Label>
            <NotifyPicker people={candidates.data ?? []} value={notify} onChange={setNotify} />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>{t("opps.create.handling")}</Label>
          <div role="radiogroup" aria-label={t("opps.create.handling")} className="grid gap-2 sm:grid-cols-2">
            {OPP_HANDLINGS.map((h) => {
              const on = handling === h;
              const Icon = h === "quote_only" ? Wrench : PhoneCall;
              return (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setHandling(h)}
                  className={cn("flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors", on ? "border-[color:var(--gold)] bg-[color:var(--gold)]/10" : "hover:border-[color:var(--gold)]/40")}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon className={cn("size-4", on && "text-[color:var(--gold)]")} />
                    {t(h === "quote_only" ? "opps.create.handlingQuote" : "opps.create.handlingCall")}
                  </span>
                  <span className="text-xs text-muted-foreground">{t(h === "quote_only" ? "opps.create.handlingQuoteHint" : "opps.create.handlingCallHint")}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!ready || save.isPending}>
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("opps.create.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
