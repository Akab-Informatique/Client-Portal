import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Bell,
  Building2,
  CheckSquare,
  ChevronDown,
  FileStack,
  FileText,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Monitor,
  Moon,
  Receipt,
  Settings2,
  Siren,
  Sun,
  Ticket,
  UserCircle2,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { SosButton } from "@/components/SosButton";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/hooks/use-theme";
import { useLocale } from "@/hooks/use-locale";
import { roleLabel } from "@/lib/format";
import { LOCALES, type Locale } from "@/i18n";
import { isLocale } from "@/i18n";
import { updateOwnProfile } from "@/lib/profiles";
import { BrandLogo } from "@/components/BrandLogo";
import type { StaffPermission } from "@/lib/permissions";
import { useSelectedClientOptional } from "@/context/SelectedClientContext";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
  badge?: number;
}

interface NavGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: NavItem[];
}

interface NavSection {
  id: string;
  label: string;
  /** Flat links under a non-collapsible section label. */
  items?: NavItem[];
  /** Collapsible groups under the section (e.g. Operations / Billing). */
  groups?: NavGroup[];
  /** Show the global client picker above this section's groups. */
  showClientPicker?: boolean;
}

export type NavEntry =
  | { type: "item"; item: NavItem }
  | { type: "group"; group: NavGroup }
  | { type: "section"; section: NavSection };

interface AppShellProps {
  title: string;
  subtitle?: string;
  nav: NavItem[];
  /** Segmented sidebar (sections / groups / items). When set, takes precedence over flat `nav`. */
  navEntries?: NavEntry[];
  children: ReactNode;
  badge?: string;
}

