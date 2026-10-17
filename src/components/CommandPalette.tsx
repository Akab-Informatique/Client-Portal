import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/lib/theme";
import { Languages, Megaphone, Settings2, SunMoon } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { STAFF_MODULES } from "@/modules/registry";
import { useCan, useMe } from "@/lib/session";
import { setLocale } from "@/i18n";
import { api } from "@/lib/api";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const can = useCan();
  const me = useMe();
  const { resolvedTheme, setTheme } = useTheme();
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  const modules = STAFF_MODULES.filter((m) => !m.upcoming && (!m.permission || can(m.permission)) && (!m.optIn || me.preferences[m.optIn]));

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t("topbar.search")} description={t("palette.placeholder")}>
      <CommandInput placeholder={t("palette.placeholder")} />
      <CommandList>
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>
        <CommandGroup heading={t("palette.navigate")}>
          {modules.map((m) => (
            <CommandItem key={m.key} onSelect={() => run(() => navigate(m.path))}>
              <m.icon /> {t(m.labelKey)}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("palette.actions")}>
          {can("messages.post") && (
            <CommandItem onSelect={() => run(() => navigate("/messages?compose=1"))}>
              <Megaphone /> {t("palette.newMessage")}
            </CommandItem>
          )}
          {me.isAdmin && (
            <CommandItem
              onSelect={() =>
                run(() =>
                  setParams((p) => {
                    p.set("admin", "home");
                    return p;
                  }),
                )
              }
            >
              <Settings2 /> {t("palette.openAdmin")}
            </CommandItem>
          )}
          <CommandItem onSelect={() => run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))}>
            <SunMoon /> {t("palette.toggleTheme")}
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => {
                const next = i18n.language === "en" ? "fr" : "en";
                setLocale(next);
                void api.patch("/me", { locale: next }).catch(() => undefined);
              })
            }
          >
            <Languages /> {t("palette.switchLanguage")}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
