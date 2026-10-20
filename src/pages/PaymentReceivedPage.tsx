import { useTranslation } from "react-i18next";
import { Check, CircleOff } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";

/**
 * Where Stripe sends the customer after a card payment link (no sign-in):
 * /paiement-recu, or /paiement-recu?annule=1 when they leave without paying.
 */
export function PaymentReceivedPage() {
  const { t } = useTranslation();
  const cancelled = new URLSearchParams(window.location.search).has("annule");
  const Icon = cancelled ? CircleOff : Check;
  return (
    <main className="relative grid min-h-dvh place-items-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>
      <div className="glass w-full max-w-md space-y-6 rounded-3xl border p-8 text-center">
        <Logo className="mx-auto h-12" />
        <span className={cancelled ? "mx-auto grid size-14 place-items-center rounded-full border border-slate-500/40 bg-slate-500/10" : "mx-auto grid size-14 place-items-center rounded-full border border-emerald-500/40 bg-emerald-500/10"}>
          <Icon className={cancelled ? "size-7 text-slate-300" : "size-7 text-emerald-300"} />
        </span>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">{t(cancelled ? "paymentReceived.cancelledTitle" : "paymentReceived.title")}</h1>
          <p className="text-sm text-muted-foreground">{t(cancelled ? "paymentReceived.cancelledText" : "paymentReceived.text")}</p>
        </div>
      </div>
    </main>
  );
}