export function AppShell({
  title,
  subtitle,
  nav,
  navEntries,
  children,
  badge,
}: AppShellProps) {
  const { user, logout, patchSession } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { t, locale, setLocale } = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const selectedClientCtx = useSelectedClientOptional();

  /** To-do is its own sidebar workspace (replaces the main admin menu). */
  const isTodoWorkspace =
    location.pathname === "/admin/todo" ||
    location.pathname.startsWith("/admin/todo/");

  const entries: NavEntry[] = useMemo(() => {
    if (navEntries && navEntries.length > 0) return navEntries;
    return nav.map((item) => ({ type: "item" as const, item }));
  }, [nav, navEntries]);

  const groupIds = useMemo(() => {
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.type === "group") ids.push(entry.group.id);
      if (entry.type === "section" && entry.section.groups) {
        for (const g of entry.section.groups) ids.push(g.id);
      }
    }
    return ids;
  }, [entries]);

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const pathMatches = (item: NavItem, pathname: string) =>
    item.end
      ? pathname === item.to
      : pathname === item.to || pathname.startsWith(`${item.to}/`);

  // Auto-expand a group when one of its children is active
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = { ...prev };
      const visit = (group: NavGroup) => {
        const active = group.children.some((c) =>
          pathMatches(c, location.pathname),
        );
        if (active) next[group.id] = true;
        else if (next[group.id] == null) next[group.id] = false;
      };
      for (const entry of entries) {
        if (entry.type === "group") visit(entry.group);
        if (entry.type === "section" && entry.section.groups) {
          for (const g of entry.section.groups) visit(g);
        }
      }
      return next;
    });
  }, [location.pathname, entries]);

  // Ensure new groups have a default collapsed state
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = { ...prev };
      for (const id of groupIds) {
        if (next[id] == null) next[id] = false;
      }
      return next;
    });
  }, [groupIds]);

  const profilePath = useMemo(() => {
    if (!user) return "/login";
    return user.role === "client" ? "/client/profile/me" : "/admin/profile/me";
  }, [user]);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const switchLocale = async (next: Locale) => {
    setLocale(next);
    if (user) {
      try {
        const updated = await updateOwnProfile(user.id, { locale: next });
        if (updated) patchSession({ locale: next });
      } catch {
        /* preference still stored locally */
      }
    }
  };

  const renderLink = (
    item: NavItem,
    onNavigate?: () => void,
    nested = false,
  ) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-lg text-sm font-medium transition-colors",
          nested ? "px-3 py-2" : "px-3 py-2.5",
          isActive
            ? "bg-primary text-primary-foreground shadow-sm"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )
      }
    >
      <item.icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge != null && item.badge > 0 && (
        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-foreground/90 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-background">
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}
    </NavLink>
  );

  const renderGroup = (
    group: NavGroup,
    onNavigate?: () => void,
  ) => {
    if (group.children.length === 0) return null;
    const open = !!openGroups[group.id];
    const childActive = group.children.some((c) =>
      pathMatches(c, location.pathname),
    );
    return (
      <div key={group.id} className="space-y-1">
        <button
          type="button"
          onClick={() =>
            setOpenGroups((prev) => ({
              ...prev,
              [group.id]: !prev[group.id],
            }))
          }
          className={cn(
            "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors",
            childActive && !open
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
          aria-expanded={open}
        >
          <group.icon className="size-4 shrink-0" />
          <span className="flex-1 truncate">{group.label}</span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </button>
        {open && (
          <div className="ml-3 space-y-0.5 border-l border-sidebar-border pl-2">
            {group.children.map((child) =>
              renderLink(child, onNavigate, true),
            )}
          </div>
        )}
      </div>
    );
  };

  const renderClientPicker = () => {
    if (!selectedClientCtx) return null;
    const {
      clients,
      selectedClientId,
      setSelectedClientId,
      loading,
    } = selectedClientCtx;

    return (
      <div className="space-y-1.5 px-1 pb-2 pt-1">
        <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("nav.clientContext")}
        </p>
        <Select
          value={
            selectedClientId != null ? String(selectedClientId) : undefined
          }
          onValueChange={(v) => {
            const id = Number(v);
            if (Number.isFinite(id)) setSelectedClientId(id);
          }}
          disabled={loading || clients.length === 0}
        >
          <SelectTrigger
            className="h-9 w-full border-sidebar-border bg-sidebar-accent/40 text-left text-sm"
            aria-label={t("nav.selectClient")}
          >
            <SelectValue
              placeholder={
                loading
                  ? t("common.loading")
                  : clients.length === 0
                    ? t("nav.noClients")
                    : t("nav.selectClient")
              }
            />
          </SelectTrigger>
          <SelectContent>
            {clients.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  };

  const exitTodoWorkspace = (onNavigate?: () => void) => {
    navigate("/admin");
    onNavigate?.();
  };

  const TodoNavItems = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex flex-col gap-3 p-3">
      <Button
        type="button"
        variant="outline"
        className="h-auto w-full justify-start gap-2 border-sidebar-border bg-sidebar-accent/40 px-3 py-2.5 text-left text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent"
        onClick={() => exitTodoWorkspace(onNavigate)}
      >
        <ArrowLeft className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate">{t("todo.backToMain")}</span>
          <span className="block truncate text-[11px] font-normal text-muted-foreground">
            {t("todo.backToDashboard")}
          </span>
        </span>
      </Button>

      <div className="space-y-1">
        <p className="px-3 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          {t("todo.workspaceLabel")}
        </p>
        {renderLink(
          {
            to: "/admin/todo",
            label: t("todo.overview"),
            icon: CheckSquare,
            end: true,
          },
          onNavigate,
        )}
      </div>

      <div className="mx-1 rounded-lg border border-dashed border-sidebar-border bg-sidebar-accent/20 px-3 py-3">
        <p className="text-xs font-medium text-sidebar-foreground">
          {t("todo.comingTitle")}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t("todo.comingDesc")}
        </p>
      </div>
    </nav>
  );

  const NavItems = ({ onNavigate }: { onNavigate?: () => void }) => {
    if (isTodoWorkspace) {
      return <TodoNavItems onNavigate={onNavigate} />;
    }

    return (
      <nav className="flex flex-col gap-3 p-3">
        {entries.map((entry) => {
          if (entry.type === "item") {
            return (
              <div key={entry.item.to}>
                {renderLink(entry.item, onNavigate)}
              </div>
            );
          }
          if (entry.type === "group") {
            return renderGroup(entry.group, onNavigate);
          }

          const { section } = entry;
          return (
            <div key={section.id} className="space-y-1">
              <p className="px-3 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                {section.label}
              </p>
              {section.items?.map((item) => renderLink(item, onNavigate))}
              {section.showClientPicker && renderClientPicker()}
              {section.groups?.map((g) => renderGroup(g, onNavigate))}
            </div>
          );
        })}
      </nav>
    );
  };

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar lg:flex lg:flex-col">
        <div className="flex items-center gap-3 px-5 py-5">
          <BrandLogo size="md" showWordmark subtitle={t("app.clientPortal")} />
        </div>
        <Separator className="bg-sidebar-border" />
        <div className="flex-1 overflow-y-auto">
          <NavItems />
        </div>
        <div className="border-t border-sidebar-border p-4">
          <Link
            to={profilePath}
            className="block rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-3 transition-colors hover:border-primary/40 hover:bg-primary/10"
          >
            <p className="truncate text-sm font-semibold text-sidebar-foreground">
              {user?.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className="border-primary/40 bg-primary/10 text-primary"
              >
                {roleLabel(user?.role ?? "")}
              </Badge>
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("common.myProfile")}
              </span>
            </div>
          </Link>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-sidebar-border bg-sidebar shadow-xl">
            <div className="flex items-center justify-between px-4 py-4">
              <BrandLogo size="sm" showWordmark />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <Separator />
            <div className="flex-1 overflow-y-auto">
              <NavItems onNavigate={() => setMobileOpen(false)} />
            </div>
            <div className="border-t border-sidebar-border p-3">
              <Link
                to={profilePath}
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent"
              >
                <UserCircle2 className="size-4" />
                {t("common.myProfile")}
              </Link>
            </div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:gap-3 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-bold tracking-tight sm:text-xl">
                {title}
              </h1>
              {badge && (
                <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                  {badge}
                </Badge>
              )}
            </div>
            {subtitle && (
              <p className="truncate text-xs text-muted-foreground sm:text-sm">
                {subtitle}
              </p>
            )}
          </div>

          {/* Client SOS — beside language bar */}
          {user?.role === "client" && <SosButton />}

          {/* Language toggle */}
          <div
            className="hidden items-center rounded-lg border border-border p-0.5 sm:flex"
            role="group"
            aria-label={t("common.language")}
          >
            {LOCALES.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => switchLocale(l.code)}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-semibold transition-colors",
                  locale === l.code
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {l.code.toUpperCase()}
              </button>
            ))}
          </div>
          {/* Compact language on mobile */}
          <Button
            variant="outline"
            size="sm"
            className="px-2 font-semibold sm:hidden"
            onClick={() => switchLocale(locale === "en" ? "fr" : "en")}
            aria-label={t("common.language")}
          >
            {locale.toUpperCase()}
          </Button>

          <Button
            variant="outline"
            size="icon"
            onClick={toggleTheme}
            aria-label={t("common.theme")}
          >
            {theme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="hidden sm:inline-flex"
            asChild
          >
            <Link to={profilePath} aria-label={t("common.myProfile")}>
              <UserCircle2 className="size-4" />
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleLogout}
            className="gap-2"
          >
            <LogOut className="size-4" />
            <span className="hidden sm:inline">{t("common.signOut")}</span>
          </Button>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}

