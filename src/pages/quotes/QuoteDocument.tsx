import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Printer, X } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { money } from "@/pages/crm/shared";
import { lineAmount, quoteTotals } from "@shared/quotes";

export type DocRow = { sku: string; description: string; quantityX100: number; unitPriceCents: number; taxable: boolean; optional: boolean };
export type DocData = {
  number: string;
  title: string;
  issuedOn: string;
  validUntil: string;
  forName: string;
  contactName: string;
  contactEmail: string;
  rows: DocRow[];
  taxes: boolean;
  rates: { gstRate: number; qstRate: number };
  notes: string;
  company: { legalName: string; address: string; phone: string; email: string; website: string };
  taxNumbers: { gst: string; qst: string };
  footer: string;
  preparedBy: string;
  preparedByTitle: string;
};

const longDate = (iso: string) => new Intl.DateTimeFormat(document.documentElement.lang === "en" ? "en-CA" : "fr-CA", { dateStyle: "long" }).format(new Date(`${iso}T12:00:00`));
const qty = (x: number) => String(x / 100).replace(".", ",");

/**
 * The quote as the client reads it: a white sheet (no costs, no margin, no
 * internal notes). "Imprimer" opens the print window, where "Enregistrer en PDF"
 * makes the file to attach to an email. Shown over the page, in the body, so
 * only the sheet is printed (CSS `html.printing-quote` in index.css).
 */
