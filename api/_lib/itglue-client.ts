/**
 * IT Glue / MyGlue REST API helper (server-only).
 *
 * Auth: x-api-key header (account API key).
 * Password values require the key’s “Password Access” option enabled.
 *
 * Docs: https://api.itglue.com/developer/
 *
 * Per-user visibility (portal simulation of MyGlue):
 * - Non-restricted passwords in the user’s organization → visible
 * - Restricted passwords → only if the linked IT Glue / MyGlue user
 *   appears in authorized_users (or user_resource_accesses)
 */

export type ItGlueRegion = "us" | "eu" | "au";

export type ItGlueConfig = {
  apiKey: string;
  region: ItGlueRegion;
  baseUrl: string;
};

export type ItGluePassword = {
  id: string;
  name: string;
  username: string | null;
  /** Only present when show_password was requested and key has Password Access */
  password: string | null;
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
  /** IT Glue / MyGlue user ids allowed when restricted */
  authorizedUserIds: number[];
};

export type ItGlueUser = {
  id: number;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  roleName: string | null;
  myGlue: boolean;
};

export type ItGlueOrganization = {
  id: number;
  name: string;
  shortName: string | null;
};

const REGION_BASE: Record<ItGlueRegion, string> = {
  us: "https://api.itglue.com",
  eu: "https://api.eu.itglue.com",
  au: "https://api.au.itglue.com",
};

