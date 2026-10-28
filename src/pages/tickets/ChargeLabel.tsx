import { useTranslation } from "react-i18next";
import { Printer, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { printLabel } from "@/pages/store/LabelDialog";
import { currentLocale } from "@/i18n";
import type { Charge } from "./Charges";

const money = (n: number) => new Intl.NumberFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(n);

/**
 * A charge's label for the Dymo, 1 in × 3.5 in: the product and its price, its description, the client, the ticket number and title.
 * Shown in a window with the print button.
 */
export function ChargeLabelDialog({ charge, ticket, onClose }: { charge: Charge; ticket: { number: string; title: string; company: { name: string } }; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="size-5 text-primary" /> {t("tickets.charges.label.title")}
          </DialogTitle>
          <DialogDescription>{t("tickets.charges.label.size")}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-center overflow-x-auto rounded-xl bg-muted/40 p-4">
          {/* the label itself: always black on white, whatever the theme (3.5 in × 1 in) */}
          <div
            id="akab-label"
            className="box-border flex shrink-0 flex-col overflow-hidden bg-white px-[0.1in] py-[0.07in] text-black shadow-lg"
            style={{ width: "3.5in", height: "1in", colorScheme: "light" }}
          >
            {/* everything keeps its size; the description (least important) takes what is left, 2 lines at most, ending in … */}
            <p className="flex shrink-0 items-baseline gap-2 text-[16px] font-bold leading-[1.15]">
              <span className="min-w-0 flex-1 truncate">{charge.name}</span>
              {charge.unitPrice !== null && (
                <span className="shrink-0">{charge.quantity === 1 ? money(charge.unitPrice) : `${charge.quantity.toLocaleString()} × ${money(charge.unitPrice)}`}</span>
              )}
            </p>
            <div className="min-h-0 flex-1 overflow-hidden">
              {charge.description && <p className="line-clamp-2 break-words text-[11px] leading-[1.15]">{charge.description}</p>}
            </div>
            <p className="shrink-0 truncate border-t border-black/40 pt-px text-[12px] font-bold leading-[1.15]">{ticket.company.name}</p>
            <p className="flex shrink-0 items-baseline gap-1.5 text-[12px] leading-[1.15]">
              <span className="shrink-0 font-mono font-bold">{ticket.number}</span>
              <span className="min-w-0 truncate">{ticket.title}</span>
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button onClick={() => printLabel("3.5in 1in")}>
            <Printer className="size-4" /> {t("tickets.charges.label.print")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
