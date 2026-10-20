import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Briefcase, ChevronDown, Clock, Inbox, PanelLeftClose, PanelLeftOpen, History, FileText, ListOrdered, Mail, Tags, Ticket, PlugZap, Receipt, ShieldCheck, Users, Workflow, X, type LucideIcon } from "lucide-react";
import { LogoMark } from "@/components/brand/Logo";
import { TechBackground } from "@/components/brand/TechBackground";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { PermissionKey } from "@shared/permissions";
import { ActivitySection, RolesSection, StaffSection } from "./sections";
import { IntegrationsSection } from "./IntegrationsSection";
import { EmailSection } from "./EmailSection";
import { BillingSection } from "./BillingSection";
import { ContractTypesSection } from "./ContractTypesSection";
import { TimeExpenseSection } from "./TimeExpenseSection";
import { WorkflowsSection } from "./WorkflowsSection";
import { QueuesSection } from "./QueuesSection";
import { ClassesSection } from "./ClassesSection";
import { TicketSetupSection } from "./TicketSetupSection";
import { MailIntakeSection } from "./MailIntakeSection";

type Section = { key: string; labelKey: string; icon: LucideIcon; permission: PermissionKey[]; render: () => React.ReactNode };

const SECTIONS: Section[] = [
  { key: "staff", labelKey: "admin.sections.staff", icon: Users, permission: ["admin.staff"], render: () => <StaffSection /> },
  { key: "billing", labelKey: "admin.sections.billing", icon: Receipt, permission: ["admin.billing"], render: () => <BillingSection /> },
  { key: "contracttypes", labelKey: "admin.sections.contracttypes", icon: FileText, permission: ["admin.billing"], render: () => <ContractTypesSection /> },
  { key: "time", labelKey: "admin.sections.time", icon: Clock, permission: ["admin.billing"], render: () => <TimeExpenseSection /> },
  { key: "roles", labelKey: "admin.sections.roles", icon: ShieldCheck, permission: ["admin.roles"], render: () => <RolesSection /> },
  { key: "email", labelKey: "admin.sections.email", icon: Mail, permission: ["admin.email"], render: () => <EmailSection /> },
  { key: "integrations", labelKey: "admin.sections.integrations", icon: PlugZap, permission: ["admin.integrations"], render: () => <IntegrationsSection /> },
  { key: "mailintake", labelKey: "admin.sections.mailintake", icon: Inbox, permission: ["outlook.anyMailbox"], render: () => <MailIntakeSection /> },
  { key: "ticketsetup", labelKey: "admin.sections.ticketsetup", icon: Ticket, permission: ["admin.tickets"], render: () => <TicketSetupSection /> },
  { key: "classes", labelKey: "admin.sections.classes", icon: Tags, permission: ["admin.classes"], render: () => <ClassesSection /> },
  { key: "queues", labelKey: "admin.sections.queues", icon: ListOrdered, permission: ["admin.queues"], render: () => <QueuesSection /> },
  { key: "workflows", labelKey: "admin.sections.workflows", icon: Workflow, permission: ["admin.workflows"], render: () => <WorkflowsSection /> },
  {
    key: "activity",
    labelKey: "admin.sections.activity",
    icon: History,
    permission: ["admin.staff", "admin.clients", "admin.roles", "admin.integrations", "admin.email", "admin.workflows", "admin.queues", "admin.classes", "admin.tickets"],
    render: () => <ActivitySection />,
  },
];

/**
 * How the menu is laid out (the sections themselves are unchanged, and so are
 * their links): people and access, integrations, invoicing, the PSA settings
 * (workflows, email, classifications, queues, time and expenses, tickets), and
 * the activity log. A group folds away; its sections are also tabs on the page.
 */
