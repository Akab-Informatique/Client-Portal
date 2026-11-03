import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleOff, CreditCard, Loader2, Lock, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { money } from "@/pages/crm/shared";

const longDay = (ymd: string, lang: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString(lang === "en" ? "en-CA" : "fr-CA", { day: "numeric", month: "long", year: "numeric" });

type Contract = {
  name: string;
  period: "monthly" | "yearly";
  startDate: string | null;
  endDate: string | null;
  monthlyCents: number | null;
  /** Per month on a monthly contract, per year on a yearly one (charged once a year, on its renewal day) */
  perPeriodCents: number | null;
  yearlyExtraCents: number;
  next: { date: string; amountCents: number } | null;
  bundle: { quantity: number; unitCents: number } | null;
  lines: { name: string; quantity: number; yearly: boolean; unitCents: number }[];
};
type Summary = {
  status: "pending" | "active";
  client: string;
  /** The contracts' names, as one phrase */
  contract: string;
  contracts: Contract[];
  taxes: { gst: number; qst: number } | null;
  cardFee: number | null;
  text: string;
  card: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null;
  accepted: boolean;
};

/**
 * /carte/<signed token> (no sign-in): the client sees the contract and what it charges, types their name, accepts the
 * authorization, then saves a card on Stripe's own page. Back from Stripe (?ok=1) the page shows the saved card.
 */
export function CardAutopayPage() {
  const { t, i18n } = useTranslation();
  const token = window.location.pathname.split("/carte/")[1] ?? "";
  const q = new URLSearchParams(window.location.search);
  const { data, isLoading, isError } = useQuery({ queryKey: ["autopay-public", token], queryFn: () => api.get<Summary>(`/autopay/public/${token}`), retry: false });
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const accept = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/autopay/public/${token}/accept`, { name: name.trim(), agree: true }),
    onSuccess: (r) => window.location.assign(r.url),
  });
  const m = (c: number) => money(c, i18n.language);
  const acceptError = accept.error instanceof ApiError ? accept.error.code : accept.error ? "failed" : null;

  return (
    <main className="relative grid min-h-dvh place-items-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>
      <div className="glass w-full max-w-xl space-y-6 rounded-3xl border p-6 sm:p-8">
        <Logo className="h-11" />
        {isLoading ? (
          <div className="space-y-3" aria-busy="true">
            <div className="h-6 w-2/3 animate-pulse rounded-lg bg-muted" />
            <div className="h-24 animate-pulse rounded-xl bg-muted" />
            <div className="h-10 animate-pulse rounded-xl bg-muted" />
          </div>
        ) : isError || !data ? (
          <div className="space-y-2 text-center">
            <CircleOff className="mx-auto size-8 text-muted-foreground" />
            <h1 className="text-xl font-bold">{t("cardPage.goneTitle")}</h1>
            <p className="text-sm text-muted-foreground">{t("cardPage.goneText")}</p>
          </div>
        ) : data.status === "active" && data.card ? (
          <div className="space-y-4 text-center">
            <span className="mx-auto grid size-14 place-items-center rounded-full border border-emerald-500/40 bg-emerald-500/10">
              <ShieldCheck className="size-7 text-emerald-300" />
            </span>
            <h1 className="text-2xl font-bold">{t("cardPage.doneTitle")}</h1>
            <p className="text-sm text-muted-foreground">{t("cardPage.doneText", { contract: data.contract, card: `${data.card.brand ? data.card.brand.charAt(0).toUpperCase() + data.card.brand.slice(1) : ""} •••• ${data.card.last4 ?? ""}` })}</p>
          </div>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim().length >= 2 && agree) accept.mutate();
            }}
          >
            <div className="space-y-1">
              <h1 className="text-2xl font-bold leading-tight">{t("cardPage.title", { count: data.contracts.length })}</h1>
              <p className="text-sm text-muted-foreground">{t("cardPage.subtitle", { client: data.client })}</p>
            </div>
            {q.has("annule") && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{t("cardPage.cancelled")}</p>}

            <section className="space-y-3 rounded-2xl border bg-card/60 p-4">
              {data.contracts.map((k, n) => (
                <div key={n} className={n > 0 ? "space-y-2 border-t pt-3" : "space-y-2"}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold">{k.name}</p>
                    {k.perPeriodCents != null && (
                      <p className="text-sm">
                        <span className="font-mono text-lg font-bold text-primary">{m(k.perPeriodCents)}</span>{" "}
                        <span className="text-muted-foreground">{t(k.period === "yearly" ? "cardPage.perYear" : "cardPage.perMonth")}</span>
                      </p>
                    )}
                  </div>
                  {k.yearlyExtraCents > 0 && <p className="text-xs text-muted-foreground">{t("cardPage.yearlyExtra", { amount: m(k.yearlyExtraCents) })}</p>}
                  {k.next && (
                    <p className="text-xs text-muted-foreground">
                      {t(k.period === "yearly" ? "cardPage.nextYearly" : "cardPage.next", { date: longDay(k.next.date, i18n.language), amount: m(k.next.amountCents) })}
                    </p>
                  )}
                  {(k.bundle || k.lines.length > 0) && (
                    <ul className="space-y-1 text-sm">
                      {k.bundle ? (
                        <li className="flex justify-between gap-3">
                          <span>{t("cardPage.bundle", { qty: k.bundle.quantity })}</span>
                          <span className="font-mono">{m(k.bundle.unitCents * k.bundle.quantity)}</span>
                        </li>
                      ) : (
                        k.lines.map((l, i) => (
                          <li key={i} className="flex justify-between gap-3">
                            <span className="min-w-0">
                              {l.name} {l.quantity > 1 && <span className="text-muted-foreground">× {l.quantity}</span>}
                            </span>
                            <span className="shrink-0 font-mono">
                              {m(l.unitCents * l.quantity)} <span className="text-xs text-muted-foreground">{t(l.yearly ? "cardPage.yearly" : "cardPage.monthly")}</span>
                            </span>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                {data.taxes ? t("cardPage.taxes") : t("cardPage.exempt")}
                {data.cardFee != null && ` ${t("cardPage.fee", { pct: data.cardFee.toLocaleString(i18n.language === "en" ? "en-CA" : "fr-CA") })}`}
              </p>
            </section>

            <section className="space-y-3">
              <p className="rounded-xl border bg-background/40 p-3 text-sm leading-relaxed">{data.text}</p>
              <label className="block space-y-1.5 text-sm">
                <span>{t("cardPage.name")}</span>
                <Input value={name} maxLength={120} autoComplete="name" onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox className="mt-0.5" checked={agree} onCheckedChange={(v) => setAgree(v === true)} />
                <span>{t("cardPage.agree")}</span>
              </label>
            </section>

            {acceptError && <p className="text-sm text-red-300">{t(acceptError === "stripe_not_ready" ? "cardPage.notReady" : "cardPage.error")}</p>}
            <Button type="submit" disabled={name.trim().length < 2 || !agree || accept.isPending} className="w-full bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {accept.isPending ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />} {t("cardPage.submit")}
            </Button>
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3" /> {t("cardPage.secure")}
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
