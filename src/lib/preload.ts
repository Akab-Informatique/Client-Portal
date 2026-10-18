import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * Page code and data loaded ahead of time, so moving between pages feels
 * instant: every page's code after the portal opens (when the browser is
 * idle), and a page's data when the pointer rests on its link.
 */
export const pageLoaders = {
  dashboard: () => import("@/pages/dashboard/DashboardPage"),
  messages: () => import("@/pages/messages/MessagesPage"),
  tickets: () => import("@/pages/tickets/TicketsPage"),
  store: () => import("@/pages/store/StorePage"),
  outlook: () => import("@/pages/outlook/OutlookPage"),
  meetings: () => import("@/pages/meetings/MeetingsPage"),
  crm: () => import("@/pages/crm/ClientsPage"),
  client: () => import("@/pages/crm/ClientPage"),
  accounting: () => import("@/pages/accounting/AccountingPage"),
  approvals: () => import("@/pages/accounting/ApprovalsPage"),
  timesheet: () => import("@/pages/time/TimesheetPage"),
  expenses: () => import("@/pages/time/ExpensesPage"),
};

const byPath: Record<string, () => Promise<unknown>> = {
  "/": pageLoaders.dashboard,
  "/messages": pageLoaders.messages,
  "/tickets": pageLoaders.tickets,
  "/store": pageLoaders.store,
  "/outlook": pageLoaders.outlook,
  "/meetings": pageLoaders.meetings,
  "/crm": pageLoaders.crm,
  "/accounting/invoices": pageLoaders.accounting,
  "/accounting/quotes": pageLoaders.accounting,
  "/accounting/approvals": pageLoaders.approvals,
  "/timesheets": pageLoaders.timesheet,
  "/expenses": pageLoaders.expenses,
};

/** Load every page's code in the background once the portal is shown. */
export function preloadPagesWhenIdle() {
  const run = () => Object.values(pageLoaders).forEach((load) => void load().catch(() => undefined));
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}

/** On hover / focus of a menu link: the page's code and its first data. */
export function preloadRoute(path: string, qc: QueryClient) {
  void byPath[path]?.().catch(() => undefined);
  if (path === "/crm") void qc.prefetchQuery({ queryKey: ["crm", "clients"], queryFn: () => api.get("/crm/clients"), staleTime: 30_000 });
  if (path === "/tickets") {
    // same key as useTickets("mine", no filters)
    void qc.prefetchQuery({ queryKey: ["tickets", "view=mine"], queryFn: () => api.get("/tickets?view=mine"), staleTime: 15_000 });
  }
}
