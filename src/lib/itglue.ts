/** Client helpers for IT Glue / MyGlue password vault */

export type ItGluePasswordListItem = {
  id: string;
  name: string;
  username: string | null;
  url: string | null;
  notes: string | null;
  organizationId: number | null;
  organizationName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  folderId: number | null;
  restricted: boolean;
  archived: boolean;
  updatedAt: string | null;
  createdAt: string | null;
  hasPassword?: boolean;
};

export type ItGluePasswordDetail = ItGluePasswordListItem & {
  password: string | null;
};

export type PasswordsListResponse = {
  passwords: ItGluePasswordListItem[];
  configured: boolean;
  mock?: boolean;
  organizationId?: number;
  organization?: { id: number; name: string | null };
  itglueUserId?: number | null;
  resolvedByEmail?: number | null;
  resolveNote?: string | null;
  unscopedStaff?: boolean;
  totalInOrg?: number;
  error?: string;
};

export type PasswordRevealResponse = {
  password?: ItGluePasswordDetail;
  configured?: boolean;
  mock?: boolean;
  error?: string;
  itglueUserId?: number | null;
};

export type ItGlueStatusResponse = {
  configured: boolean;
  ok: boolean;
  region?: string;
  organizationCount?: number | null;
  error?: string | null;
  hint?: string;
};

function formatErr(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; error?: unknown; detail?: unknown };
    if (typeof o.error === "string") return o.error;
    if (typeof o.message === "string") return o.message;
    if (typeof o.detail === "string") return o.detail;
  }
  return fallback;
}

export async function fetchItGlueStatus(): Promise<ItGlueStatusResponse> {
  try {
    const res = await fetch("/api/itglue/status", {
      headers: { Accept: "application/json" },
    });
    const data = (await res.json().catch(() => ({}))) as ItGlueStatusResponse;
    return {
      configured: Boolean(data.configured),
      ok: Boolean(data.ok),
      region: data.region,
      organizationCount: data.organizationCount ?? null,
      error: data.error ?? null,
      hint: data.hint,
    };
  } catch (e) {
    return {
      configured: false,
      ok: false,
      error: e instanceof Error ? e.message : "Failed to reach IT Glue status",
    };
  }
}

