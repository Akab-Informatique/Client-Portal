import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";

/** When these two pages were last changed (YYYY-MM-DD) */
const UPDATED = "2026-10-23";

type Section = { h: string; p: string[] };

/**
 * The public privacy policy (/privacy) and terms of use (/terms): no sign-in, so they can be linked from QuickBooks
 * (Intuit asks for both addresses) and from emails.
 */
export function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const { t, i18n } = useTranslation();
  const page = t(`legal.${kind}`, { returnObjects: true }) as { title: string; sections: Section[] };
  const date = new Date(`${UPDATED}T12:00:00`).toLocaleDateString(i18n.language.startsWith("fr") ? "fr-CA" : "en-CA", { dateStyle: "long" });
  const other = kind === "privacy" ? { to: "/terms", label: t("legal.termsLink") } : { to: "/privacy", label: t("legal.privacyLink") };
  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-5 py-8">
      <div className="mb-8 flex items-center justify-between gap-3">
        <a href="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {t("legal.back")}
        </a>
        <LanguageToggle />
      </div>
      <Logo className="mb-6 h-10" />
      <h1 className="text-3xl font-bold">{page.title}</h1>
      <p className="mt-1 text-xs text-muted-foreground">{t("legal.updated", { date })}</p>
      <div className="mt-8 space-y-7">
        {page.sections.map((s) => (
          <section key={s.h} className="space-y-2">
            <h2 className="text-lg font-semibold">{s.h}</h2>
            {s.p.map((x, i) => (
              <p key={i} className="text-sm leading-relaxed text-muted-foreground">
                {x}
              </p>
            ))}
          </section>
        ))}
      </div>
      <p className="mt-10 border-t pt-4 text-sm">
        <a href={other.to} className="text-primary hover:underline">
          {other.label}
        </a>
      </p>
    </main>
  );
}