function cleanEnv(value: string | undefined): string {
  if (!value) return "";
  let v = value.trim();
  if (v.charCodeAt(0) === 0xfeff) v = v.slice(1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

export function getItGlueConfigFromEnv(): ItGlueConfig | null {
  const apiKey = cleanEnv(process.env.ITGLUE_API_KEY);
  if (!apiKey) return null;
  const regionRaw = cleanEnv(process.env.ITGLUE_REGION).toLowerCase() || "us";
  const region: ItGlueRegion =
    regionRaw === "eu" || regionRaw === "au" ? regionRaw : "us";
  return {
    apiKey,
    region,
    baseUrl: REGION_BASE[region],
  };
}

export function isItGlueConfigured(): boolean {
  return getItGlueConfigFromEnv() != null;
}

type JsonApiResource = {
  id?: string | number;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    { data?: { id?: string | number; type?: string } | Array<{ id?: string | number }> | null }
  >;
};

type JsonApiList = {
  data?: JsonApiResource[] | JsonApiResource | null;
  included?: JsonApiResource[];
  meta?: { "total-count"?: number; "total-pages"?: number };
  errors?: Array<{ title?: string; detail?: string; code?: string }>;
};

function attr(obj: JsonApiResource | null | undefined, key: string): unknown {
  if (!obj?.attributes) return undefined;
  // IT Glue uses kebab-case in attributes
  if (key in obj.attributes) return obj.attributes[key];
  const kebab = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  if (kebab in obj.attributes) return obj.attributes[kebab];
  return undefined;
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function asNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

export async function itglueFetch(
  path: string,
  init?: RequestInit & { query?: Record<string, string | number | boolean | undefined | null> },
): Promise<{ ok: boolean; status: number; data: JsonApiList; raw: string }> {
  const cfg = getItGlueConfigFromEnv();
  if (!cfg) {
    throw new Error(
      "IT Glue is not configured. Add ITGLUE_API_KEY (with Password Access) in app secrets.",
    );
  }

  const url = new URL(
    path.startsWith("http")
      ? path
      : `${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`,
  );
  if (init?.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }

  const { query: _q, ...rest } = init || {};
  const res = await fetch(url.toString(), {
    ...rest,
    headers: {
      "x-api-key": cfg.apiKey,
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
      ...(rest.headers as Record<string, string> | undefined),
    },
  });

  const raw = await res.text();
  let data: JsonApiList = {};
  try {
    data = raw ? (JSON.parse(raw) as JsonApiList) : {};
  } catch {
    data = { errors: [{ detail: raw.slice(0, 300) }] };
  }

  return { ok: res.ok, status: res.status, data, raw };
}

export function formatItGlueError(
  data: JsonApiList,
  status: number,
  fallback = "IT Glue request failed",
): string {
  const errs = data.errors;
  if (Array.isArray(errs) && errs.length) {
    return errs
      .map((e) => e.detail || e.title || e.code)
      .filter(Boolean)
      .join(" · ");
  }
  if (status === 401 || status === 403) {
    return "IT Glue rejected the API key (401/403). Check ITGLUE_API_KEY and that Password Access is enabled.";
  }
  if (status === 429) {
    return "IT Glue rate limit exceeded. Try again in a few minutes.";
  }
  return `${fallback} (HTTP ${status})`;
}

function extractAuthorizedUserIds(
  resource: JsonApiResource,
  included?: JsonApiResource[],
): number[] {
  const ids = new Set<number>();

  // relationships.authorized_users.data
  const rel = resource.relationships?.authorized_users?.data;
  if (Array.isArray(rel)) {
    for (const r of rel) {
      const n = asNumber(r.id);
      if (n != null) ids.add(n);
    }
  } else if (rel && typeof rel === "object" && "id" in rel) {
    const n = asNumber((rel as { id?: string | number }).id);
    if (n != null) ids.add(n);
  }

  // Some tenants expose authorized user ids on attributes
  const attrIds =
    attr(resource, "authorized-user-ids") ??
    attr(resource, "authorized_user_ids");
  if (Array.isArray(attrIds)) {
    for (const x of attrIds) {
      const n = asNumber(x);
      if (n != null) ids.add(n);
    }
  }

  // included user_resource_accesses pointing at this password
  if (included?.length) {
    const pwdId = String(resource.id);
    for (const inc of included) {
      const t = (inc.type || "").toLowerCase();
      if (
        t.includes("user_resource_access") ||
        t.includes("resource_access")
      ) {
        const resourceId = asString(
          attr(inc, "resource-id") ?? attr(inc, "resource_id"),
        );
        const resourceType = asString(
          attr(inc, "resource-type") ?? attr(inc, "resource_type"),
        );
        const userId = asNumber(
          attr(inc, "user-id") ?? attr(inc, "user_id"),
        );
        if (
          userId != null &&
          resourceId === pwdId &&
          (!resourceType || /password/i.test(resourceType))
        ) {
          ids.add(userId);
        }
      }
      // authorized_users included as users with relationship back — also accept bare users listed under include when relationship matched above
    }
  }

  return [...ids];
}

export function mapPasswordResource(
  resource: JsonApiResource,
  included?: JsonApiResource[],
): ItGluePassword {
  return {
    id: String(resource.id),
    name: asString(attr(resource, "name")) || `Password #${resource.id}`,
    username: asString(attr(resource, "username")),
    password: asString(attr(resource, "password")),
    url: asString(attr(resource, "url")),
    notes: asString(attr(resource, "notes")),
    organizationId: asNumber(
      attr(resource, "organization-id") ?? attr(resource, "organization_id"),
    ),
    organizationName: asString(
      attr(resource, "organization-name") ??
        attr(resource, "organization_name"),
    ),
    categoryId: asNumber(
      attr(resource, "password-category-id") ??
        attr(resource, "password_category_id"),
    ),
    categoryName: asString(
      attr(resource, "password-category-name") ??
        attr(resource, "password_category_name"),
    ),
    folderId: asNumber(
      attr(resource, "password-folder-id") ??
        attr(resource, "password_folder_id"),
    ),
    restricted: asBool(attr(resource, "restricted")),
    archived: asBool(attr(resource, "archived")),
    updatedAt: asString(
      attr(resource, "updated-at") ?? attr(resource, "updated_at"),
    ),
    createdAt: asString(
      attr(resource, "created-at") ?? attr(resource, "created_at"),
    ),
    authorizedUserIds: extractAuthorizedUserIds(resource, included),
  };
}

/**
 * Whether this IT Glue / MyGlue user may see the password, matching MyGlue rules:
 * unrestricted org passwords are visible; restricted ones need explicit authorization.
 */
export function userCanAccessPassword(
  password: ItGluePassword,
  opts: {
    itglueUserId: number | null;
    organizationId: number | null;
    /** Staff with no linked user may use full API-key view */
    allowUnscopedStaff?: boolean;
  },
): boolean {
  if (password.archived) return false;

  if (
    opts.organizationId != null &&
    password.organizationId != null &&
    password.organizationId !== opts.organizationId
  ) {
    return false;
  }

  if (!password.restricted) {
    // Org-visible (MyGlue org members)
    return true;
  }

  // Restricted: must be explicitly authorized
  if (opts.itglueUserId == null) {
    return Boolean(opts.allowUnscopedStaff);
  }
  return password.authorizedUserIds.includes(opts.itglueUserId);
}

export async function listPasswordsForOrganization(opts: {
  organizationId: number;
  pageSize?: number;
  maxPages?: number;
  search?: string | null;
  includeArchived?: boolean;
}): Promise<ItGluePassword[]> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 1000);
  const maxPages = opts.maxPages ?? 20;
  const out: ItGluePassword[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const query: Record<string, string | number | boolean> = {
      "page[number]": page,
      "page[size]": pageSize,
      "filter[organization_id]": opts.organizationId,
      sort: "name",
      include: "authorized_users",
    };
    if (!opts.includeArchived) {
      query["filter[archived]"] = "false";
    }
    // Name filter when searching (IT Glue supports filter[name])
    if (opts.search?.trim()) {
      query["filter[name]"] = opts.search.trim();
    }

    const res = await itglueFetch("/passwords", { query });
    if (!res.ok) {
      throw new Error(formatItGlueError(res.data, res.status, "Failed to list passwords"));
    }

    const rows = Array.isArray(res.data.data)
      ? res.data.data
      : res.data.data
        ? [res.data.data]
        : [];
    for (const r of rows) {
      out.push(mapPasswordResource(r, res.data.included));
    }

    if (rows.length < pageSize) break;
    const totalPages = res.data.meta?.["total-pages"];
    if (totalPages != null && page >= totalPages) break;
  }

  return out;
}

export async function getPasswordById(
  id: string,
  opts?: { showPassword?: boolean },
): Promise<ItGluePassword | null> {
  const res = await itglueFetch(`/passwords/${encodeURIComponent(id)}`, {
    query: {
      "show_password": opts?.showPassword === false ? "false" : "true",
      include: "authorized_users",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(formatItGlueError(res.data, res.status, "Failed to load password"));
  }
  const row = Array.isArray(res.data.data) ? res.data.data[0] : res.data.data;
  if (!row) return null;
  return mapPasswordResource(row, res.data.included);
}

export async function findUsersByEmail(email: string): Promise<ItGlueUser[]> {
  const q = email.trim().toLowerCase();
  if (!q) return [];
  const res = await itglueFetch("/users", {
    query: {
      "filter[email]": q,
      "page[size]": 10,
    },
  });
  if (!res.ok) {
    // Some accounts use filter differently — try list + client filter
    const res2 = await itglueFetch("/users", {
      query: { "page[size]": 100, "page[number]": 1 },
    });
    if (!res2.ok) {
      throw new Error(formatItGlueError(res.data, res.status, "Failed to look up users"));
    }
    const rows = Array.isArray(res2.data.data) ? res2.data.data : [];
    return rows
      .map(mapUserResource)
      .filter((u) => (u.email || "").toLowerCase() === q);
  }
  const rows = Array.isArray(res.data.data) ? res.data.data : [];
  return rows.map(mapUserResource);
}

function mapUserResource(resource: JsonApiResource): ItGlueUser {
  return {
    id: Number(resource.id),
    email: asString(attr(resource, "email") ?? attr(resource, "email-address")),
    firstName: asString(
      attr(resource, "first-name") ?? attr(resource, "first_name"),
    ),
    lastName: asString(
      attr(resource, "last-name") ?? attr(resource, "last_name"),
    ),
    roleName: asString(attr(resource, "role-name") ?? attr(resource, "role_name")),
    myGlue: asBool(
      attr(resource, "my-glue") ??
        attr(resource, "my_glue") ??
        attr(resource, "myglue"),
    ),
  };
}

export async function getOrganization(
  id: number,
): Promise<ItGlueOrganization | null> {
  const res = await itglueFetch(`/organizations/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(formatItGlueError(res.data, res.status, "Failed to load organization"));
  }
  const row = Array.isArray(res.data.data) ? res.data.data[0] : res.data.data;
  if (!row) return null;
  return {
    id: Number(row.id),
    name: asString(attr(row, "name")) || `Organization #${row.id}`,
    shortName: asString(
      attr(row, "short-name") ?? attr(row, "short_name"),
    ),
  };
}

export async function testItGlueConnection(): Promise<{
  ok: boolean;
  region: ItGlueRegion;
  error?: string;
  sampleOrgCount?: number;
}> {
  const cfg = getItGlueConfigFromEnv();
  if (!cfg) {
    return { ok: false, region: "us", error: "ITGLUE_API_KEY is not set" };
  }
  try {
    const res = await itglueFetch("/organizations", {
      query: { "page[size]": 1 },
    });
    if (!res.ok) {
      return {
        ok: false,
        region: cfg.region,
        error: formatItGlueError(res.data, res.status),
      };
    }
    const rows = Array.isArray(res.data.data) ? res.data.data : [];
    return {
      ok: true,
      region: cfg.region,
      sampleOrgCount: res.data.meta?.["total-count"] ?? rows.length,
    };
  } catch (e) {
    return {
      ok: false,
      region: cfg.region,
      error: e instanceof Error ? e.message : "Connection failed",
    };
  }
}

export type PasswordWriteInput = {
  name: string;
  password?: string | null;
  username?: string | null;
  url?: string | null;
  notes?: string | null;
  restricted?: boolean;
  passwordCategoryId?: number | null;
  organizationId: number;
};

/** Create a password in an organization (JSON:API). */
export async function createPassword(
  input: PasswordWriteInput,
): Promise<ItGluePassword> {
  const name = input.name.trim();
  const secret = (input.password ?? "").trim();
  if (!name) throw new Error("Name is required.");
  if (!secret) throw new Error("Password value is required.");
  if (!Number.isFinite(input.organizationId) || input.organizationId <= 0) {
    throw new Error("Valid organization ID is required.");
  }

  const attributes: Record<string, unknown> = {
    name,
    password: secret,
    "organization-id": input.organizationId,
  };
  if (input.username != null) attributes.username = String(input.username);
  if (input.url != null) attributes.url = String(input.url);
  if (input.notes != null) attributes.notes = String(input.notes);
  if (input.restricted != null) attributes.restricted = Boolean(input.restricted);
  if (
    input.passwordCategoryId != null &&
    Number.isFinite(input.passwordCategoryId) &&
    input.passwordCategoryId > 0
  ) {
    attributes["password-category-id"] = input.passwordCategoryId;
  }

  const res = await itglueFetch(
    `/organizations/${input.organizationId}/relationships/passwords`,
    {
      method: "POST",
      query: { show_password: "true" },
      body: JSON.stringify({
        data: {
          type: "passwords",
          attributes,
        },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(formatItGlueError(res.data, res.status, "Failed to create password"));
  }

  const row = Array.isArray(res.data.data) ? res.data.data[0] : res.data.data;
  if (!row) throw new Error("IT Glue did not return the created password.");
  return mapPasswordResource(row, res.data.included);
}

/** Update an existing password (partial PATCH). */
export async function updatePassword(
  id: string,
  input: Partial<Omit<PasswordWriteInput, "organizationId">> & {
    organizationId?: number;
  },
): Promise<ItGluePassword> {
  const passwordId = String(id || "").trim();
  if (!passwordId) throw new Error("Password id is required.");

  const attributes: Record<string, unknown> = {};
  if (input.name != null) {
    const name = String(input.name).trim();
    if (!name) throw new Error("Name cannot be empty.");
    attributes.name = name;
  }
  if (input.password != null && String(input.password).length > 0) {
    attributes.password = String(input.password);
  }
  if (input.username !== undefined) {
    attributes.username = input.username == null ? "" : String(input.username);
  }
  if (input.url !== undefined) {
    attributes.url = input.url == null ? "" : String(input.url);
  }
  if (input.notes !== undefined) {
    attributes.notes = input.notes == null ? "" : String(input.notes);
  }
  if (input.restricted != null) {
    attributes.restricted = Boolean(input.restricted);
  }
  if (input.passwordCategoryId !== undefined) {
    if (
      input.passwordCategoryId != null &&
      Number.isFinite(input.passwordCategoryId) &&
      input.passwordCategoryId > 0
    ) {
      attributes["password-category-id"] = input.passwordCategoryId;
    }
  }

  if (Object.keys(attributes).length === 0) {
    throw new Error("No fields to update.");
  }

  const path =
    input.organizationId != null && input.organizationId > 0
      ? `/organizations/${input.organizationId}/relationships/passwords/${encodeURIComponent(passwordId)}`
      : `/passwords/${encodeURIComponent(passwordId)}`;

  const res = await itglueFetch(path, {
    method: "PATCH",
    query: { show_password: "true" },
    body: JSON.stringify({
      data: {
        type: "passwords",
        attributes,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(formatItGlueError(res.data, res.status, "Failed to update password"));
  }

  const row = Array.isArray(res.data.data) ? res.data.data[0] : res.data.data;
  if (!row) {
    // Some tenants return 200/204 with empty body — re-fetch
    const refreshed = await getPasswordById(passwordId, { showPassword: true });
    if (!refreshed) throw new Error("Password updated but could not be reloaded.");
    return refreshed;
  }
  return mapPasswordResource(row, res.data.included);
}

/** Delete a password by id. */
export async function deletePassword(
  id: string,
  organizationId?: number | null,
): Promise<void> {
  const passwordId = String(id || "").trim();
  if (!passwordId) throw new Error("Password id is required.");

  const path =
    organizationId != null && organizationId > 0
      ? `/organizations/${organizationId}/relationships/passwords/${encodeURIComponent(passwordId)}`
      : `/passwords/${encodeURIComponent(passwordId)}`;

  const res = await itglueFetch(path, { method: "DELETE" });
  // 204 No Content is success; 200 also accepted
  if (res.status === 204 || res.ok) return;
  if (res.status === 404) throw new Error("Password not found in IT Glue.");
  throw new Error(formatItGlueError(res.data, res.status, "Failed to delete password"));
}

// ── Demo / offline mock vault (mutable in-process store) ───────────────────

type MockStore = Map<number, ItGluePassword[]>;

const globalMock = globalThis as typeof globalThis & {
  __itglueMockPasswords?: MockStore;
};

function mockStore(): MockStore {
  if (!globalMock.__itglueMockPasswords) {
    globalMock.__itglueMockPasswords = new Map();
  }
  return globalMock.__itglueMockPasswords;
}

function seedMockOrg(organizationId: number, itglueUserId: number | null): ItGluePassword[] {
  const store = mockStore();
  const existing = store.get(organizationId);
  if (existing) {
    // Keep restricted demo entry authorized for current linked user when possible
    return existing.map((p) => {
      if (p.id === "mock-2" && p.restricted && itglueUserId != null) {
        if (!p.authorizedUserIds.includes(itglueUserId)) {
          return {
            ...p,
            authorizedUserIds: [...p.authorizedUserIds, itglueUserId],
          };
        }
      }
      return p;
    });
  }

  const seeded: ItGluePassword[] = [
    {
      id: "mock-1",
      name: "Microsoft 365 Admin",
      username: "admin@client.example",
      password: "Demo-M365-Password!",
      url: "https://admin.microsoft.com",
      notes: "Demo credential — replace with live IT Glue data.",
      organizationId,
      organizationName: "Demo Organization",
      categoryId: 1,
      categoryName: "Cloud",
      folderId: null,
      restricted: false,
      archived: false,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      authorizedUserIds: [],
    },
    {
      id: "mock-2",
      name: "Firewall admin",
      username: "fwadmin",
      password: "Demo-FW-Password!",
      url: "https://192.168.1.1",
      notes: "Restricted demo password — only linked MyGlue users see this.",
      organizationId,
      organizationName: "Demo Organization",
      categoryId: 2,
      categoryName: "Network",
      folderId: null,
      restricted: true,
      archived: false,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      authorizedUserIds: itglueUserId != null ? [itglueUserId] : [9001],
    },
    {
      id: "mock-3",
      name: "VPN shared",
      username: "vpn-user",
      password: "Demo-VPN-Password!",
      url: null,
      notes: null,
      organizationId,
      organizationName: "Demo Organization",
      categoryId: 2,
      categoryName: "Network",
      folderId: null,
      restricted: false,
      archived: false,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      authorizedUserIds: [],
    },
  ];
  store.set(organizationId, seeded);
  return seeded;
}

/** Demo passwords when API key is missing (sandbox / offline). */
export function mockPasswordsForOrg(
  organizationId: number,
  itglueUserId: number | null,
): ItGluePassword[] {
  const all = seedMockOrg(organizationId, itglueUserId);
  // Persist any authorized-user tweak back
  mockStore().set(organizationId, all);
  return all.filter((p) =>
    userCanAccessPassword(p, {
      itglueUserId,
      organizationId,
      allowUnscopedStaff: itglueUserId == null,
    }),
  );
}

export function mockCreatePassword(
  input: PasswordWriteInput,
  itglueUserId: number | null,
): ItGluePassword {
  const name = input.name.trim();
  const secret = (input.password ?? "").trim();
  if (!name) throw new Error("Name is required.");
  if (!secret) throw new Error("Password value is required.");

  const list = seedMockOrg(input.organizationId, itglueUserId);
  const now = new Date().toISOString();
  const created: ItGluePassword = {
    id: `mock-${Date.now()}`,
    name,
    username: input.username?.trim() || null,
    password: secret,
    url: input.url?.trim() || null,
    notes: input.notes?.trim() || null,
    organizationId: input.organizationId,
    organizationName: "Demo Organization",
    categoryId: input.passwordCategoryId ?? null,
    categoryName: null,
    folderId: null,
    restricted: Boolean(input.restricted),
    archived: false,
    updatedAt: now,
    createdAt: now,
    authorizedUserIds:
      input.restricted && itglueUserId != null ? [itglueUserId] : [],
  };
  list.push(created);
  mockStore().set(input.organizationId, list);
  return created;
}

export function mockUpdatePassword(
  id: string,
  organizationId: number,
  input: Partial<Omit<PasswordWriteInput, "organizationId">>,
  itglueUserId: number | null,
): ItGluePassword {
  const list = seedMockOrg(organizationId, itglueUserId);
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error("Password not found (demo).");
  const current = list[idx];
  const next: ItGluePassword = {
    ...current,
    name: input.name != null ? String(input.name).trim() || current.name : current.name,
    username:
      input.username !== undefined
        ? input.username?.trim() || null
        : current.username,
    password:
      input.password != null && String(input.password).length > 0
        ? String(input.password)
        : current.password,
    url: input.url !== undefined ? input.url?.trim() || null : current.url,
    notes:
      input.notes !== undefined ? input.notes?.trim() || null : current.notes,
    restricted:
      input.restricted != null ? Boolean(input.restricted) : current.restricted,
    updatedAt: new Date().toISOString(),
  };
  list[idx] = next;
  mockStore().set(organizationId, list);
  return next;
}

export function mockDeletePassword(
  id: string,
  organizationId: number,
  itglueUserId: number | null,
): void {
  const list = seedMockOrg(organizationId, itglueUserId);
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) throw new Error("Password not found (demo).");
  mockStore().set(organizationId, next);
}
