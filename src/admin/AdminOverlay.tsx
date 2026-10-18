import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { History, Mail, PlugZap, Receipt, ShieldCheck, Building2, Users, X, type LucideIcon } from "lucide-react";
import { LogoMark } from "@/components/brand/Logo";
import { TechBackground } from "@/components/brand/TechBackground";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { PermissionKey } from "@shared/permissions";
import { ActivitySection, ClientsSection, RolesSection, StaffSection } from "./sections";
import { IntegrationsSection } from "./IntegrationsSection";
import { EmailSection } from "./EmailSection";
import { BillingSection } from "./BillingSection";

type Section = { key: string; labelKey: string; icon: LucideIcon; permission: PermissionKey[]; render: () => React.ReactNode };

const SECTIONS: Section[] = [
  { key: "staff", labelKey: "admin.sections.staff", icon: Users, permission: ["admin.staff"], render: () => <StaffSection /> },
  { key: "clients", labelKey: "admin.sections.clients", icon: Building2, permission: ["admin.clients"], render: () => <ClientsSection /> },
  { key: "billing", labelKey: "admin.sections.billing", icon: Receipt, permission: ["admin.billing"], render: () => <BillingSection /> },
  { key: "roles", labelKey: "admin.sections.roles", icon: ShieldCheck, permission: ["admin.roles"], render: () => <RolesSection /> },
  { key: "email", labelKey: "admin.sections.email", icon: Mail, permission: ["admin.email"], render: () => <EmailSection /> },
  { key: "integrations", labelKey: "admin.sections.integrations", icon: PlugZap, permission: ["admin.integrations"], render: () => <IntegrationsSection /> },
  {
    key: "activity",
    labelKey: "admin.sections.activity",
    icon: History,
    permission: ["admin.staff", "admin.clients", "admin.roles", "admin.integrations", "admin.email"],
    render: () => <ActivitySection />,
  },
];

/**
 * Admin settings as a full-screen overlay on top of the app (URL: ?admin=<section>),
 * so it never replaces the technician's current page.
 */
export function AdminOverlay({ section }: { section: string | null }) {
  const { t } = useTranslation();
  const can = useCan();
  const [, setParams] = useSearchParams();
  const allowed = SECTIONS.filter((s) => can(...s.permission));
  const open = section !== null && allowed.length > 0;
  const active = allowed.find((s) => s.key === section) ?? allowed[0];

  const go = (key: string | null) =>
    setParams((p) => {
      if (key) p.set("admin", key);
      else p.delete("admin");
      p.delete("integration");
      p.delete("template");
      p.delete("tab");
      return p;
    });

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && go(null)}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
              <motion.div
                className="fixed inset-2 z-50 flex overflow-hidden rounded-3xl border bg-background shadow-2xl outline-none sm:inset-4 lg:inset-6"
                initial={{ opacity: 0, scale: 0.97, y: 16 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 10 }}
                transition={{ type: "spring", bounce: 0.12, duration: 0.45 }}
              >
                <aside className="relative hidden w-64 shrink-0 flex-col overflow-hidden border-r bg-sidebar md:flex">
                  <TechBackground intensity={0.6} />
                  <div className="relative flex items-center gap-3 p-6">
                    <LogoMark className="h-7" />
                    <div>
                      <DialogPrimitive.Title className="font-display text-base font-bold">{t("admin.title")}</DialogPrimitive.Title>
                      <p className="text-xs text-muted-foreground">{t("admin.subtitle")}</p>
                    </div>
                  </div>
                  <nav className="relative space-y-1 px-3">
                    {allowed.map((s) => {
                      const isActive = s.key === active?.key;
                      return (
                        <button
                          key={s.key}
                          type="button"
                          onClick={() => go(s.key)}
                          className={cn(
                            "relative flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                            isActive ? "text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                          )}
                        >
                          {isActive && (
                            <motion.span
                              layoutId="admin-active"
                              className="absolute inset-0 rounded-lg border border-[color:var(--gold)]/25 bg-[color:var(--gold)]/10"
                              transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
                            />
                          )}
                          <s.icon className={cn("relative size-[18px]", isActive && "text-primary")} />
                          <span className="relative">{t(s.labelKey)}</span>
                        </button>
                      );
                    })}
                  </nav>
                </aside>

                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-2 border-b px-4 py-3 md:hidden">
                    <DialogPrimitive.Title className="sr-only">{t("admin.title")}</DialogPrimitive.Title>
                    <div className="flex flex-1 gap-1 overflow-x-auto scrollbar-thin">
                      {allowed.map((s) => (
                        <button
                          key={s.key}
                          type="button"
                          onClick={() => go(s.key)}
                          className={cn(
                            "flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm",
                            s.key === active?.key ? "bg-[color:var(--gold)]/15 text-foreground" : "text-muted-foreground",
                          )}
                        >
                          <s.icon className="size-4" /> {t(s.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <DialogPrimitive.Close
                    className="absolute right-4 top-3 z-10 flex size-9 items-center justify-center rounded-full border bg-card text-muted-foreground transition-colors hover:border-[color:var(--gold)]/50 hover:text-foreground md:right-6 md:top-5"
                    aria-label={t("common.close")}
                  >
                    <X className="size-4" />
                  </DialogPrimitive.Close>
                  <div className="flex-1 overflow-y-auto scrollbar-thin">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={active?.key}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.2 }}
                        className="mx-auto max-w-6xl p-5 pt-8 sm:p-8 md:pr-20"
                      >
                        {active?.render()}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
