import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { CreditCard } from "lucide-react";
import invoiceLogoUrl from "@/assets/akab-logo-invoice.png";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";

export type SheetData = {
  number: string;
  issuedOn: string;
  dueOn: string;
  /** Terms in days (0 = on receipt); none: an exact due date was given */
  termsDays: number | null;
  poNumber: string | null;
  notes: string | null;
  client: { name: string; address: string | null; city: string | null; province: string | null; postalCode: string | null; email: string | null };
  lines: { sectionName?: string | null; date?: string | null; description: string; contractName?: string | null; kind: string; quantity: number; unitPriceCents: number; amountCents: number }[];
  subtotalCents: number;
  gstCents: number;
  qstCents: number;
  totalCents: number;
  exempt: boolean;
  company: { legalName: string; address: string; phone: string; email: string; website: string };
  taxes: { gstNumber: string; qstNumber: string; gstRate: number; qstRate: number };
  template: { language: "fr" | "en"; footer: string; paymentInstructions: string; showPaymentLink: boolean };
};

/** The Stripe switch beside the payment instructions, while an invoice is made (never on the invoice itself) */
export type PayToggle = { on: boolean; ready: boolean; onChange: (on: boolean) => void };

function PayButton({ on, ready, onChange }: PayToggle) {
  const { t } = useTranslation();
  const title = !ready ? t("invoicing.payNotReady") : on ? t("invoicing.payOn") : t("invoicing.payOff");
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      title={title}
      aria-label={title}
      aria-pressed={on}
      className={cn(
        "flex size-7 flex-none items-center justify-center rounded-full border transition-colors print:hidden",
        on && ready ? "border-[#635bff] bg-[#635bff] text-white" : on ? "border-amber-500 bg-amber-100 text-amber-700" : "border-black/25 bg-white text-black/40 hover:text-black/70",
      )}
    >
      <CreditCard className="size-3.5" />
    </button>
  );
}

const dmy = (ymd: string) => {
  const [y, m, d] = ymd.split("-");
  return y && m && d ? `${d}/${m}/${y}` : ymd;
};

/**
 * The invoice as the client sees it: the logo on top, the company and the dated boxes, the bill-to box, the lines in a
 * ruled table, the totals on the right with the payment instructions beside them, and the conditions at the foot.
 */
