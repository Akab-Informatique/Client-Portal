/** Per-user + per-company dashboard layout preferences (client + admin). */

export type DashboardDensity = "comfortable" | "compact";
export type StatsColumns = 2 | 4;

export type ClientWidgetId =
  | "welcome"
  | "notifications"
  | "stats"
  | "messages"
  | "tickets"
  | "teammates"
  | "quickLinks";

export type AdminWidgetId =
  | "stats"
  | "messages"
  | "clients"
  | "addons"
  | "quickLinks";

export interface ClientDashboardLayout {
  version: 1;
  order: ClientWidgetId[];
  hidden: ClientWidgetId[];
  density: DashboardDensity;
  statsColumns: StatsColumns;
}

export interface AdminDashboardLayout {
  version: 1;
  order: AdminWidgetId[];
  hidden: AdminWidgetId[];
  density: DashboardDensity;
  statsColumns: StatsColumns;
}

export const DEFAULT_CLIENT_ORDER: ClientWidgetId[] = [
  "welcome",
  "notifications",
  "stats",
  "messages",
  "tickets",
  "teammates",
  "quickLinks",
];

export const DEFAULT_ADMIN_ORDER: AdminWidgetId[] = [
  "stats",
  "messages",
  "clients",
  "addons",
  "quickLinks",
];

/** Widgets that cannot be hidden (core identity). */
export const CLIENT_LOCKED: ClientWidgetId[] = [];
export const ADMIN_LOCKED: AdminWidgetId[] = [];

export function defaultClientLayout(): ClientDashboardLayout {
  return {
    version: 1,
    order: [...DEFAULT_CLIENT_ORDER],
    hidden: ["quickLinks"],
    density: "comfortable",
    statsColumns: 4,
  };
}

export function defaultAdminLayout(): AdminDashboardLayout {
  return {
    version: 1,
    order: [...DEFAULT_ADMIN_ORDER],
    hidden: ["quickLinks"],
    density: "comfortable",
    statsColumns: 4,
  };
}

const CLIENT_KEY = (userId: number) => `soluti-dash-client-v1-${userId}`;
const ADMIN_KEY = (userId: number) => `soluti-dash-admin-v1-${userId}`;

function isClientWidget(v: unknown): v is ClientWidgetId {
  return (
    typeof v === "string" &&
    (DEFAULT_CLIENT_ORDER as string[]).includes(v)
  );
}

function isAdminWidget(v: unknown): v is AdminWidgetId {
  return (
    typeof v === "string" && (DEFAULT_ADMIN_ORDER as string[]).includes(v)
  );
}

