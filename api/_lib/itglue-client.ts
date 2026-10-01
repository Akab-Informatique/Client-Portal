/**
 * IT Glue / MyGlue REST API helper (server-only).
 *
 * Auth: x-api-key header (account API key).
 * Password values require the key’s “Password Access” option enabled.
 *
 * Docs: https://api.itglue.com/developer/
 *
 * Per-user visibility (portal simulation of MyGlue):
 *
 * Clients (role=client) with a linked MyGlue user id:
 *   ONLY passwords that MyGlue would allow for that person —
 *   explicit user/group resource accesses (restricted shares).
 *   They never get the full org vault from the API key.
 *
 * Staff with a linked IT Glue user id:
 *   unrestricted org passwords + restricted ones they are authorized for.
 *
 * Staff with NO linked user id:
 *   full API-key view of the organization (unscoped ops mode).
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
  /** True when password originated / is flagged as MyGlue */
  myGlue: boolean;
  updatedAt: string | null;
  createdAt: string | null;
  /** Explicit user accessors (authorized_users / user_resource_accesses) */
  authorizedUserIds: number[];
  /** Explicit group accessors (group_resource_accesses) */
  authorizedGroupIds: number[];
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

function pushRelIds(
  ids: Set<number>,
  rel: unknown,
): void {
  if (Array.isArray(rel)) {
    for (const r of rel) {
      if (r && typeof r === "object" && "id" in r) {
        const n = asNumber((r as { id?: string | number }).id);
        if (n != null) ids.add(n);
      }
    }
  } else if (rel && typeof rel === "object" && "id" in rel) {
    const n = asNumber((rel as { id?: string | number }).id);
    if (n != null) ids.add(n);
  }
}