export function useAdminNav(): NavItem[] {
  const entries = useAdminNavEntries();
  return useMemo(() => {
    const items: NavItem[] = [];
    for (const e of entries) {
      if (e.type === "item") items.push(e.item);
      else if (e.type === "group") items.push(...e.group.children);
      else if (e.type === "section") {
        if (e.section.items) items.push(...e.section.items);
        if (e.section.groups) {
          for (const g of e.section.groups) items.push(...g.children);
        }
      }
    }
    return items;
  }, [entries]);
}

/**
 * Admin / technician sidebar:
 *  Générale → Dashboard, Message board, Settings
 *  Client picker (drives Operations + Billing)
 *  Operations → Documentation, Passwords, Directory
 *  Billing → Invoices, Contracts (Autotask placeholders)
 */
export function useAdminNavEntries(): NavEntry[] {
  const { t } = useLocale();
  const { can, user } = useAuth();

  return useMemo(() => {
    const allow = (perm: StaffPermission) => can(perm);

    const generaleItems: NavItem[] = [];
    if (allow("dashboard")) {
      generaleItems.push({
        to: "/admin",
        label: t("nav.dashboard"),
        icon: LayoutDashboard,
        end: true,
      });
    }
    if (allow("messages")) {
      generaleItems.push({
        to: "/admin/messages",
        label: t("nav.messages"),
        icon: Megaphone,
      });
    }

    // Settings (management + general) — under Générale after Message board
    const settingsChildren: NavItem[] = [];
    if (allow("clients")) {
      settingsChildren.push({
        to: "/admin/clients",
        label: t("nav.clients"),
        icon: Building2,
      });
    }
    if (allow("technicians") || allow("roles")) {
      settingsChildren.push({
        to: "/admin/technicians",
        label: t("nav.technicians"),
        icon: Wrench,
      });
    }
    if (
      allow("clients") ||
      allow("technicians") ||
      allow("roles") ||
      allow("dashboard") ||
      allow("documentation")
    ) {
      settingsChildren.push({
        to: "/admin/settings",
        label: t("nav.generalSettings"),
        icon: Settings2,
      });
    }

    // Flat Settings entry under Générale (opens the settings hub)
    // Keep the nested management pages reachable from Settings page + this link.
    if (settingsChildren.length > 0) {
      generaleItems.push({
        to: "/admin/settings",
        label: t("nav.settings"),
        icon: Settings2,
      });
    }

    // To do — opens a dedicated sidebar workspace (available to all staff)
    generaleItems.push({
      to: "/admin/todo",
      label: t("nav.todo"),
      icon: CheckSquare,
    });

    // SOS incoming queue — all staff
    generaleItems.push({
      to: "/admin/sos",
      label: t("nav.sos"),
      icon: Siren,
    });

    const operationsChildren: NavItem[] = [];
    if (allow("documentation")) {
      operationsChildren.push({
        to: "/admin/documentation",
        label: t("nav.documentation"),
        icon: FileText,
      });
    }
    if (allow("passwords")) {
      operationsChildren.push({
        to: "/admin/passwords",
        label: t("nav.passwords"),
        icon: KeyRound,
      });
    }
    if (allow("devices")) {
      operationsChildren.push({
        to: "/admin/devices",
        label: t("nav.devices"),
        icon: Monitor,
      });
    }
    if (allow("directory")) {
      operationsChildren.push({
        to: "/admin/directory",
        label: t("nav.directory"),
        icon: Users,
      });
    }

    // Billing is visible to any staff who can open the admin shell
    // (dashboard or clients) — content is placeholder until Autotask links land.
    const showBilling =
      allow("dashboard") || allow("clients") || allow("messages");
    const billingChildren: NavItem[] = showBilling
      ? [
          {
            to: "/admin/billing/invoices",
            label: t("nav.invoices"),
            icon: Receipt,
          },
          {
            to: "/admin/billing/contracts",
            label: t("nav.contracts"),
            icon: FileStack,
          },
        ]
      : [];

    const clientGroups: NavGroup[] = [];
    if (operationsChildren.length > 0) {
      clientGroups.push({
        id: "operations",
        label: t("nav.operations"),
        icon: Wrench,
        children: operationsChildren,
      });
    }
    if (billingChildren.length > 0) {
      clientGroups.push({
        id: "billing",
        label: t("nav.billing"),
        icon: Receipt,
        children: billingChildren,
      });
    }

    const entries: NavEntry[] = [];

    if (generaleItems.length > 0) {
      entries.push({
        type: "section",
        section: {
          id: "generale",
          label: t("nav.generale"),
          items: generaleItems,
        },
      });
    }

    if (clientGroups.length > 0) {
      entries.push({
        type: "section",
        section: {
          id: "client-workspace",
          label: t("nav.clientWorkspace"),
          showClientPicker: true,
          groups: clientGroups,
        },
      });
    }

    return entries;
  }, [t, can, user?.id, user?.permissions]);
}

