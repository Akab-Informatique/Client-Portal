import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Printer, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";

type Label = {
  product: { id: string; name: string; sku: string | null; priceCents: number; serialized: boolean };
  assignments: { ticketId: number; ticketNumber: string | null; client: string | null; serial: string | null; at: string }[];
};
type Assigned = Label["assignments"][number];
/** What a product label shows: enough of a store product. */
export type LabelProduct = { id: string; name: string; sku: string | null; priceCents: number };

/** The two label sizes: the 4 in × 2 in sheet label and the 1 in × 3.5 in Dymo label. */
export type LabelFormat = "large" | "dymo";
const SIZE: Record<LabelFormat, { width: string; height: string; page: string }> = {
  large: { width: "4in", height: "2in", page: "4in 2in" },
  dymo: { width: "3.5in", height: "1in", page: "3.5in 1in" },
};
const FORMAT_KEY = "akab.label.format";
/** The format picked last time (kept in the browser), the Dymo one by default. */
export function useLabelFormat() {
  const [format, setFormat] = useState<LabelFormat>(() => {
    try {
      return localStorage.getItem(FORMAT_KEY) === "large" ? "large" : "dymo";
    } catch {
      return "dymo";
    }
  });
  const pick = (f: LabelFormat) => {
    setFormat(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* private window: not remembered */
    }
  };
  return [format, pick] as const;
}

const money = (cents: number) => new Intl.NumberFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
/** The code a product label carries as a QR code: its SKU, else its id. */
export const labelCode = (p: LabelProduct) => p.sku ?? p.id;
export const qrDataUrl = (code: string) => import("qrcode").then((m) => m.default.toDataURL(code, { margin: 0, width: 360, errorCorrectionLevel: "M" }));

/**
 * Print labels alone, the page being the label's size (e.g. "4in 2in"): while printing, everything in <body> but
 * the `.labels-print` sheet is left out (`html.printing-labels`, index.css), so the page is exactly the labels
 * (one a page) and nothing else. Without a sheet given, the `#akab-label` element is copied into one.
 */
export function printLabel(size: string) {
  const style = document.createElement("style");
  style.textContent = `@page { size: ${size}; margin: 0; }`;
  document.head.appendChild(style);
  let sheet: HTMLElement | null = null;
  if (!document.querySelector(".labels-print")) {
    const label = document.getElementById("akab-label");
    if (!label) return style.remove();
    const copy = label.cloneNode(true) as HTMLElement;
    copy.removeAttribute("id");
    copy.classList.add("labels-print-page");
    copy.classList.remove("shadow-lg");
    sheet = document.createElement("div");
    sheet.className = "labels-print";
    sheet.appendChild(copy);
    document.body.appendChild(sheet);
  }
  document.documentElement.classList.add("printing-labels");
  const done = () => {
    document.documentElement.classList.remove("printing-labels");
    style.remove();
    sheet?.remove();
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
}

/** A product label, black on white whatever the theme, in either format; `assigned` adds the ticket, client and serial. */
export function ProductLabel({ product, qr, format, assigned, id, className }: { product: LabelProduct; qr: string | null; format: LabelFormat; assigned?: Assigned | null; id?: string; className?: string }) {
  const { t } = useTranslation();
  const size = SIZE[format];
  const code = qr ? <img src={qr} alt="" className={format === "dymo" ? "size-[0.82in]" : "size-[1.45in]"} style={{ imageRendering: "pixelated" }} /> : <Loader2 className="size-5 animate-spin" />;
  if (format === "dymo")
    return (
      <div
        id={id}
        className={cn("box-border flex shrink-0 items-center gap-[0.08in] overflow-hidden bg-white px-[0.1in] py-[0.07in] text-black", className)}
        style={{ width: size.width, height: size.height, colorScheme: "light" }}
      >
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <p className="line-clamp-2 text-[14px] font-bold leading-[1.1]">{product.name}</p>
          {product.sku && <p className="truncate font-mono text-[11px] leading-tight">{t("store.label.sku")} {product.sku}</p>}
          <div className="mt-auto flex items-end justify-between gap-2">
            {assigned ? (
              <p className="min-w-0 truncate text-[11px] leading-tight">
                {[assigned.ticketNumber, assigned.client, assigned.serial && `${t("store.label.serial")} ${assigned.serial}`].filter(Boolean).join(" · ")}
              </p>
            ) : (
              <span />
            )}
            <p className="shrink-0 text-[20px] font-extrabold leading-none">{money(product.priceCents)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-center">{code}</div>
      </div>
    );
  return (
    <div
      id={id}
      className={cn("relative box-border flex shrink-0 gap-3 overflow-hidden bg-white p-[0.14in] text-black", className)}
      style={{ width: size.width, height: size.height, colorScheme: "light" }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="line-clamp-3 text-[17px] font-bold leading-tight">{product.name}</p>
        {product.sku && <p className="mt-1 font-mono text-[12px] leading-none">{t("store.label.sku")} {product.sku}</p>}
        <p className="mt-auto text-[28px] font-extrabold leading-none">{money(product.priceCents)}</p>
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
      <div className="flex shrink-0 flex-col items-center justify-center">{code}</div>
    </div>
  );
}

/** The two format buttons. */
export function FormatPicker({ format, onChange }: { format: LabelFormat; onChange: (f: LabelFormat) => void }) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex rounded-full border p-0.5 text-xs">
      {(["dymo", "large"] as const).map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onChange(f)}
          className={cn("rounded-full px-3 py-1 font-medium transition-colors", format === f ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}
        >
          {t(`store.label.format.${f}`)}
        </button>
      ))}
    </div>
  );
}