export function QuoteDocument({ data, onClose }: { data: DocData; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const counted = data.rows.filter((r) => !r.optional);
  const options = data.rows.filter((r) => r.optional);
  const totals = quoteTotals(data.rows.map((r) => ({ ...r })), data.taxes, data.rates);

  // the file name proposed by "Enregistrer en PDF" is the page title
  useEffect(() => {
    const before = document.title;
    document.title = `${t("quotes.doc.title")} ${data.number} - ${data.forName}`.trim();
    document.documentElement.classList.add("printing-quote");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.title = before;
      document.documentElement.classList.remove("printing-quote");
      window.removeEventListener("keydown", onKey);
    };
  }, [data.number, data.forName, onClose, t]);

  return createPortal(
    <div className="quote-overlay fixed inset-0 z-[100] overflow-y-auto bg-black/80 p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={t("quotes.doc.title")}>
      <div className="no-print mx-auto mb-4 flex max-w-[860px] flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-sm text-white/70">{t("quotes.doc.hint")}</p>
        <div className="flex gap-2">
          <Button onClick={() => window.print()}>
            <Printer className="size-4" /> {t("quotes.doc.print")}
          </Button>
          <Button variant="outline" onClick={onClose}>
            <X className="size-4" /> {t("common.close")}
          </Button>
        </div>
      </div>

      <article className="quote-sheet mx-auto max-w-[860px] overflow-hidden rounded-lg bg-white text-[13px] leading-relaxed text-neutral-900 shadow-2xl">
        <header className="flex flex-wrap items-center justify-between gap-4 bg-[#0a0a0b] px-8 py-6 text-white">
          <Logo className="h-12" />
          <div className="text-right">
            <p className="text-xl font-bold tracking-wide">{t("quotes.doc.title").toUpperCase()}</p>
            <p className="font-mono text-base text-[#ffce1a]">{data.number}</p>
          </div>
        </header>

        <div className="space-y-6 px-8 py-6">
          <section className="grid gap-6 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{t("quotes.doc.from")}</p>
              <p className="font-semibold">{data.company.legalName}</p>
              {data.company.address && <p className="whitespace-pre-line">{data.company.address}</p>}
              {[data.company.phone, data.company.email, data.company.website].filter(Boolean).map((x) => (
                <p key={x}>{x}</p>
              ))}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{t("quotes.doc.for")}</p>
              <p className="font-semibold">{data.forName || "-"}</p>
              {data.contactName && <p>{data.contactName}</p>}
              {data.contactEmail && <p>{data.contactEmail}</p>}
              {data.preparedBy && (
                <p className="mt-2">
                  <span className="text-neutral-500">{t("quotes.doc.preparedBy")} :</span> <span className="font-medium">{data.preparedBy}</span>
                  {data.preparedByTitle && <span className="text-neutral-500">, {data.preparedByTitle}</span>}
                </p>
              )}
              <p className="mt-2 text-neutral-600">
                {t("quotes.doc.date")} : {longDate(data.issuedOn)}
                {data.validUntil && (
                  <>
                    <br />
                    {t("quotes.doc.valid")} : {longDate(data.validUntil)}
                  </>
                )}
              </p>
            </div>
          </section>

          {data.title && <h2 className="text-lg font-bold">{data.title}</h2>}

          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-neutral-900 text-left text-[11px] uppercase tracking-wider text-neutral-500">
                <th className="py-2 pr-3 font-semibold">{t("quotes.editor.description")}</th>
                <th className="w-14 py-2 text-right font-semibold">{t("quotes.editor.qty")}</th>
                <th className="w-28 py-2 text-right font-semibold">{t("quotes.editor.unit")}</th>
                <th className="w-28 py-2 text-right font-semibold">{t("quotes.editor.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {counted.map((r, i) => (
                <tr key={i} className="break-inside-avoid border-b border-neutral-200 align-top">
                  <td className="py-2 pr-3">
                    {r.description}
                    {r.sku && <span className="ml-2 font-mono text-[11px] text-neutral-500">{r.sku}</span>}
                  </td>
                  <td className="py-2 text-right tabular-nums">{qty(r.quantityX100)}</td>
                  <td className="py-2 text-right tabular-nums">{money(r.unitPriceCents, lang)}</td>
                  <td className="py-2 text-right font-medium tabular-nums">{money(lineAmount(r), lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <section className="ml-auto w-full max-w-xs break-inside-avoid space-y-1">
            <Row label={t("quotes.editor.subtotal")} value={money(totals.subtotalCents, lang)} />
            {data.taxes && <Row label={`${t("quotes.editor.gst")} (${data.rates.gstRate} %)`} value={money(totals.gstCents, lang)} />}
            {data.taxes && <Row label={`${t("quotes.editor.qst")} (${data.rates.qstRate} %)`} value={money(totals.qstCents, lang)} />}
            <div className="flex items-baseline justify-between border-t-2 border-neutral-900 pt-2 text-base font-bold">
              <span>{t("quotes.editor.total")}</span>
              <span className="tabular-nums">{money(totals.totalCents, lang)}</span>
            </div>
            {(data.taxNumbers.gst || data.taxNumbers.qst) && data.taxes && (
              <p className="pt-1 text-[11px] text-neutral-500">
                {[data.taxNumbers.gst && `${t("quotes.editor.gst")} ${data.taxNumbers.gst}`, data.taxNumbers.qst && `${t("quotes.editor.qst")} ${data.taxNumbers.qst}`].filter(Boolean).join("   ")}
              </p>
            )}
          </section>

          {options.length > 0 && (
            <section className="break-inside-avoid">
              <h3 className="mb-1 text-sm font-bold">{t("quotes.doc.options")}</h3>
              <table className="w-full border-collapse">
                <tbody>
                  {options.map((r, i) => (
                    <tr key={i} className="border-b border-neutral-200 align-top">
                      <td className="py-1.5 pr-3">
                        {r.description}
                        {r.sku && <span className="ml-2 font-mono text-[11px] text-neutral-500">{r.sku}</span>}
                      </td>
                      <td className="w-14 py-1.5 text-right tabular-nums">{qty(r.quantityX100)}</td>
                      <td className="w-28 py-1.5 text-right tabular-nums">{money(r.unitPriceCents, lang)}</td>
                      <td className="w-28 py-1.5 text-right font-medium tabular-nums">{money(lineAmount(r), lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-neutral-500">{t("quotes.doc.optionsNote")}</p>
            </section>
          )}

          {data.notes && (
            <section className="break-inside-avoid">
              <h3 className="mb-1 text-sm font-bold">{t("quotes.doc.notes")}</h3>
              <p className="whitespace-pre-line text-neutral-700">{data.notes}</p>
            </section>
          )}
        </div>

        {data.footer && <footer className="border-t px-8 py-4 text-center text-neutral-500">{data.footer}</footer>}
      </article>
    </div>,
    document.body,
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-neutral-600">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