type Entry = { kind: "item"; key: string } | { kind: "group"; id: string; labelKey: string; icon: LucideIcon; keys: string[] };
const MENU: Entry[] = [
  { kind: "group", id: "people", labelKey: "admin.groups.people", icon: Users, keys: ["staff", "roles"] },
  { kind: "item", key: "integrations" },
  { kind: "item", key: "billing" },
  { kind: "item", key: "contracttypes" },
  { kind: "group", id: "psa", labelKey: "admin.groups.psa", icon: Briefcase, keys: ["workflows", "email", "mailintake", "classes", "queues", "time", "ticketsetup"] },
  { kind: "item", key: "activity" },
];
const GROUPS_KEY = "akab.admin.groups";
const readGroups = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
};

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
  // the groups the person may see (a group with nothing allowed is left out), and which are folded
  const byKey = new Map(allowed.map((x) => [x.key, x]));
  const menu = MENU.flatMap((e): Entry[] => (e.kind === "item" ? (byKey.has(e.key) ? [e] : []) : e.keys.some((k) => byKey.has(k)) ? [{ ...e, keys: e.keys.filter((k) => byKey.has(k)) }] : []));
  const [folded, setFolded] = useState<Record<string, boolean>>(readGroups);
  const toggleGroup = (id: string, open: boolean) =>
    setFolded((f) => {
      const next = { ...f, [id]: open };
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });
  // the whole menu folded to icons (remembered)
  const [rail, setRail] = useState(() => {
    try {
      return localStorage.getItem("akab.admin.rail") === "1";
    } catch {
      return false;
    }
  });
  const toggleRail = () =>
    setRail((v) => {
      try {
        localStorage.setItem("akab.admin.rail", v ? "0" : "1");
      } catch {
        /* not remembered */
      }
      return !v;
    });
  const groupOfActive = menu.find((e): e is Extract<Entry, { kind: "group" }> => e.kind === "group" && e.keys.includes(active?.key ?? ""));

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
                <aside className={cn("relative hidden shrink-0 flex-col overflow-hidden border-r bg-sidebar transition-[width] duration-200 md:flex", rail ? "w-[72px]" : "w-64")}>
                  <TechBackground intensity={0.6} />
                  <div className={cn("relative flex items-center gap-3", rail ? "justify-center p-4 pt-6" : "p-6")}>
                    <LogoMark className="h-7" />
                    {!rail && (
                      <div>
                        <DialogPrimitive.Title className="font-display text-base font-bold">{t("admin.title")}</DialogPrimitive.Title>
                        <p className="text-xs text-muted-foreground">{t("admin.subtitle")}</p>
                      </div>
                    )}
                    {rail && <DialogPrimitive.Title className="sr-only">{t("admin.title")}</DialogPrimitive.Title>}
                  </div>
                  <nav className="relative min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4 scrollbar-thin">
                    {rail &&
                      menu.flatMap((e) => (e.kind === "item" ? [e.key] : e.keys)).map((k) => {
                        const x = byKey.get(k)!;
                        return <NavButton key={k} s={x} active={x.key === active?.key} onClick={() => go(x.key)} label={t(x.labelKey)} iconOnly />;
                      })}
                    {!rail &&
                      menu.map((e) => {
                      if (e.kind === "item") {
                        const x = byKey.get(e.key)!;
                        return <NavButton key={e.key} s={x} active={x.key === active?.key} onClick={() => go(x.key)} label={t(x.labelKey)} />;
                      }
                      const holdsActive = e.keys.includes(active?.key ?? "");
                      // open when it holds the page shown, unless it was folded by hand
                      const open = folded[e.id] === undefined ? holdsActive : !folded[e.id];
                      return (
                        <div key={e.id} className="pt-1">
                          <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => toggleGroup(e.id, open)}
                            className={cn(
                              "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors hover:bg-accent/60",
                              holdsActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            <e.icon className={cn("size-[18px]", holdsActive && "text-primary")} />
                            <span className="flex-1 text-left">{t(e.labelKey)}</span>
                            <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
                          </button>
                          <AnimatePresence initial={false}>
                            {open && (
                              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
                                <div className="ml-4 space-y-0.5 border-l border-border/60 py-1 pl-2">
                                  {e.keys.map((k) => {
                                    const x = byKey.get(k)!;
                                    return <NavButton key={k} s={x} active={x.key === active?.key} onClick={() => go(x.key)} label={t(x.labelKey)} small />;
                                  })}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </nav>
                  <button
                    type="button"
                    onClick={toggleRail}
                    title={rail ? t("admin.expandMenu") : t("admin.collapseMenu")}
                    aria-label={rail ? t("admin.expandMenu") : t("admin.collapseMenu")}
                    className={cn("relative mx-3 mb-3 mt-1 flex h-10 shrink-0 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground", rail && "justify-center px-0")}
                  >
                    {rail ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
                    {!rail && <span>{t("admin.collapseMenu")}</span>}
                  </button>
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
                        {groupOfActive && groupOfActive.keys.length > 1 && (
                          <div className="mb-6 flex flex-wrap gap-1 border-b" role="tablist" aria-label={t(groupOfActive.labelKey)}>
                            {groupOfActive.keys.map((k) => {
                              const x = byKey.get(k)!;
                              const on = k === active?.key;
                              return (
                                <button
                                  key={k}
                                  type="button"
                                  role="tab"
                                  aria-selected={on}
                                  onClick={() => go(k)}
                                  className={cn(
                                    "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                                    on ? "border-[color:var(--gold)] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  <x.icon className={cn("size-4", on && "text-primary")} /> {t(x.labelKey)}
                                </button>
                              );
                            })}
                          </div>
                        )}
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

function NavButton({ s, active, onClick, label, small, iconOnly }: { s: Section; active: boolean; onClick: () => void; label: string; small?: boolean; iconOnly?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
      className={cn(
        "relative flex w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
        iconOnly && "justify-center px-0",
        small ? "h-9" : "h-10",
        active ? "text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {active && (
        <motion.span layoutId="admin-active" className="absolute inset-0 rounded-lg border border-[color:var(--gold)]/25 bg-[color:var(--gold)]/10" transition={{ type: "spring", bounce: 0.15, duration: 0.4 }} />
      )}
      <s.icon className={cn("relative size-[18px]", small && "size-4", active && "text-primary")} />
      {!iconOnly && <span className="relative">{label}</span>}
    </button>
  );
}
