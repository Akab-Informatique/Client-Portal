import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { setLocale, type Locale } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** FR / EN pill, like akab.ca. When signed in, the choice is saved to the profile. */
export function LanguageToggle({ persist = false, className }: { persist?: boolean; className?: string }) {
  const { i18n } = useTranslation();
  const current = (i18n.language === "en" ? "en" : "fr") as Locale;
  const choose = (l: Locale) => {
    if (l === current) return;
    setLocale(l);
    if (persist) void api.patch("/me", { locale: l }).catch(() => undefined);
  };
  return (
    <div className={cn("relative flex rounded-full border bg-card/60 p-0.5 text-xs font-semibold backdrop-blur", className)}>
      {(["fr", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => choose(l)}
          className={cn(
            "relative z-10 rounded-full px-3 py-1 uppercase transition-colors",
            current === l ? "text-[#1a1204]" : "text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={current === l}
        >
          {current === l && (
            <motion.span layoutId="lang-pill" className="absolute inset-0 -z-10 rounded-full bg-grad-gold" transition={{ type: "spring", bounce: 0.2, duration: 0.45 }} />
          )}
          {l}
        </button>
      ))}
    </div>
  );
}