/**
 * The product label, Dymo 1 in × 3.5 in or 4 in × 2 in: name, SKU, price and a QR code (the SKU) — and, when the
 * product went to a ticket or a client, that ticket and client too. Shown in a window with the print button.
 */
export function LabelDialog({ product, onClose }: { product: { id: string; name: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: ["store", "label", product.id], queryFn: () => api.get<Label>(`/store/products/${product.id}/label`) });
  const [format, setFormat] = useLabelFormat();
  // which assignment goes on the label: the latest, or none
  const [pick, setPick] = useState<number | "none">(0);
  const [qr, setQr] = useState<string | null>(null);
  const code = data ? labelCode(data.product) : null;
  useEffect(() => {
    if (!code) return;
    let off = false;
    void qrDataUrl(code).then((u) => !off && setQr(u));
    return () => {
      off = true;
    };
  }, [code]);
  const assigned = data && pick !== "none" ? (data.assignments[pick] ?? null) : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="size-5 text-primary" /> {t("store.label.title")}
          </DialogTitle>
          <DialogDescription>{t(`store.label.size.${format}`)}</DialogDescription>
        </DialogHeader>
        {isLoading || !data ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            <FormatPicker format={format} onChange={setFormat} />
            <div className="flex justify-center overflow-x-auto rounded-xl bg-muted/40 p-4">
              <ProductLabel id="akab-label" product={data.product} qr={qr} format={format} assigned={assigned} className="shadow-lg" />
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
          <Button onClick={() => printLabel(SIZE[format].page)} disabled={!data || !qr}>
            <Printer className="size-4" /> {t("store.label.print")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Above this many labels the window asks to narrow the list first. */
const MAX_LABELS = 500;

/**
 * Labels for many products at once (the inventory list as filtered): one label per product, or one per unit in
 * stock; each label is a page of its own, so the Dymo prints them one after the other.
 */
export function BulkLabelsDialog({ products, onClose }: { products: (LabelProduct & { total: number })[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [format, setFormat] = useLabelFormat();
  const [perUnit, setPerUnit] = useState(false);
  const [qrs, setQrs] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let off = false;
    void Promise.all(products.map(async (p) => [p.id, await qrDataUrl(labelCode(p))] as const)).then((all) => !off && setQrs(Object.fromEntries(all)));
    return () => {
      off = true;
    };
  }, [products]);
  const copies = products.flatMap((p) => Array.from({ length: perUnit ? Math.max(0, p.total) : 1 }, () => p));
  const tooMany = copies.length > MAX_LABELS;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="size-5 text-primary" /> {t("store.label.bulkTitle")}
          </DialogTitle>
          <DialogDescription>{t("store.label.bulkHint", { count: products.length })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormatPicker format={format} onChange={setFormat} />
          <div className="inline-flex rounded-full border p-0.5 text-xs">
            {[false, true].map((u) => (
              <button
                key={String(u)}
                type="button"
                onClick={() => setPerUnit(u)}
                className={cn("rounded-full px-3 py-1 font-medium transition-colors", perUnit === u ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}
              >
                {t(u ? "store.label.perUnit" : "store.label.perProduct")}
              </button>
            ))}
          </div>
          <div className="flex justify-center overflow-x-auto rounded-xl bg-muted/40 p-4">
            {products[0] ? <ProductLabel product={products[0]} qr={qrs?.[products[0].id] ?? null} format={format} className="shadow-lg" /> : null}
          </div>
          <p className={cn("text-sm", tooMany ? "text-orange-300" : "text-muted-foreground")}>
            {tooMany ? t("store.label.tooMany", { count: copies.length, max: MAX_LABELS }) : t("store.label.willPrint", { count: copies.length })}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button onClick={() => printLabel(SIZE[format].page)} disabled={!qrs || copies.length === 0 || tooMany}>
            {!qrs ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />} {t("store.label.printN", { count: copies.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* the sheet that is printed: hidden on screen (index.css), one label a page */}
      {qrs &&
        !tooMany &&
        createPortal(
          <div className="labels-print">
            {copies.map((p, i) => (
              <ProductLabel key={`${p.id}-${i}`} product={p} qr={qrs[p.id] ?? null} format={format} className="labels-print-page" />
            ))}
          </div>,
          document.body,
        )}
    </Dialog>
  );
}
