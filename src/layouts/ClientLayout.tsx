import { Suspense, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsLeft, ChevronsRight, LogOut, Menu, Monitor, Moon, Settings2, Sun, UserRound } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { NotificationBell } from "@/components/NotificationBell";
import { ProfileDialog } from "@/components/ProfileDialog";
import { ViewAsBanner, ViewSwitcher } from "@/components/ViewSwitcher";
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
import { CLIENT_MODULES, CLIENT_NAV_SECTIONS, type ClientNavModule } from "@/modules/registry";
import { signOut, useCan, useMe } from "@/lib/session";
import { cn, initials } from "@/lib/utils";

const COLLAPSE_KEY = "akab.client.sidebar.collapsed";

/** Client portal: sidebar by section, like the team's, and a light top bar. */
export function ClientLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [collapsed]);
  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className="relative isolate flex min-h-dvh bg-background">
      {/* warm light and the honeycomb behind the glass */}
      <div className="client-ambient pointer-events-none fixed inset-0 -z-10" />
      <div className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[28rem] bg-grid opacity-40 [mask-image:radial-gradient(70%_100%_at_70%_0%,black,transparent)]" />
      <motion.aside
        animate={{ width: collapsed ? 92 : 272 }}
        transition={{ type: "spring", bounce: 0, duration: 0.35 }}
        className="sticky top-0 hidden h-dvh shrink-0 p-3 pr-0 lg:block"
      >
        <div className="pane h-full overflow-hidden rounded-3xl">
          <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        </div>
      </motion.aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="glass-strong w-72 border-r-[color:var(--glass-border)] p-0">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <Sidebar collapsed={false} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-30 px-3 pt-3">
          <ViewAsBanner />
          <TopBar onMenu={() => setMobileOpen(true)} />
        </div>
        <main className="relative flex-1">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="relative mx-auto w-full max-w-5xl px-4 pb-24 pt-8 sm:px-6 lg:px-10"
          >
            <Suspense fallback={<div className="pane h-40 animate-pulse rounded-2xl" />}>
              <Outlet />
            </Suspense>
          </motion.div>
        </main>
      </div>
    </div>
  );
}

function NavItem({ m, collapsed, active }: { m: ClientNavModule; collapsed: boolean; active: boolean }) {
  const { t } = useTranslation();
  if (m.upcoming) {
    return (
      <div
        className={cn("flex h-10 cursor-not-allowed items-center gap-3 rounded-xl px-3 text-sm text-muted-foreground/45", collapsed && "justify-center px-0")}
        title={`${t(m.labelKey)} — ${t("common.comingSoon")}`}
      >
        <m.icon className="size-[18px] shrink-0" />
        {!collapsed && (
          <>
            <span className="truncate">{t(m.labelKey)}</span>
            <Badge variant="outline" className="ml-auto h-5 border-[color:var(--glass-border)] bg-background/20 px-1.5 text-[10px] font-normal text-muted-foreground/70">
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
        "group relative flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
        collapsed && "justify-center px-0",
        active ? "text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="client-nav-active"
          className="absolute inset-0 rounded-xl border border-[color:var(--gold)]/25 bg-gradient-to-r from-[color:var(--gold)]/14 to-[color:var(--gold)]/[0.03] shadow-[0_0_22px_-10px_var(--gold)]"
          transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
        />
      )}
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

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle?: () => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const location = useLocation();
  const isActive = (path: string) => (path === "/" ? location.pathname === "/" : location.pathname.startsWith(path));
  const groups = CLIENT_NAV_SECTIONS.map((s) => ({
    ...s,
    // the right decides, even for pages not built yet
    items: CLIENT_MODULES.filter((m) => m.section === s.key && (!m.permission || can(m.permission))),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full flex-col">
      <div className={cn("flex h-[4.5rem] items-center", collapsed ? "justify-center px-2" : "px-6")}>
        {collapsed ? <LogoMark className="h-7" /> : <Logo />}
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2 scrollbar-thin">
        {groups.map((g) => (
          <div key={g.key}>
            {collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-[color:var(--gold)]/25" />
            ) : (
              <p className="px-3 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">{t(g.labelKey)}</p>
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
        <div className="p-3">
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
  const me = useMe();
  return (
    <header className="pane flex h-14 items-center gap-3 rounded-2xl px-3 sm:px-4">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Menu">
        <Menu className="size-5" />
      </Button>
      <span className="hidden min-w-0 items-center gap-2.5 sm:flex">
        <span className="size-1.5 shrink-0 rounded-full bg-grad-gold shadow-[0_0_10px_var(--gold)]" />
        <span className="truncate text-sm font-medium">{me.viewAs ? me.viewAs.clientName : me.client?.name}</span>
      </span>
      {me.viewAs && <ViewSwitcher />}
      <div className="ml-auto flex items-center gap-3">
        {!me.viewAs && <NotificationBell />}
        <LanguageToggle persist={!me.viewAs} className="hidden sm:flex" />
        {!me.viewAs && <UserMenu />}
      </div>
    </header>
  );
}

/** Profile (incl. email copies of the board), theme, sign out. */
function UserMenu() {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const can = useCan();
  const [profileOpen, setProfileOpen] = useState(false);
  const settings = can("clientAdmin.company") || can("clientAdmin.users");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2.5 rounded-xl border border-transparent py-1 pl-1 pr-2.5 transition-colors hover:border-[color:var(--glass-border)] hover:bg-foreground/[0.04] data-[state=open]:border-[color:var(--gold)]/40 data-[state=open]:bg-foreground/[0.04]"
          >
            <Avatar className="size-8 ring-1 ring-[color:var(--gold)]/40">
              <AvatarFallback className="bg-grad-gold text-xs font-bold text-[#1a1204]">{initials(me.name)}</AvatarFallback>
            </Avatar>
            <span className="hidden max-w-40 truncate text-left text-sm font-medium md:block">{me.name}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="glass-strong w-64">
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
          {settings && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate("/settings")} className="text-primary focus:text-primary">
                <Settings2 className="size-4" /> {t("client.settings.title")}
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