function extractAccessors(
  resource: JsonApiResource,
  included?: JsonApiResource[],
): { userIds: number[]; groupIds: number[] } {
  const userIds = new Set<number>();
  const groupIds = new Set<number>();
  const pwdId = String(resource.id);

  // relationships.authorized_users (single-password GET)
  pushRelIds(userIds, resource.relationships?.authorized_users?.data);

  // relationships.user_resource_accesses / group_resource_accesses (list include)
  const uraRel = resource.relationships?.user_resource_accesses?.data;
  const graRel = resource.relationships?.group_resource_accesses?.data;
  const uraIds = new Set<string>();
  const graIds = new Set<string>();
  if (Array.isArray(uraRel)) {
    for (const r of uraRel) if (r?.id != null) uraIds.add(String(r.id));
  } else if (uraRel && typeof uraRel === "object" && "id" in uraRel) {
    uraIds.add(String((uraRel as { id: string | number }).id));
  }
  if (Array.isArray(graRel)) {
    for (const r of graRel) if (r?.id != null) graIds.add(String(r.id));
  } else if (graRel && typeof graRel === "object" && "id" in graRel) {
    graIds.add(String((graRel as { id: string | number }).id));
  }

  // Attribute fallbacks
  const attrUserIds =
    attr(resource, "authorized-user-ids") ??
    attr(resource, "authorized_user_ids");
  if (Array.isArray(attrUserIds)) {
    for (const x of attrUserIds) {
      const n = asNumber(x);
      if (n != null) userIds.add(n);
    }
  }

  if (included?.length) {
    for (const inc of included) {
      const t = (inc.type || "").toLowerCase().replace(/-/g, "_");
      const incId = inc.id != null ? String(inc.id) : "";

      // Embedded authorized users
      if (t === "users" || t === "user") {
        // only count when linked via authorized_users relationship
        const auth = resource.relationships?.authorized_users?.data;
        const authIds = new Set<string>();
        if (Array.isArray(auth)) {
          for (const r of auth) if (r?.id != null) authIds.add(String(r.id));
        } else if (auth && typeof auth === "object" && "id" in auth) {
          authIds.add(String((auth as { id: string | number }).id));
        }
        if (authIds.has(incId)) {
          const n = asNumber(inc.id);
          if (n != null) userIds.add(n);
        }
      }

      const isUserAccess =
        t.includes("user_resource_access") ||
        (t.includes("resource_access") && !t.includes("group"));
      const isGroupAccess = t.includes("group_resource_access");

      if (!isUserAccess && !isGroupAccess) continue;

      // Prefer matching via relationship id list; also match resource-id attrs
      const linkedByRel =
        (isUserAccess && uraIds.has(incId)) ||
        (isGroupAccess && graIds.has(incId));

      const resourceId = asString(
        attr(inc, "resource-id") ??
          attr(inc, "resource_id") ??
          attr(inc, "resourceable-id") ??
          attr(inc, "resourceable_id"),
      );
      const resourceType = asString(
        attr(inc, "resource-type") ??
          attr(inc, "resource_type") ??
          attr(inc, "resourceable-type") ??
          attr(inc, "resourceable_type"),
      );
      const matchesResource =
        linkedByRel ||
        (resourceId === pwdId &&
          (!resourceType || /password/i.test(resourceType)));

      if (!matchesResource) continue;

      // accessor-id / user-id / group-id
      const accessorType = asString(
        attr(inc, "accessor-type") ?? attr(inc, "accessor_type"),
      );
      const accessorId = asNumber(
        attr(inc, "accessor-id") ?? attr(inc, "accessor_id"),
      );
      const userId = asNumber(
        attr(inc, "user-id") ??
          attr(inc, "user_id") ??
          (accessorType && /user/i.test(accessorType) ? accessorId : null),
      );
      const groupId = asNumber(
        attr(inc, "group-id") ??
          attr(inc, "group_id") ??
          (accessorType && /group/i.test(accessorType) ? accessorId : null),
      );

      // relationship accessor
      const accRel = inc.relationships?.accessor?.data;
      if (accRel && typeof accRel === "object" && !Array.isArray(accRel)) {
        const a = accRel as { id?: string | number; type?: string };
        const n = asNumber(a.id);
        const at = (a.type || "").toLowerCase();
        if (n != null) {
          if (at.includes("group")) groupIds.add(n);
          else userIds.add(n);
        }
      }

      if (isUserAccess && userId != null) userIds.add(userId);
      if (isGroupAccess && groupId != null) groupIds.add(groupId);
      // If type says user access but only accessorId present
      if (isUserAccess && userId == null && accessorId != null && !accessorType) {
        userIds.add(accessorId);
      }
      if (isGroupAccess && groupId == null && accessorId != null && !accessorType) {
        groupIds.add(accessorId);
      }
    }
  }

  return { userIds: [...userIds], groupIds: [...groupIds] };
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
    myGlue: asBool(
      attr(resource, "my-glue") ??
        attr(resource, "my_glue") ??
        attr(resource, "myglue"),
    ),
    updatedAt: asString(
      attr(resource, "updated-at") ?? attr(resource, "updated_at"),
    ),
    createdAt: asString(
      attr(resource, "created-at") ?? attr(resource, "created_at"),
    ),
    ...(() => {
      const a = extractAccessors(resource, included);
      return {
        authorizedUserIds: a.userIds,
        authorizedGroupIds: a.groupIds,
      };
    })(),
  };
}

export type PasswordAccessScope = "myglue" | "staff_org" | "unscoped";

/**
 * Whether this person may see the password.
 *
 * scope:
 * - myglue   → client portal: ONLY passwords explicitly shared with this
 *              MyGlue user (or one of their groups). Never the full org vault.
 * - staff_org → staff with linked IT Glue user: unrestricted org passwords
 *              + restricted ones they are authorized for.
 * - unscoped → staff with no linked user: full API-key org view
 *              (restricted still requires auth list when present; if the API
 *              returns no accessors, restricted items stay hidden).
 */