export async function fetchPasswords(opts: {
  organizationId: number | string;
  itglueUserId?: number | string | null;
  email?: string | null;
  role?: string | null;
  q?: string | null;
}): Promise<PasswordsListResponse> {
  const params = new URLSearchParams();
  params.set("organizationId", String(opts.organizationId));
  if (opts.itglueUserId != null && String(opts.itglueUserId).trim()) {
    params.set("itglueUserId", String(opts.itglueUserId));
  }
  if (opts.email) params.set("email", opts.email);
  if (opts.role) params.set("role", opts.role);
  if (opts.q?.trim()) params.set("q", opts.q.trim());

  const res = await fetch(`/api/itglue/passwords?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const data = (await res.json().catch(() => ({}))) as PasswordsListResponse & {
    error?: unknown;
  };
  const error =
    data.error != null
      ? formatErr(data.error, `Failed to load passwords (${res.status})`)
      : !res.ok
        ? `Failed to load passwords (${res.status})`
        : undefined;

  return {
    passwords: Array.isArray(data.passwords) ? data.passwords : [],
    configured: Boolean(data.configured),
    mock: data.mock,
    organizationId: data.organizationId,
    organization: data.organization,
    itglueUserId: data.itglueUserId ?? null,
    resolvedByEmail: data.resolvedByEmail ?? null,
    resolveNote: data.resolveNote ?? null,
    unscopedStaff: data.unscopedStaff,
    totalInOrg: data.totalInOrg,
    error,
  };
}

export async function revealPassword(opts: {
  id: string;
  organizationId: number | string;
  itglueUserId?: number | string | null;
  email?: string | null;
  role?: string | null;
}): Promise<PasswordRevealResponse> {
  const params = new URLSearchParams();
  params.set("organizationId", String(opts.organizationId));
  if (opts.itglueUserId != null && String(opts.itglueUserId).trim()) {
    params.set("itglueUserId", String(opts.itglueUserId));
  }
  if (opts.email) params.set("email", opts.email);
  if (opts.role) params.set("role", opts.role);

  const res = await fetch(
    `/api/itglue/passwords/${encodeURIComponent(opts.id)}?${params.toString()}`,
    { headers: { Accept: "application/json" } },
  );
  const data = (await res.json().catch(() => ({}))) as PasswordRevealResponse & {
    error?: unknown;
  };
  if (!res.ok) {
    return {
      error: formatErr(data.error, `Failed to reveal password (${res.status})`),
      configured: data.configured,
      mock: data.mock,
    };
  }
  return {
    password: data.password,
    configured: data.configured,
    mock: data.mock,
    itglueUserId: data.itglueUserId,
    error: data.error != null ? formatErr(data.error, "") : undefined,
  };
}

export type PasswordWritePayload = {
  name: string;
  password?: string;
  username?: string | null;
  url?: string | null;
  notes?: string | null;
  restricted?: boolean;
};

export type PasswordMutationResponse = {
  password?: ItGluePasswordDetail;
  configured?: boolean;
  mock?: boolean;
  deleted?: boolean;
  id?: string;
  error?: string;
};

function identityParams(opts: {
  organizationId: number | string;
  itglueUserId?: number | string | null;
  email?: string | null;
  role?: string | null;
}): URLSearchParams {
  const params = new URLSearchParams();
  params.set("organizationId", String(opts.organizationId));
  if (opts.itglueUserId != null && String(opts.itglueUserId).trim()) {
    params.set("itglueUserId", String(opts.itglueUserId));
  }
  if (opts.email) params.set("email", opts.email);
  if (opts.role) params.set("role", opts.role);
  return params;
}

export async function createPassword(opts: {
  organizationId: number | string;
  itglueUserId?: number | string | null;
  email?: string | null;
  role?: string | null;
  data: PasswordWritePayload;
}): Promise<PasswordMutationResponse> {
  const params = identityParams(opts);
  const res = await fetch(`/api/itglue/passwords?${params.toString()}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      organizationId: opts.organizationId,
      itglueUserId: opts.itglueUserId ?? undefined,
      email: opts.email ?? undefined,
      role: opts.role ?? undefined,
      name: opts.data.name,
      password: opts.data.password,
      username: opts.data.username ?? null,
      url: opts.data.url ?? null,
      notes: opts.data.notes ?? null,
      restricted: Boolean(opts.data.restricted),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as PasswordMutationResponse & {
    error?: unknown;
  };
  if (!res.ok) {
    return {
      error: formatErr(data.error, `Failed to create password (${res.status})`),
      configured: data.configured,
      mock: data.mock,
    };
  }
  return {
    password: data.password,
    configured: data.configured,
    mock: data.mock,
    error: data.error != null ? formatErr(data.error, "") : undefined,
  };
}

export async function updatePassword(opts: {
  id: string;
  organizationId: number | string;
  itglueUserId?: number | string | null;
  email?: string | null;
  role?: string | null;
  data: PasswordWritePayload;
}): Promise<PasswordMutationResponse> {
  const params = identityParams(opts);
  const res = await fetch(
    `/api/itglue/passwords/${encodeURIComponent(opts.id)}?${params.toString()}`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        organizationId: opts.organizationId,
        itglueUserId: opts.itglueUserId ?? undefined,
        email: opts.email ?? undefined,
        role: opts.role ?? undefined,
        name: opts.data.name,
        // Empty password = leave unchanged on the server
        password: opts.data.password ?? "",
        username: opts.data.username ?? null,
        url: opts.data.url ?? null,
        notes: opts.data.notes ?? null,
        restricted: Boolean(opts.data.restricted),
      }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as PasswordMutationResponse & {
    error?: unknown;
  };
  if (!res.ok) {
    return {
      error: formatErr(data.error, `Failed to update password (${res.status})`),
      configured: data.configured,
      mock: data.mock,
    };
  }
  return {
    password: data.password,
    configured: data.configured,
    mock: data.mock,
    error: data.error != null ? formatErr(data.error, "") : undefined,
  };
}

export async function deletePassword(opts: {
  id: string;
  organizationId: number | string;
  itglueUserId?: number | string | null;
  email?: string | null;
  role?: string | null;
}): Promise<PasswordMutationResponse> {
  const params = identityParams(opts);
  const res = await fetch(
    `/api/itglue/passwords/${encodeURIComponent(opts.id)}?${params.toString()}`,
    {
      method: "DELETE",
      headers: { Accept: "application/json" },
    },
  );
  const data = (await res.json().catch(() => ({}))) as PasswordMutationResponse & {
    error?: unknown;
  };
  if (!res.ok) {
    return {
      error: formatErr(data.error, `Failed to delete password (${res.status})`),
      configured: data.configured,
      mock: data.mock,
    };
  }
  return {
    deleted: true,
    id: data.id ?? opts.id,
    configured: data.configured,
    mock: data.mock,
  };
}
