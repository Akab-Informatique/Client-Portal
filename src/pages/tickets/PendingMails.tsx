import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MailQuestion, TicketPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { NewTicketDialog } from "./NewTicketDialog";
import type { TicketList } from "./shared";

type Pending = { id: string; from: string | null; fromName: string | null; subject: string; body: string; receivedAt: string | null; companyId: number | null; contactId: string | null };
const KEY = ["mail-intake", "pending"];

/**
 * Emails to the support mailbox nobody could be matched to: a technician picks
 * the client and contact in the usual New ticket window (filled with the email),
 * or leaves the email alone.
 */
export function PendingMails({ facets, onCreated }: { facets: TicketList["facets"]; onCreated: (ticketId: number) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState<Pending | null>(null);
  const { data } = useQuery({ queryKey: KEY, queryFn: () => api.get<{ items: Pending[] }>("/mail-intake/pending"), refetchInterval: 60_000 });
  const items = data?.items ?? [];
  const ignore = useMutation({
    mutationFn: (id: string) => api.post(`/mail-intake/${id}/ignore`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
    onError: () => toast.error(t("common.error")),
  });
  if (!items.length) return null;
  return (
    <>
      <Button size="sm" variant="outline" className="h-9 gap-1.5 border-amber-400/50 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20" onClick={() => setOpen(true)}>
        <MailQuestion className="size-4" /> {t("mailIntake.toSort", { count: items.length })}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("mailIntake.toSortTitle")}</DialogTitle>
            <DialogDescription>{t("mailIntake.toSortText")}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            {items.map((m) => (
              <li key={m.id} className="rounded-xl border bg-card/60 p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 truncate font-medium">{m.subject || t("mailIntake.noSubject")}</span>
                  <span className="text-[11px] text-muted-foreground">{m.receivedAt ? dateTime(m.receivedAt) : ""}</span>
                </div>
                <p className="text-xs text-muted-foreground">{m.fromName ? `${m.fromName} <${m.from}>` : m.from}</p>
                <p className="mt-2 line-clamp-3 whitespace-pre-line text-sm text-muted-foreground">{m.body}</p>
                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" className="h-8 gap-1.5 bg-grad-gold text-xs font-semibold text-[#1a1204]" onClick={() => setMaking(m)}>
                    <TicketPlus className="size-3.5" /> {t("mailIntake.makeTicket")}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs text-muted-foreground" disabled={ignore.isPending} onClick={() => ignore.mutate(m.id)}>
                    {ignore.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />} {t("mailIntake.ignore")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      {making && (
        <NewTicketDialog
          open
          onOpenChange={(o) => !o && setMaking(null)}
          facets={facets}
          initial={{ title: making.subject.replace(/^\s*((re|tr|fw|fwd|rv)\s*:\s*)+/i, ""), description: making.body, companyId: making.companyId, contactId: making.contactId, source: "email" }}
          onCreated={(id) => {
            // the email is settled once its ticket exists
            void api.post(`/mail-intake/${making.id}/ticket`, { ticketId: id }).finally(() => void qc.invalidateQueries({ queryKey: KEY }));
            setMaking(null);
            setOpen(false);
            onCreated(id);
          }}
        />
      )}
    </>
  );
}
