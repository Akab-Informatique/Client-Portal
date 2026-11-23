import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Printer, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormatPicker, printLabel, useLabelFormat, type LabelFormat } from "@/pages/store/LabelDialog";
import { cn } from "@/lib/utils";

const SIZE: Record<LabelFormat, { width: string; height: string; page: string }> = {
  large: { width: "4in", height: "2in", page: "4in 2in" },
  dymo: { width: "3.5in", height: "1in", page: "3.5in 1in" },
};
/** The preview shows this many labels at most; the print always has all of them. */
const PREVIEW = 10;

type Ticket = { number: string; title: string; client: string };

/** One equipment label, black on white whatever the theme: number, title, client and "Équipement k/N". */
function Label({ ticket, format, k, n, className }: { ticket: Ticket; format: LabelFormat; k: number; n: number; className?: string }) {
  const { t } = useTranslation();
  const dymo = format === "dymo";
  const size = SIZE[format];
  return (
    <div
      className={cn("box-border flex shrink-0 flex-col overflow-hidden bg-white text-black", dymo ? "py-[0.07in] pl-[0.12in] pr-[0.35in]" : "p-[0.14in] pr-[0.35in]", className)}
      style={{ width: size.width, height: size.height, colorScheme: "light" }}
    >
      <p className={cn("truncate font-mono font-extrabold leading-none", dymo ? "text-[22px]" : "text-[34px]")}>{ticket.number}</p>
      <p className={cn("line-clamp-2 font-semibold leading-[1.1]", dymo ? "mt-px text-[13px]" : "mt-1.5 text-[20px]")}>{ticket.title}</p>
      <div className="mt-auto flex items-end justify-between gap-2">
        <p className={cn("min-w-0 truncate font-bold leading-tight", dymo ? "text-[12px]" : "text-[18px]")}>{ticket.client}</p>
        <p className={cn("shrink-0 font-extrabold leading-tight", dymo ? "text-[13px]" : "text-[20px]")}>{t("equipLabel.equipment", { k, n })}</p>
      </div>
    </div>
  );
}

/** Labels to stick on the client's equipment of a ticket: any number, "Équipement k/N", Dymo or 4 in × 2 in, one label a page. */
export function EquipmentLabelDialog({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { t } = useTranslation();
  const [format, setFormat] = useLabelFormat();
  const [count, setCount] = useState(1);
  const n = Math.max(1, Math.floor(count) || 1);
  const labels = Array.from({ length: n }, (_, i) => i + 1);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="size-5 text-primary" /> {t("equipLabel.title")}
          </DialogTitle>
          <DialogDescription>{t("equipLabel.hint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormatPicker format={format} onChange={setFormat} />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("equipLabel.count")}
            <input
              type="number"
              min={1}
              step={1}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="h-9 w-24 rounded-md border bg-transparent px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40"
            />
          </label>
          <div className="max-h-[45vh] space-y-3 overflow-auto rounded-xl bg-muted/40 p-4">
            {labels.slice(0, PREVIEW).map((k) => (
              <div key={k} className="flex justify-center">
                <Label ticket={ticket} format={format} k={k} n={n} className="shadow-lg" />
              </div>
            ))}
            {n > PREVIEW && <p className="text-center text-xs text-muted-foreground">{t("equipLabel.more", { count: n - PREVIEW })}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button onClick={() => printLabel(SIZE[format].page)}>
            <Printer className="size-4" /> {n === 1 ? t("equipLabel.print") : t("equipLabel.printN", { count: n })}
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* the sheet that is printed: hidden on screen (index.css), one label a page */}
      {createPortal(
        <div className="labels-print">
          {labels.map((k) => (
            <Label key={k} ticket={ticket} format={format} k={k} n={n} className="labels-print-page" />
          ))}
        </div>,
        document.body,
      )}
    </Dialog>
  );
}