export function normalizeClient(
  raw: Partial<ClientDashboardLayout> | null | undefined,
): ClientDashboardLayout {
  const base = defaultClientLayout();
  if (!raw || raw.version !== 1) return base;

  const seen = new Set<ClientWidgetId>();
  const order: ClientWidgetId[] = [];
  for (const id of raw.order ?? []) {
    if (isClientWidget(id) && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  for (const id of DEFAULT_CLIENT_ORDER) {
    if (!seen.has(id)) order.push(id);
  }

  const hidden = (raw.hidden ?? [])
    .filter(isClientWidget)
    .filter((id, i, arr) => arr.indexOf(id) === i);

  return {
    version: 1,
    order,
    hidden,
    density: raw.density === "compact" ? "compact" : "comfortable",
    statsColumns: raw.statsColumns === 2 ? 2 : 4,
  };
}

function normalizeAdmin(raw: Partial<AdminDashboardLayout> | null): AdminDashboardLayout {
  const base = defaultAdminLayout();
  if (!raw || raw.version !== 1) return base;

  const seen = new Set<AdminWidgetId>();
  const order: AdminWidgetId[] = [];
  for (const id of raw.order ?? []) {
    if (isAdminWidget(id) && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  for (const id of DEFAULT_ADMIN_ORDER) {
    if (!seen.has(id)) order.push(id);
  }

  const hidden = (raw.hidden ?? [])
    .filter(isAdminWidget)
    .filter((id, i, arr) => arr.indexOf(id) === i);

  return {
    version: 1,
    order,
    hidden,
    density: raw.density === "compact" ? "compact" : "comfortable",
    statsColumns: raw.statsColumns === 2 ? 2 : 4,
  };
}

/** Parse company.dashboard_layout JSON into a normalized layout (or null if unset/invalid). */
export function parseCompanyClientLayout(
  json: string | null | undefined,
): ClientDashboardLayout | null {
  if (!json || !json.trim()) return null;
  try {
    const raw = JSON.parse(json) as Partial<ClientDashboardLayout>;
    if (raw?.version !== 1) return null;
    return normalizeClient(raw);
  } catch {
    return null;
  }
}

export function serializeClientLayout(layout: ClientDashboardLayout): string {
  return JSON.stringify(normalizeClient(layout));
}

/** True when this user has saved a personal override in localStorage. */
export function hasPersonalClientLayout(userId: number): boolean {
  try {
    return localStorage.getItem(CLIENT_KEY(userId)) != null;
  } catch {
    return false;
  }
}

/**
 * Resolve the layout a client user should see:
 * 1. Personal override (localStorage), if any
 * 2. Company default set by admin
 * 3. Global product default
 */
export function resolveClientLayout(
  userId: number,
  companyDefault: ClientDashboardLayout | null = null,
): ClientDashboardLayout {
  try {
    const raw = localStorage.getItem(CLIENT_KEY(userId));
    if (raw) {
      return normalizeClient(JSON.parse(raw) as Partial<ClientDashboardLayout>);
    }
  } catch {
    /* fall through */
  }
  return companyDefault ? normalizeClient(companyDefault) : defaultClientLayout();
}

/** Baseline used for "Reset" — company default when set, else product default. */
export function clientLayoutBaseline(
  companyDefault: ClientDashboardLayout | null = null,
): ClientDashboardLayout {
  return companyDefault ? normalizeClient(companyDefault) : defaultClientLayout();
}

export function loadClientLayout(userId: number): ClientDashboardLayout {
  try {
    const raw = localStorage.getItem(CLIENT_KEY(userId));
    if (!raw) return defaultClientLayout();
    return normalizeClient(JSON.parse(raw) as Partial<ClientDashboardLayout>);
  } catch {
    return defaultClientLayout();
  }
}

export function saveClientLayout(userId: number, layout: ClientDashboardLayout) {
  localStorage.setItem(CLIENT_KEY(userId), JSON.stringify(normalizeClient(layout)));
}

/** Clear personal override so the company (or product) default applies again. */
export function clearClientLayout(userId: number) {
  try {
    localStorage.removeItem(CLIENT_KEY(userId));
  } catch {
    /* ignore */
  }
}

export function loadAdminLayout(userId: number): AdminDashboardLayout {
  try {
    const raw = localStorage.getItem(ADMIN_KEY(userId));
    if (!raw) return defaultAdminLayout();
    return normalizeAdmin(JSON.parse(raw) as Partial<AdminDashboardLayout>);
  } catch {
    return defaultAdminLayout();
  }
}

export function saveAdminLayout(userId: number, layout: AdminDashboardLayout) {
  localStorage.setItem(ADMIN_KEY(userId), JSON.stringify(layout));
}

export function moveInOrder<T extends string>(order: T[], id: T, dir: -1 | 1): T[] {
  const idx = order.indexOf(id);
  if (idx < 0) return order;
  const next = idx + dir;
  if (next < 0 || next >= order.length) return order;
  const copy = [...order];
  const tmp = copy[idx];
  copy[idx] = copy[next];
  copy[next] = tmp;
  return copy;
}

export function toggleHidden<T extends string>(hidden: T[], id: T): T[] {
  return hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
}

export function isVisible<T extends string>(layout: { hidden: T[] }, id: T): boolean {
  return !layout.hidden.includes(id);
}
