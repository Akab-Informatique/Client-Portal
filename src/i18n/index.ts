import { en, type Dictionary } from "./locales/en";
import { fr } from "./locales/fr";

export type Locale = "en" | "fr";

export const LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
];

export const dictionaries: Record<Locale, Dictionary> = { en, fr };

export type { Dictionary };

/** Simple {name} interpolation */
export function interpolate(
  template: string,
  vars?: Record<string, string | number | null | undefined>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    return v == null ? "" : String(v);
  });
}

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "fr";
}