export function useClientNav(unreadCount = 0): NavItem[] {
  const { t } = useLocale();
  const { user } = useAuth();
  return useMemo(() => {
    const p = user?.client_permissions;
    // Missing map (legacy session) → show core sections; billing still gated.
    const allow = (key: keyof NonNullable<typeof p>) =>
      p == null ? key !== "billing" : !!p[key];

    const items: NavItem[] = [
      {
        to: "/client",
        label: t("nav.dashboard"),
        icon: LayoutDashboard,
        end: true,
      },
    ];
    if (allow("board")) {
      items.push({
        to: "/client/board",
        label: t("nav.board"),
        icon: Bell,
        badge: unreadCount > 0 ? unreadCount : undefined,
      });
    }
    if (allow("tickets")) {
      items.push({
        to: "/client/tickets",
        label: t("nav.tickets"),
        icon: Ticket,
      });
    }
    if (allow("documentation")) {
      items.push({
        to: "/client/documentation",
        label: t("nav.documentation"),
        icon: FileText,
      });
    }
    if (allow("passwords")) {
      items.push({
        to: "/client/passwords",
        label: t("nav.passwords"),
        icon: KeyRound,
      });
    }
    if (allow("directory")) {
      items.push({
        to: "/client/directory",
        label: t("nav.directory"),
        icon: Users,
      });
    }
    // Billing: stacked role permission + optional per-user override
    if (user?.billing_enabled) {
      items.push({
        to: "/client/billing",
        label: t("nav.billing"),
        icon: Receipt,
      });
    }
    return items;
  }, [t, unreadCount, user?.billing_enabled, user?.client_permissions]);
}

/** @deprecated use useAdminNav / useClientNav for translated labels */
export const adminNav: NavItem[] = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/admin/clients", label: "Clients", icon: Building2 },
  { to: "/admin/technicians", label: "Technicians", icon: Wrench },
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/messages", label: "Message board", icon: Megaphone },
];

export const clientNav: NavItem[] = [
  { to: "/client", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/client/board", label: "Message board", icon: Bell },
  { to: "/client/tickets", label: "Open tickets", icon: Ticket },
];

// silence unused import if tree-shaken oddly
void isLocale;
