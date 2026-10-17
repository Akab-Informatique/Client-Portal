import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import fr from "./fr";
import en from "./en";

export type Locale = "fr" | "en";

const KEY = "akab.locale";

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "fr" || saved === "en") return saved;
  } catch {
    /* storage unavailable */
  }
  // French by default (like akab.ca); users switch with the FR/EN toggle.
  return "fr";
}

void i18n.use(initReactI18next).init({
  resources: { fr: { translation: fr }, en: { translation: en } },
  lng: initialLocale(),
  fallbackLng: "fr",
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** The page language and the browser tab title follow the portal language. */
const TITLE: Record<Locale, string> = { fr: "Portail Akab", en: "Akab Portal" };
function applyLocale(lng: string) {
  const l: Locale = lng === "en" ? "en" : "fr";
  document.documentElement.lang = l;
  document.title = TITLE[l];
}
applyLocale(i18n.language);
i18n.on("languageChanged", applyLocale);

export function setLocale(l: Locale) {
  void i18n.changeLanguage(l);
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
}

export function currentLocale(): Locale {
  return i18n.language === "en" ? "en" : "fr";
}

export default i18n;
