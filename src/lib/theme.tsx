import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "dark" | "light" | "system";
type Ctx = { theme: Theme; resolvedTheme: "dark" | "light"; setTheme: (t: Theme | string) => void };

const KEY = "akab.theme";
const ThemeCtx = createContext<Ctx>({ theme: "dark", resolvedTheme: "dark", setTheme: () => undefined });

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "dark";
}

const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;

/** Dark by default (akab.ca); light and system available. Applies the `dark` class on <html>. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(read);
  const [sysDark, setSysDark] = useState(systemDark);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const h = () => setSysDark(mq.matches);
    mq?.addEventListener("change", h);
    return () => mq?.removeEventListener("change", h);
  }, []);
  const resolvedTheme: "dark" | "light" = theme === "system" ? (sysDark ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolvedTheme === "dark" ? "#0a0a0b" : "#f4f4f1");
  }, [resolvedTheme]);
  const setTheme = useCallback((t: Theme | string) => {
    const next: Theme = t === "light" || t === "system" ? t : "dark";
    setThemeState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
