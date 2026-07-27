import { dictionaries, type Locale } from "@/i18n";

function currentLocale(): Locale {
  try {
    const stored = localStorage.getItem("soluti-portal-locale");
    if (stored === "en" || stored === "fr") return stored;
  } catch {
    /* ignore */
  }
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("fr")) {
    return "fr";
  }
  return "en";
}

export function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  const locale = currentLocale() === "fr" ? "fr-CA" : undefined;
  return d.toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function roleLabel(role: string) {
  const dict = dictionaries[currentLocale()];
  switch (role) {
    case "admin":
      return dict.roles.admin;
    case "technician":
      return dict.roles.technician;
    case "client":
      return dict.roles.client;
    default:
      return role;
  }
}