export function InvoiceSheet({ d, payToggle }: { d: SheetData; payToggle?: PayToggle }) {
  const { t } = useTranslation();
  const lng = d.template.language;
  const L = (k: string, o?: Record<string, unknown>) => t(`invoiceSheet.${k}`, { lng, ...o });
  const mm = (c: number) => money(c, lng);
  const hours = d.lines.filter((l) => l.kind === "labour").reduce((n, l) => n + l.quantity, 0);
  const terms = d.termsDays == null ? null : d.termsDays === 0 ? L("onReceipt") : L("net", { days: d.termsDays });
  const place = [d.client.city, d.client.province].filter(Boolean).join(", ");
  const cell = "border border-black/70 px-1.5 py-1";
  // a parent company and its children: each company's charges in its own block, the parent first, with its subtotal
  const sectioned = d.lines.some((l) => l.sectionName);
  const groups: { name: string | null; lines: SheetData["lines"] }[] = [];
  for (const l of d.lines) {
    const name = sectioned ? (l.sectionName ?? "") : null;
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.lines.push(l);
    else groups.push({ name, lines: [l] });
  }
  return (
    <div className="rounded-2xl bg-white p-8 text-[11px] leading-snug text-black shadow-xl">
      {/* the invoice's logo: AKAB Informatique in its black pill (the same picture as the PDF's) */}
      <img src={invoiceLogoUrl} alt="AKAB Informatique" className="h-[72px] w-auto" />

      <div className="mt-6 grid grid-cols-[1fr_auto] gap-6">
        <div className="whitespace-pre-line">
          <p>{d.company.legalName || "—"}</p>
          {d.company.address && <p>{d.company.address}</p>}
          {d.company.phone && <p>{d.company.phone}</p>}
          {d.company.email && <p>{d.company.email}</p>}
        </div>
        <div className="space-y-1.5 text-right">
          <div className="ml-auto w-36 border border-black/70 px-2 py-1 text-center">
            <p className="font-semibold">{L("date")}</p>
            <p className="mt-2">{dmy(d.issuedOn)}</p>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[1fr_auto] gap-6">
        <div className="w-64 border border-black/70">
          <p className="border-b border-black/70 px-2 py-1 font-semibold">{L("billTo")}</p>
          <div className="min-h-14 whitespace-pre-line px-2 py-1.5">
            <p>{d.client.name}</p>
            {d.client.address && <p>{d.client.address}</p>}
            <p>{[place, d.client.postalCode].filter(Boolean).join(" ")}</p>
            <p>Canada</p>
          </div>
        </div>
        <div className="space-y-1 pt-3 text-right">
          <p>
            <span className="font-semibold"># {L("invoiceNo")} :</span> {d.number}
          </p>
          {terms && (
            <p>
              <span className="font-semibold">{L("terms")} :</span> {terms}
            </p>
          )}
          <p>
            <span className="font-semibold">{L("dueOn")} :</span> {dmy(d.dueOn)}
          </p>
          {d.poNumber && (
            <p>
              <span className="font-semibold">PO :</span> {d.poNumber}
            </p>
          )}
        </div>
      </div>

      <table className="mt-4 w-full border-collapse">
        <thead>
          <tr className="text-left font-semibold">
            <th className={cell}>{L("lineDate")}</th>
            <th className={cell}>{L("description")}</th>
            <th className={`${cell} text-right`}>{L("hours")}</th>
            <th className={`${cell} text-right`}>{L("quantity")}</th>
            <th className={`${cell} text-right`}>{L("rate")}</th>
            <th className={`${cell} text-right`}>{L("amount")}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g, gi) => (
            <Fragment key={gi}>
              {g.name !== null && (
                <tr>
                  <td colSpan={6} className={`${cell} bg-black/5 font-semibold`}>
                    {g.name}
                  </td>
                </tr>
              )}
              {g.lines.map((l, i) => (
                <tr key={i} className="align-top">
                  <td className={`${cell} whitespace-nowrap`}>{l.date ? dmy(l.date) : ""}</td>
                  <td className={cell}>
                    {l.description}
                    {l.contractName && <span className="block">{L("contract", { name: l.contractName })}</span>}
                  </td>
                  <td className={`${cell} text-right`}>{l.kind === "labour" ? l.quantity.toFixed(2) : ""}</td>
                  <td className={`${cell} text-right`}>{l.quantity.toFixed(2)}</td>
                  <td className={`${cell} whitespace-nowrap text-right`}>{(l.unitPriceCents / 100).toFixed(2)}</td>
                  <td className={`${cell} whitespace-nowrap text-right`}>{(l.amountCents / 100).toFixed(2)}</td>
                </tr>
              ))}
              {g.name !== null && (
                <tr>
                  <td colSpan={6} className={`${cell} text-right font-semibold`}>
                    {g.name} : {mm(g.lines.reduce((n, l) => n + l.amountCents, 0))}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-4">
        <div className="min-w-[14rem] flex-1 whitespace-pre-line">
          <p className="tracking-widest text-black/50">{"=".repeat(38)}</p>
          {(d.template.paymentInstructions || payToggle) && (
            <div className="mt-1 flex items-start gap-2">
              <p className="flex-1">{d.template.paymentInstructions}</p>
              {payToggle && <PayButton {...payToggle} />}
            </div>
          )}
          {(d.taxes.gstNumber || d.taxes.qstNumber) && (
            <p className="mt-2">
              {[d.taxes.gstNumber && `TPS: ${d.taxes.gstNumber}`, d.taxes.qstNumber && `TVQ: ${d.taxes.qstNumber}`].filter(Boolean).join("   ")}
            </p>
          )}
          {d.notes && <p className="mt-3 border-t border-black/20 pt-2">{d.notes}</p>}
          {d.template.showPaymentLink && <p className="mt-3 inline-block rounded-md bg-[#0a0a0b] px-3 py-1.5 font-semibold text-[#ffce1a]">{L("payOnline")}</p>}
        </div>
        <div className="w-full max-w-64 flex-none space-y-1.5">
          <p className="flex justify-between font-semibold">
            <span>{L("totalHours")}</span>
            <span className="font-normal">{hours.toFixed(4)}</span>
          </p>
          <p className="flex justify-between font-semibold">
            <span>{L("totalBilled")}</span>
            <span>{mm(d.subtotalCents)}</span>
          </p>
          <p className="pt-1 font-semibold">{L("taxes")}</p>
          {d.exempt ? (
            <p className="text-black/60">{L("exempt")}</p>
          ) : (
            <>
              <p className="flex justify-between pl-3">
                <span>TPS ({d.taxes.gstRate} %)</span>
                <span>{mm(d.gstCents)}</span>
              </p>
              <p className="flex justify-between pl-3">
                <span>TVQ ({d.taxes.qstRate} %)</span>
                <span>{mm(d.qstCents)}</span>
              </p>
            </>
          )}
          <p className="flex items-baseline justify-between pt-3 text-sm font-bold">
            <span>{L("grandTotal")}</span>
            <span className="text-base">{mm(d.totalCents)}</span>
          </p>
        </div>
      </div>

      {d.template.footer && <p className="mt-8 whitespace-pre-line border-t border-black/20 pt-3 text-[10px] text-black/80">{d.template.footer}</p>}
    </div>
  );
}
