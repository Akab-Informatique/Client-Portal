import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus, Receipt, Ticket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { ChargesDialog } from "@/pages/tickets/Charges";
import { NewTicketDialog } from "@/pages/tickets/NewTicketDialog";
import { TicketSearch } from "@/pages/tickets/TicketSearch";
import type { TicketDetail, TicketList } from "@/pages/tickets/shared";
import { useTicketWorkspace } from "@/pages/tickets/workspace";

/**
 * The + button of the top bar: a new ticket (the usual creation window) or a new charge — on a ticket you pick, either an
 * item of the inventory or a one-time charge typed on the spot.
 */
export function QuickAdd() {
  const { t } = useTranslation();
  const can = useCan();
  const ws = useTicketWorkspace();
  const [ticket, setTicket] = useState(false);
  const [charge, setCharge] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const allowed = can("tickets.edit");
  // the new-ticket form's lists (queues, priorities…), loaded when it is asked for
  const facets = useQuery({ queryKey: ["tickets", "view=mine"], queryFn: () => api.get<TicketList>("/tickets?view=mine"), enabled: allowed && ticket, staleTime: 60_000 });
  const detail = useQuery({ queryKey: ["tickets", "detail", picked], queryFn: () => api.get<TicketDetail>(`/tickets/${picked}`), enabled: picked !== null });
  if (!allowed) return null;
  const closeCharge = () => {
    setCharge(false);
    setPicked(null);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" className="size-9 rounded-full bg-grad-gold text-[#1a1204] hover:brightness-105" aria-label={t("quickAdd.title")} title={t("quickAdd.title")}>
            <Plus className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => setTicket(true)}>
            <Ticket className="size-4 text-primary" /> {t("quickAdd.ticket")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCharge(true)}>
            <Receipt className="size-4 text-primary" /> {t("quickAdd.charge")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {ticket && facets.data && <NewTicketDialog open onOpenChange={(o) => !o && setTicket(false)} facets={facets.data.facets} onCreated={(id) => ws.open(id)} />}

      {/* a charge: the ticket first, then the charge window of that ticket */}
      {charge && picked === null && (
        <Dialog open onOpenChange={(o) => !o && closeCharge()}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Receipt className="size-5 text-primary" /> {t("quickAdd.charge")}
              </DialogTitle>
              <DialogDescription>{t("quickAdd.pickTicket")}</DialogDescription>
            </DialogHeader>
            <TicketSearch onPick={(x) => setPicked(x.id)} />
          </DialogContent>
        </Dialog>
      )}
      {charge && picked !== null && !detail.data && (
        <Dialog open onOpenChange={(o) => !o && closeCharge()}>
          <DialogContent className="sm:max-w-xs">
            <DialogTitle className="sr-only">{t("quickAdd.charge")}</DialogTitle>
            <Loader2 className="mx-auto my-6 size-6 animate-spin text-muted-foreground" />
          </DialogContent>
        </Dialog>
      )}
      {charge && picked !== null && detail.data && <ChargesDialog tk={detail.data} editable onClose={closeCharge} />}
    </>
  );
}
