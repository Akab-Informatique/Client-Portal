import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Printer, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { currentLocale } from "@/i18n";

type Label = {
  product: { id: string; name: string; sku: string | null; priceCents: number; serialized: boolean };
  assignments: { ticketId: number; ticketNumber: string | null; client: string | null; serial: string | null; at: string }[];
};

const money = (cents: number) => new Intl.NumberFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(cents / 100);

/**
 * The product label, 4 in × 2 in: name, SKU, price and a QR code (the SKU) — and, when the product went to
 * a ticket or a client, that ticket and client too. Shown in a window with the print button.
 */
export function LabelDialog({ product, onClose }: { product: { id: string; name: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: ["store", "label", product.id], queryFn: () => api.get<Label>(`/store/products/${product.id}/label`) });
  // which assignment goes on the label: the latest, or none
  const [pick, setPick] = useState<number | "none">(0);
  const [qr, setQr] = useState<string | null>(null);
  const code = data ? (data.product.sku ?? data.product.id) : null;
  useEffect(() => {
    if (!code) return;
    let off = false;
    void import("qrcode").then((m) => m.default.toDataURL(code, { margin: 0, width: 360, errorCorrectionLevel: "M" })).then((u) => !off && setQr(u));
    return () => {
      off = true;
    };
  }, [code]);
  const assigned = data && pick !== "none" ? (data.assignments[pick] ?? null) : null;

  const print = () => {
    // the page is 4 in × 2 in while printing; everything but the label is hidden (index.css)
    const style = document.createElement("style");
    style.textContent = "@page { size: 4in 2in; margin: 0; }";
    document.head.appendChild(style);
    document.documentElement.classList.add("printing-label");
    const done = () => {
      document.documentElement.classList.remove("printing-label");
      style.remove();
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="size-5 text-primary" /> {t("store.label.title")}
          </DialogTitle>
          <DialogDescription>{t("store.label.size")}</DialogDescription>
        </DialogHeader>
        {isLoading || !data ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-center overflow-x-auto rounded-xl bg-muted/40 p-4">
              {/* the label itself: always black on white, whatever the theme (4 in × 2 in) */}
              <div
                id="akab-label"
                className="relative box-border flex shrink-0 gap-3 overflow-hidden bg-white p-[0.14in] text-black shadow-lg"
                style={{ width: "4in", height: "2in", colorScheme: "light" }}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <p className="line-clamp-3 text-[17px] font-bold leading-tight">{data.product.name}</p>
                  {data.product.sku && <p className="mt-1 font-mono text-[12px] leading-none">{t("store.label.sku")} {data.product.sku}</p>}
                  <p className="mt-auto text-[28px] font-extrabold leading-none">{money(data.product.priceCents)}</p>
                  {assigned && (
                    <div className="mt-1.5 border-t border-black/40 pt-1 text-[11px] leading-tight">
                      {assigned.ticketNumber && (
                        <p>
                          <span className="font-semibold">{t("store.label.ticket")}</span> {assigned.ticketNumber}
                        </p>
                      )}
                      {assigned.client && <p className="truncate">{assigned.client}</p>}
                      {assigned.serial && (
                        <p className="truncate font-mono">
                          {t("store.label.serial")} {assigned.serial}
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-center justify-center">
                  {qr ? <img src={qr} alt="" className="size-[1.45in]" style={{ imageRendering: "pixelated" }} /> : <Loader2 className="size-5 animate-spin" />}
                </div>
              </div>
            </div>
            {data.assignments.length > 0 && (
              <label className="block space-y-1 text-xs text-muted-foreground">
                {t("store.label.assigned")}
                <select
                  value={String(pick)}
                  onChange={(e) => setPick(e.target.value === "none" ? "none" : Number(e.target.value))}
                  className="h-9 w-full rounded-md border bg-transparent px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40"
                >
                  {data.assignments.map((a, i) => (
                    <option key={`${a.ticketId}-${a.serial ?? i}`} value={i}>
                      {[a.ticketNumber, a.client, a.serial].filter(Boolean).join(" · ")}
                    </option>
                  ))}
                  <option value="none">{t("store.label.noAssignment")}</option>
                </select>
              </label>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button onClick={print} disabled={!data || !qr}>
            <Printer className="size-4" /> {t("store.label.print")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
