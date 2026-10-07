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

document.documentElement.lang = i18n.language;

export function setLocale(l: Locale) {
  void i18n.changeLanguage(l);
  document.documentElement.lang = l;
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
