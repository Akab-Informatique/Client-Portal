export type SosStatus =
  | "open"
  | "waiting"
  | "ready"
  | "connected"
  | "closed"
  | "expired"
  | "error";

export type SosRequest = {
  id: number;
  companyId: number;
  companyName: string;
  userId: number;
  userName: string;
  userEmail: string;
  issue: string | null;
  status: SosStatus | string;
  supportPortalLink: string | null;
  /** api = Open API session; manual = classic SOS code shared via portal */
  mode?: "api" | "manual" | string;
  classicSosUrl?: string | null;
  sosCode?: string | null;
  connectUrl?: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  closedAt: string | null;
  lastPolledAt: string | null;
  remoteSnapshot?: string | null;
};

export const DEFAULT_CLASSIC_SOS_URL = "https://sos.splashtop.com";

function errMsg(d: unknown, fallback: string): string {
  if (d && typeof d === "object" && "error" in d) {
    const e = (d as { error?: unknown }).error;
    if (typeof e === "string" && e.trim()) return e;
  }
  return fallback;
}

export async function createSosRequest(input: {
  userId: number;
  userName: string;
  userEmail: string;
  companyId: number;
  companyName: string;
  issue?: string | null;
  /** Manual mode: SOS code from the classic Splashtop SOS app */
  sosCode?: string | null;
}): Promise<{
  request: SosRequest | null;
  error: string | null;
  reused?: boolean;
  mode?: string;
  needsCode?: boolean;
  classicSosUrl?: string;
  warning?: string;
  configured?: boolean;
}> {
  const r = await fetch("/api/sos/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  const d = (await r.json()) as {
    request?: SosRequest;
    error?: string;
    reused?: boolean;
    mode?: string;
    needsCode?: boolean;
    classicSosUrl?: string;
    warning?: string;
    configured?: boolean;
  };
  if (!r.ok && !d.request) {
    return {
      request: null,
      error: errMsg(d, `SOS failed (${r.status})`),
      mode: d.mode,
      needsCode: d.needsCode,
      classicSosUrl: d.classicSosUrl,
      configured: d.configured,
    };
  }
  return {
    request: d.request ?? null,
    error: d.error ? String(d.error) : null,
    reused: d.reused,
    mode: d.mode,
    needsCode: d.needsCode,
    classicSosUrl: d.classicSosUrl,
    warning: d.warning,
    configured: d.configured,
  };
}

export async function attachSosCode(
  requestId: number,
  sosCode: string,
): Promise<{ request: SosRequest | null; error: string | null }> {
  const r = await fetch(`/api/sos/requests/${requestId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      action: "set_code",
      role: "client",
      sosCode,
    }),
  });
  const d = (await r.json()) as { request?: SosRequest; error?: string };
  if (!r.ok) {
    return { request: null, error: errMsg(d, `Could not save SOS code (${r.status})`) };
  }
  return { request: d.request ?? null, error: null };
}

export async function fetchClientSosRequests(
  userId: number,
): Promise<{
  requests: SosRequest[];
  error: string | null;
  configured: boolean;
}> {
  const q = new URLSearchParams({
    role: "client",
    userId: String(userId),
    refresh: "1",
  });
  const r = await fetch(`/api/sos/requests?${q}`, {
    headers: { Accept: "application/json" },
  });
  const d = (await r.json()) as {
    requests?: SosRequest[];
    error?: string;
    configured?: boolean;
  };
  if (!r.ok) {
    return {
      requests: [],
      configured: Boolean(d.configured),
      error: errMsg(d, `SOS list failed (${r.status})`),
    };
  }
  return {
    requests: Array.isArray(d.requests) ? d.requests : [],
    configured: Boolean(d.configured),
    error: d.error ? String(d.error) : null,
  };
}

export async function fetchStaffSosQueue(opts?: {
  includeClosed?: boolean;
}): Promise<{
  requests: SosRequest[];
  openCount: number;
  configured: boolean;
  error: string | null;
}> {
  const q = new URLSearchParams({ role: "staff", refresh: "1" });
  if (opts?.includeClosed) q.set("includeClosed", "1");
  const r = await fetch(`/api/sos/requests?${q}`, {
    headers: { Accept: "application/json" },
  });
  const d = (await r.json()) as {
    requests?: SosRequest[];
    openCount?: number;
    configured?: boolean;
    error?: string;
  };
  if (!r.ok) {
    return {
      requests: [],
      openCount: 0,
      configured: Boolean(d.configured),
      error: errMsg(d, `SOS queue failed (${r.status})`),
    };
  }
  return {
    requests: Array.isArray(d.requests) ? d.requests : [],
    openCount: Number(d.openCount ?? 0),
    configured: Boolean(d.configured),
    error: d.error ? String(d.error) : null,
  };
}

export async function closeSosRequest(
  id: number,
  closedByUserId?: number | null,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await fetch(`/api/sos/requests/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      action: "close",
      role: "staff",
      closedByUserId: closedByUserId ?? null,
    }),
  });
  const d = (await r.json()) as { error?: string; ok?: boolean };
  if (!r.ok) return { ok: false, error: errMsg(d, `Close failed (${r.status})`) };
  return { ok: true, error: null };
}

export async function fetchSplashtopStatus(refresh = false): Promise<{
  ok: boolean;
  configured: boolean;
  authOk?: boolean;
  teamId?: string | null;
  message?: string;
  error?: string;
}> {
  const q = refresh ? "?refresh=1" : "";
  const r = await fetch(`/api/splashtop/status${q}`, {
    headers: { Accept: "application/json" },
  });
  return (await r.json()) as {
    ok: boolean;
    configured: boolean;
    authOk?: boolean;
    teamId?: string | null;
    message?: string;
    error?: string;
  };
}

export function formatSosTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}
