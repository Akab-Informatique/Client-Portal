import { lazy, Suspense, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/lib/theme";
import {
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Settings2,
  Sun,
  UserRound,
} from "lucide-react";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { CommandPalette } from "@/components/CommandPalette";
import { ViewSwitcher } from "@/components/ViewSwitcher";
import { NotificationBell } from "@/components/NotificationBell";
import { ProfileDialog } from "@/components/ProfileDialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NAV_SECTIONS, STAFF_MODULES, type NavModule } from "@/modules/registry";
import { signOut, useCan, useMe } from "@/lib/session";
import { cn, initials } from "@/lib/utils";

const AdminOverlay = lazy(() => import("@/admin/AdminOverlay").then((m) => ({ default: m.AdminOverlay })));

const COLLAPSE_KEY = "akab.sidebar.collapsed";

export function StaffLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const [params] = useSearchParams();
  const me = useMe();

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [collapsed]);
  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const adminSection = params.get("admin");

  return (
    <div className="flex min-h-dvh bg-background">
      <motion.aside
        animate={{ width: collapsed ? 76 : 256 }}
        transition={{ type: "spring", bounce: 0, duration: 0.35 }}
        className="sticky top-0 hidden h-dvh shrink-0 border-r bg-sidebar lg:block"
      >
        <SidebarContent collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </motion.aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SidebarContent collapsed={false} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMobileOpen(true)} />
        <main className="relative flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-grid opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="relative mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8"
            >
              <Suspense fallback={<div className="h-40 animate-pulse rounded-2xl bg-card/50" />}>
                <Outlet />
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {me.isAdmin && adminSection !== null && (
        <Suspense fallback={null}>
          <AdminOverlay section={adminSection} />
        </Suspense>
      )}
    </div>
  );
}

function NavItem({ m, collapsed, active }: { m: NavModule; collapsed: boolean; active: boolean }) {
  const { t } = useTranslation();
  if (m.upcoming) {
    return (
      <div
        className={cn("flex h-10 cursor-not-allowed items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground/50", collapsed && "justify-center px-0")}
        title={`${t(m.labelKey)} — ${t("common.comingSoon")}`}
      >
        <m.icon className="size-[18px] shrink-0" />
        {!collapsed && (
          <>
            <span className="truncate">{t(m.labelKey)}</span>
            <Badge variant="outline" className="ml-auto h-5 border-dashed px-1.5 text-[10px] font-normal text-muted-foreground/70">
              {t("common.comingSoon")}
            </Badge>
          </>
        )}
      </div>
    );
  }
  const link = (
    <NavLink
      to={m.path}
      className={cn(
        "group relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
        collapsed && "justify-center px-0",
        active ? "text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-lg border border-[color:var(--gold)]/25 bg-[color:var(--gold)]/10"
          transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
        />
      )}
      {active && <motion.span layoutId="nav-bar" className="absolute -left-3 top-2 bottom-2 w-1 rounded-r-full bg-grad-gold" />}
      <m.icon className={cn("relative size-[18px] shrink-0", active && "text-primary")} />
      {!collapsed && <span className="relative truncate">{t(m.labelKey)}</span>}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{t(m.labelKey)}</TooltipContent>
    </Tooltip>
  ) : (
    link
  );
}

function SidebarContent({ collapsed, onToggle }: { collapsed: boolean; onToggle?: () => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const location = useLocation();
  const visible = (m: NavModule) => m.upcoming || !m.permission || can(m.permission);
  const isActive = (path: string) => (path === "/" ? location.pathname === "/" : location.pathname.startsWith(path));
  // Sections show their live modules (and upcoming ones, except in the main section,
  // whose upcoming modules are listed under "À venir")
  const groups = [
    ...NAV_SECTIONS.map((s) => ({
      key: s.key,
      labelKey: s.labelKey,
      items: STAFF_MODULES.filter((m) => m.section === s.key && visible(m) && !(s.key === "modules" && m.upcoming)),
    })),
    { key: "upcoming", labelKey: "nav.upcoming", items: STAFF_MODULES.filter((m) => m.section === "modules" && m.upcoming) },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full flex-col">
      <div className={cn("flex h-16 items-center border-b", collapsed ? "justify-center px-2" : "px-5")}>
        {collapsed ? <LogoMark className="h-7" /> : <Logo />}
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto p-3 scrollbar-thin">
        {groups.map((g) => (
          <div key={g.key}>
            {collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-border first:hidden" />
            ) : (
              <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t(g.labelKey)}</p>
            )}
            <ul className="space-y-1">
              {g.items.map((m) => (
                <li key={m.key}>
                  <NavItem m={m} collapsed={collapsed} active={!m.upcoming && isActive(m.path)} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {onToggle && (
        <div className="border-t p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
            className={cn("w-full text-muted-foreground", collapsed ? "justify-center" : "justify-start")}
            aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
          >
            {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
            {!collapsed && <span>{t("nav.collapse")}</span>}
          </Button>
        </div>
      )}
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const can = useCan();
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/75 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Menu">
        <Menu className="size-5" />
      </Button>
      {can("clientview.use") && <ViewSwitcher />}
      <div className="ml-auto flex items-center gap-3">
        <NotificationBell />
        <LanguageToggle persist className="hidden sm:flex" />
        <UserMenu />
      </div>
    </header>
  );
}

function UserMenu() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const { theme, setTheme } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);
  const roleName = me.role ? (i18n.language === "en" ? me.role.nameEn : me.role.name) : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2.5 rounded-xl border border-transparent py-1 pl-1 pr-2.5 transition-colors hover:border-border hover:bg-card data-[state=open]:border-[color:var(--gold)]/40 data-[state=open]:bg-card"
          >
            <Avatar className="size-8 ring-1 ring-[color:var(--gold)]/40">
              <AvatarFallback className="bg-grad-gold text-xs font-bold text-[#1a1204]">{initials(me.name)}</AvatarFallback>
            </Avatar>
            <span className="hidden text-left leading-tight md:block">
              <span className="block max-w-40 truncate text-sm font-medium">{me.name}</span>
              {roleName && <span className="block text-[11px] text-muted-foreground">{roleName}</span>}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="font-normal">
            <p className="text-xs text-muted-foreground">{t("topbar.signedInAs")}</p>
            <p className="truncate text-sm font-medium">{me.name}</p>
            <p className="truncate text-xs text-muted-foreground">{me.email}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setProfileOpen(true)}>
            <UserRound className="size-4" /> {t("topbar.profile")}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Moon className="size-4" /> {t("topbar.theme")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                <DropdownMenuRadioItem value="dark">
                  <Moon className="size-4" /> {t("topbar.dark")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="light">
                  <Sun className="size-4" /> {t("topbar.light")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">
                  <Monitor className="size-4" /> {t("topbar.system")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {me.isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setParams((p) => {
                  p.set("admin", "home");
                  return p;
                })}
                className="text-primary focus:text-primary"
              >
                <Settings2 className="size-4" /> {t("topbar.adminSettings")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={async () => {
              await signOut(qc);
              navigate("/", { replace: true });
            }}
          >
            <LogOut className="size-4" /> {t("topbar.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </>
  );
}