export function userCanAccessPassword(
  password: ItGluePassword,
  opts: {
    itglueUserId: number | null;
    organizationId: number | null;
    /** @deprecated use scope */
    allowUnscopedStaff?: boolean;
    scope?: PasswordAccessScope;
    /** Group ids the MyGlue / IT Glue user belongs to */
    groupIds?: number[] | null;
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

  const scope: PasswordAccessScope =
    opts.scope ??
    (opts.allowUnscopedStaff
      ? "unscoped"
      : opts.itglueUserId != null
        ? "staff_org"
        : "myglue");

  const uid = opts.itglueUserId;
  const groups = opts.groupIds ?? [];

  const userExplicit =
    uid != null && password.authorizedUserIds.includes(uid);
  const groupExplicit =
    groups.length > 0 &&
    password.authorizedGroupIds.some((g) => groups.includes(g));
  const explicitlyShared = userExplicit || groupExplicit;

  // ---- Client / MyGlue-strict: only what is shared with this account ----
  if (scope === "myglue") {
    if (uid == null) return false;
    // Must be on the access list (user or group). Unrestricted org-wide
    // passwords from the API key are NOT shown to clients.
    return explicitlyShared;
  }

  // ---- Unscoped staff (API key ops view) ----
  if (scope === "unscoped") {
    if (!password.restricted) return true;
    // Restricted: only if we know accessors and... staff unscoped still should
    // not leak private restricted items without being on the list.
    // When accessor list is empty (API didn't return shares), hide it.
    if (password.authorizedUserIds.length === 0 &&
        password.authorizedGroupIds.length === 0) {
      return false;
    }
    // Unscoped staff still shouldn't open every restricted password.
    return false;
  }

  // ---- Staff with linked IT Glue user (staff_org) ----
  if (uid == null) return false;
  if (!password.restricted) {
    // Unrestricted org password — visible to staff working the tenant
    return true;
  }
  return explicitlyShared;
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
      include: "user_resource_accesses,group_resource_accesses",
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
      include: "authorized_users,user_resource_accesses,group_resource_accesses",
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

export async function getUserGroupIds(userId: number): Promise<number[]> {
  if (!userId || !Number.isFinite(userId)) return [];
  try {
    // Preferred: user resource with groups included
    const res = await itglueFetch(`/users/${userId}`, {
      query: { include: "groups" },
    });
    if (res.ok) {
      const row = Array.isArray(res.data.data) ? res.data.data[0] : res.data.data;
      const ids = new Set<number>();
      if (row) {
        pushRelIds(ids, row.relationships?.groups?.data);
      }
      if (res.data.included?.length) {
        for (const inc of res.data.included) {
          const t = (inc.type || "").toLowerCase();
          if (t.includes("group")) {
            const n = asNumber(inc.id);
            if (n != null) ids.add(n);
          }
        }
      }
      if (ids.size) return [...ids];
    }
  } catch {
    /* fall through */
  }
  try {
    // Fallback: some tenants expose memberships under a nested path
    const res2 = await itglueFetch(
      `/users/${userId}/relationships/groups`,
      { query: { "page[size]": 100 } },
    );
    if (res2.ok) {
      const rows = Array.isArray(res2.data.data) ? res2.data.data : [];
      return rows
        .map((r) => asNumber(r.id))
        .filter((n): n is number => n != null);
    }
  } catch {
    /* ignore */
  }
  return [];
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
            authorizedGroupIds: [],
            myGlue: false,
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
      notes: "Unrestricted org password — staff only in portal (clients need explicit share).",
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
      authorizedGroupIds: [],
      myGlue: true,
    },
    {
      id: "mock-2",
      name: "Firewall admin",
      username: "fwadmin",
      password: "Demo-FW-Password!",
      url: "https://192.168.1.1",
      notes: "Explicitly shared with the linked MyGlue user — clients can see this.",
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
      authorizedGroupIds: [],
      myGlue: false,
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
      authorizedGroupIds: [],
      myGlue: false,
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
      scope: itglueUserId == null ? "unscoped" : "myglue",
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
    // Creator is always authorized so MyGlue-scope clients see passwords they add
    authorizedUserIds: itglueUserId != null ? [itglueUserId] : [],
    authorizedGroupIds: [],
    myGlue: true,
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
