import { useTranslation } from "react-i18next";
import { FileSignature } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { ItemsToInvoice } from "./ItemsToInvoice";

/** Accounting: invoices (Éléments à facturer for now) and quotes (empty for now — the place is ready). */
export function AccountingPage({ kind }: { kind: "invoices" | "quotes" }) {
  const { t } = useTranslation();
  if (kind === "invoices") return <ItemsToInvoice />;
  const Icon = FileSignature;
  return (
    <div className="relative isolate space-y-6">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Icon className="size-6 text-primary" /> {t(`accounting.${kind}`)}
        </h1>
        <p className="text-sm text-muted-foreground">{t(`accounting.${kind}Text`)}</p>
      </div>
      <div className="glass flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-16 text-center">
        <span className="grid size-12 place-items-center rounded-2xl border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10">
          <Icon className="size-6 text-primary" />
        </span>
        <p className="font-semibold">{t("accounting.soon")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t("accounting.soonText")}</p>
      </div>
    </div>
  );
}
