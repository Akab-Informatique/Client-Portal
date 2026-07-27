import type {
  AutotaskTicket,
  AutotaskTicketNote,
  TicketDetailResponse,
} from "@/lib/types";

/**
 * Autotask (and some proxies) return errors as objects like
 * `{ code, id, message }` or arrays of those — never safe to render in React.
 * Always coerce API error payloads to a plain string.
 */
export function formatApiError(
  value: unknown,
  fallback = "Something went wrong",
): string {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return fallback;
    // Sometimes the server JSON.stringifies Autotask's errors array
    if (
      (t.startsWith("{") && t.endsWith("}")) ||
      (t.startsWith("[") && t.endsWith("]"))
    ) {
      try {
        return formatApiError(JSON.parse(t), t);
      } catch {
        return t;
      }
    }
    return t;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Error) {
    return value.message || fallback;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => formatApiError(item, ""))
      .filter(Boolean);
    return parts.length ? parts.join(" · ") : fallback;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Autotask REST: { code, id, message }
    if (typeof obj.message === "string" && obj.message.trim()) {
      const code =
        obj.code != null && String(obj.code).trim()
          ? ` (${String(obj.code)})`
          : "";
      return `${obj.message.trim()}${code}`;
    }
    if (typeof obj.error === "string" && obj.error.trim()) {
      return obj.error.trim();
    }
    if (obj.error != null && typeof obj.error === "object") {
      return formatApiError(obj.error, fallback);
    }
    if (obj.errors != null) {
      return formatApiError(obj.errors, fallback);
    }
    if (typeof obj.detail === "string" && obj.detail.trim()) {
      return obj.detail.trim();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export interface TicketsResponse {
  tickets: AutotaskTicket[];
  configured: boolean;
  mock?: boolean;
  companyId?: string | null;
  email?: string | null;
  scope?: "user" | "company" | string;
  contactMatched?: boolean;
  error?: string;
  statusLabels?: Record<string, string>;
  priorityLabels?: Record<string, string>;
}

export async function fetchOpenTickets(opts?: {
  companyId?: number | null;
  autotaskCompanyId?: string | null;
  /** Portal user email — required to scope tickets to that Autotask contact */
  email?: string | null;
  /** Default "user" = only this contact. Pass "company" for all company tickets. */
  scope?: "user" | "company";
}): Promise<TicketsResponse> {
  const params = new URLSearchParams();
  if (opts?.companyId != null) params.set("companyId", String(opts.companyId));
  if (opts?.autotaskCompanyId) {
    params.set("autotaskCompanyId", opts.autotaskCompanyId);
  }
  if (opts?.email) params.set("email", opts.email);
  if (opts?.scope) params.set("scope", opts.scope);

  const res = await fetch(`/api/autotask/tickets?${params.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const data = (await res.json().catch(() => ({}))) as TicketsResponse & {
    error?: string;
  };

  if (!res.ok) {
    return {
      tickets: [],
      configured: Boolean(data.configured),
      mock: data.mock,
      companyId: data.companyId,
      email: data.email,
      scope: data.scope,
      contactMatched: data.contactMatched,
      error: data.error || `Failed to load tickets (${res.status})`,
    };
  }

  return data;
}

export async function fetchTicketDetail(opts: {
  ticketId: number;
  autotaskCompanyId: string;
  email: string;
}): Promise<TicketDetailResponse & { error?: string }> {
  const params = new URLSearchParams({
    autotaskCompanyId: opts.autotaskCompanyId,
    email: opts.email,
  });
  const res = await fetch(
    `/api/autotask/tickets/${opts.ticketId}?${params.toString()}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  );
  const data = (await res.json().catch(() => ({}))) as TicketDetailResponse & {
    error?: string;
  };
  if (!res.ok) {
    return {
      ticket: data.ticket,
      notes: data.notes ?? [],
      configured: Boolean(data.configured),
      mock: data.mock,
      error: data.error || `Failed to load ticket (${res.status})`,
    };
  }
  return data;
}

export async function replyToTicket(opts: {
  ticketId: number;
  autotaskCompanyId: string;
  email: string;
  description: string;
  title?: string;
}): Promise<{
  ok: boolean;
  mock?: boolean;
  note?: AutotaskTicketNote;
  ticket?: AutotaskTicket;
  notes?: AutotaskTicketNote[];
  noteId?: number;
  error?: string;
  message?: string;
}> {
  const res = await fetch(`/api/autotask/tickets/${opts.ticketId}/notes`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description: opts.description,
      title: opts.title ?? "Client reply",
      email: opts.email,
      autotaskCompanyId: opts.autotaskCompanyId,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    mock?: boolean;
    note?: AutotaskTicketNote;
    ticket?: AutotaskTicket;
    notes?: AutotaskTicketNote[];
    noteId?: number;
    message?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      mock: data.mock,
      error: data.error || `Failed to post reply (${res.status})`,
    };
  }
  return { ok: true, ...data };
}

export async function closeTicket(opts: {
  ticketId: number;
  autotaskCompanyId: string;
  email: string;
  resolution?: string;
}): Promise<{
  ok: boolean;
  mock?: boolean;
  ticket?: AutotaskTicket;
  notes?: AutotaskTicketNote[];
  error?: string;
  message?: string;
}> {
  const res = await fetch(`/api/autotask/tickets/${opts.ticketId}/close`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      resolution: opts.resolution,
      email: opts.email,
      autotaskCompanyId: opts.autotaskCompanyId,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    mock?: boolean;
    ticket?: AutotaskTicket;
    notes?: AutotaskTicketNote[];
    message?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      mock: data.mock,
      ticket: data.ticket,
      error: data.error || `Failed to close ticket (${res.status})`,
    };
  }
  return { ok: true, ...data };
}
