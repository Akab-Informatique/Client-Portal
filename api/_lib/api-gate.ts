/**
 * Central auth gate for /api/* integration routes.
 *
 * Runs BEFORE every handler (server/prod-server.mjs and the Vite dev middleware).
 * Handlers were written to read identity (role, email, companyId, itglueUserId,
 * autotaskCompanyId, siteUid, siteUrl …) from the request. This gate makes those
 * values trustworthy:
 *
 *   1. A valid, MFA-complete session cookie is required (except PUBLIC routes).
 *   2. Identity params are overwritten with values from the session user row.
 *   3. Client users are pinned to companies they belong to; company-scoped ids
 *      (Autotask / IT Glue / Datto / SharePoint) are loaded from the DB row,
 *      never taken from the browser.
 *   4. Staff-only routes are refused for client users.
 *   5. Cross-site mutating requests are refused (Origin/Referer check).
 */

import { timingSafeEqual } from "crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "./pg.js";
import { readSession } from "./session.js";
import { assertSameOrigin } from "./request-guard.js";
import {
  isMfaEnabled,
  requireSessionUser,
  type DbUser,
  toSessionUserDto,
} from "./auth-server.js";

export type AuthContext = {
  user: DbUser;
  isStaff: boolean;
  isAdmin: boolean;
  /** Companies a client user may act on (empty for staff = unrestricted). */
  companyIds: number[];
  /** DB row of the company this request is scoped to (clients only). */
  company: CompanyScope | null;
};

type CompanyScope = {
  id: number;
  name: string;
  autotask_company_id: string | null;
  itglue_organization_id: string | null;
  datto_rmm_site_uid: string | null;
  sharepoint_site_url: string | null;
  sharepoint_folder_path: string | null;
};

export type GateResult =
  | { ok: true; auth: AuthContext | null }
  | { ok: false; status: number; error: string };

/** Routes that handle their own auth or must work before login. */
function isPublicRoute(rel: string): boolean {
  return (
    rel === "health" ||
    rel.startsWith("auth/") ||
    // db/* handlers enforce the session themselves (query, status, ping)
    rel.startsWith("db/")
  );
}

/** Routes a client user may never call. */
function isStaffOnlyRoute(rel: string, method: string): boolean {
  if (rel === "autotask/companies") return true;
  if (rel === "datto-rmm/sites") return true;
  if (rel.startsWith("smtp/")) return true;
  if (rel.startsWith("splashtop/")) return true;
  if (rel === "sos/package-config" && method !== "GET") return true;
  return false;
}

/** Status routes: clients get only the non-sensitive keys (see wrapStatusResponse). */
function isStatusRoute(rel: string): boolean {
  return /^(autotask|sharepoint|itglue|datto-rmm)\/status$/.test(rel);
}

const STATUS_SAFE_KEYS = new Set([
  "configured",
  "ok",
  "connected",
  "enabled",
  "mode",
  "mock",
]);

/**
 * Loopback peer, no proxy headers, AND the per-boot token the server wrote to
 * its temp dir (only readable with `docker compose exec`).
 */
function isInContainerProbe(req: VercelRequest): boolean {
  const h = req.headers || {};
  if (h["x-forwarded-for"] || h["x-real-ip"] || h["forwarded"]) return false;
  const peer = String(
    (req as unknown as { socket?: { remoteAddress?: string } }).socket?.remoteAddress || "",
  );
  if (!(peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1")) return false;
  const expected = String(process.env.AKAB_PROBE_TOKEN || "");
  const given = firstParam(h["x-akab-probe"]);
  if (!expected || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function denied(status: number, error: string): GateResult {
  return { ok: false, status, error };
}

function firstParam(v: unknown): string {
  if (Array.isArray(v)) return v.length ? String(v[0]) : "";
  return v == null ? "" : String(v);
}

export async function loadCompanyIds(user: DbUser): Promise<number[]> {
  const ids = new Set<number>();
  if (user.company_id) ids.add(Number(user.company_id));
  try {
    const r = await getPool().query(
      `SELECT DISTINCT company_id FROM client_user_roles WHERE user_id = $1`,
      [user.id],
    );
    for (const row of r.rows as Array<{ company_id: number | null }>) {
      if (row.company_id) ids.add(Number(row.company_id));
    }
  } catch {
    /* older schema without client_user_roles */
  }
  return [...ids].filter((n) => Number.isFinite(n) && n > 0);
}

const CLIENT_PERMISSION_KEYS = [
  "board",
  "tickets",
  "documentation",
  "passwords",
  "directory",
  "devices",
  "billing",
] as const;
type ClientPermission = (typeof CLIENT_PERMISSION_KEYS)[number];

/** Same semantics as src/lib/client-permissions.ts parseClientPermissions. */
function parseClientPermissions(raw: string | null | undefined): Record<ClientPermission, boolean> {
  const base: Record<ClientPermission, boolean> = {
    board: true,
    tickets: true,
    documentation: true,
    passwords: true,
    directory: true,
    devices: false,
    billing: false,
  };
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hasSectionKeys = CLIENT_PERMISSION_KEYS.some((k) => k !== "billing" && k in parsed);
    for (const key of CLIENT_PERMISSION_KEYS) {
      if (key in parsed) base[key] = parsed[key] === true;
      else if (hasSectionKeys) base[key] = false;
    }
    return base;
  } catch {
    return base;
  }
}

/**
 * Effective client permissions — mirrors src/lib/client-roles.ts
 * resolveClientPermissions: stacked roles for the company (or its Standard
 * role when none), billing_access true/false overrides billing.
 */
async function loadClientPermissions(
  user: DbUser,
  companyId: number,
): Promise<Record<ClientPermission, boolean>> {
  const raws: Array<string | null> = [];
  const p = getPool();
  try {
    const r = await p.query(
      `SELECT r.permissions FROM client_user_roles cur
         JOIN client_roles r ON r.id = cur.role_id
        WHERE cur.user_id = $1 AND cur.company_id = $2 AND r.active = true`,
      [user.id, companyId],
    );
    for (const row of r.rows as Array<{ permissions: string | null }>) raws.push(row.permissions);
  } catch {
    /* older schema without client_user_roles */
  }
  if (user.client_role_id) {
    const r = await p.query(
      `SELECT permissions FROM client_roles WHERE id = $1 AND active = true LIMIT 1`,
      [user.client_role_id],
    );
    if (r.rows[0]) raws.push((r.rows[0] as { permissions: string | null }).permissions);
  }
  if (!raws.length) {
    const r = await p.query(
      `SELECT permissions FROM client_roles WHERE company_id = $1 AND slug = 'standard' LIMIT 1`,
      [companyId],
    );
    // No Standard role row yet → Standard defaults (same as permissionsOfClientRole(null))
    raws.push(r.rows[0] ? (r.rows[0] as { permissions: string | null }).permissions : null);
  }
  const out = Object.fromEntries(CLIENT_PERMISSION_KEYS.map((k) => [k, false])) as Record<
    ClientPermission,
    boolean
  >;
  for (const raw of raws) {
    const m = parseClientPermissions(raw);
    for (const k of CLIENT_PERMISSION_KEYS) if (m[k]) out[k] = true;
  }
  if (user.billing_access === true) out.billing = true;
  if (user.billing_access === false) out.billing = false;
  return out;
}

/** Which client permission a route needs (null = any client of the company). */
function requiredClientPermission(rel: string): ClientPermission | null {
  if (/^(autotask|sharepoint|itglue|datto-rmm)\/status$/.test(rel)) return null;
  if (rel.startsWith("itglue/")) return "passwords";
  if (rel.startsWith("sharepoint/")) return "documentation";
  if (rel.startsWith("datto-rmm/")) return "devices";
  if (/^autotask\/(invoices|contracts)(\/|$)/.test(rel)) return "billing";
  if (rel.startsWith("autotask/tickets")) return "tickets";
  return null;
}

async function loadCompany(id: number): Promise<CompanyScope | null> {
  const r = await getPool().query(
    `SELECT id, name, autotask_company_id, itglue_organization_id,
            datto_rmm_site_uid, sharepoint_site_url, sharepoint_folder_path
       FROM companies WHERE id = $1 AND active = true LIMIT 1`,
    [id],
  );
  return (r.rows[0] as CompanyScope | undefined) ?? null;
}

/**
 * Apply a value to both query and body (when present) so every handler's
 * `req.query.x ?? req.body.x` lookup sees the trusted value.
 */
function setParam(
  req: VercelRequest,
  body: Record<string, unknown> | null,
  key: string,
  value: string | number | null,
): void {
  const q = req.query as Record<string, unknown>;
  if (value == null || value === "") {
    delete q[key];
    if (body) delete body[key];
    return;
  }
  q[key] = String(value);
  if (body) body[key] = typeof value === "number" ? value : String(value);
}

function dropParam(
  req: VercelRequest,
  body: Record<string, unknown> | null,
  key: string,
): void {
  delete (req.query as Record<string, unknown>)[key];
  if (body) delete body[key];
}

/**
 * Validate the request and rewrite identity params. Must be called after
 * req.query / req.body are populated and before the handler runs.
 */
export async function gateApiRequest(
  req: VercelRequest,
  rel: string,
): Promise<GateResult> {
  const method = String(req.method || "GET").toUpperCase();

  // Internal modules are never routes
  if (rel.split("/").some((seg) => seg.startsWith("_"))) {
    return denied(404, "API route not found");
  }
  if (isPublicRoute(rel)) return { ok: true, auth: null };

  // Operator diagnostics from inside the container (scripts/upgrade.sh runs
  // `docker compose exec app curl http://127.0.0.1:3000/api/<x>/status`).
  // Only a TCP peer of 127.0.0.1 with no proxy headers qualifies — traffic via
  // the reverse proxy or the published port never arrives from loopback.
  if (method === "GET" && isInContainerProbe(req) && /^[a-z-]+\/status$/.test(rel)) {
    return { ok: true, auth: null };
  }

  const originErr = assertSameOrigin(req);
  if (originErr) return denied(403, originErr);

  let user: DbUser | null = null;
  try {
    user = await requireSessionUser(readSession(req));
  } catch (err) {
    console.error("[api-gate] session check failed", err);
    return denied(503, "Authentication service unavailable");
  }
  // Same rule as /api/db/query: a session is only valid once MFA is set up
  if (!user || !isMfaEnabled(user)) return denied(401, "Authentication required");

  const role = String(user.role || "").toLowerCase();
  const isAdmin = role === "admin";
  const isStaff = isAdmin || role === "technician";
  if (!isStaff && role !== "client") return denied(403, "Forbidden");

  if (!isStaff && isStaffOnlyRoute(rel, method)) {
    return denied(403, "Forbidden");
  }

  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : null;

  // ── Identity: always from the session user ──────────────────────────────
  setParam(req, body, "role", isStaff ? role : "client");
  setParam(req, body, "email", user.email);
  setParam(req, body, "userEmail", user.email);
  setParam(req, body, "userId", user.id);
  setParam(req, body, "userName", user.name);
  setParam(req, body, "itglueUserId", user.itglue_user_id);
  setParam(req, body, "closedByUserId", user.id);
  if (rel.startsWith("sos/")) {
    // SOS handlers use role=staff|client
    setParam(req, body, "role", isStaff ? "staff" : "client");
  }
  if (rel === "smtp/send-board") {
    // Mass email to client users: admins, or technicians holding "messages"
    if (!isAdmin) {
      const dto = await toSessionUserDto(user);
      if (dto.permissions?.messages !== true) return denied(403, "Forbidden");
    }
    setParam(req, body, "authorName", user.name);
    // Never let the caller choose the link target in outbound mail
    setParam(req, body, "portalUrl", publicPortalUrl(req));
  }

  const auth: AuthContext = {
    user,
    isStaff,
    isAdmin,
    companyIds: [],
    company: null,
  };

  if (isStaff) {
    // Staff keep cross-company params, but never raw Graph credentials
    // except on the admin-only SharePoint verify/resolve form.
    if (!(isAdmin && rel === "sharepoint/resolve")) {
      for (const k of ["tenantId", "clientId", "clientSecret"]) {
        dropParam(req, body, k);
      }
    }
    return { ok: true, auth };
  }

  // ── Client: pin to an allowed company, derive every external id ─────────
  const companyIds = await loadCompanyIds(user);
  if (!companyIds.length) return denied(403, "No company assigned");
  auth.companyIds = companyIds;

  const requested = Number(
    firstParam(
      (req.query as Record<string, unknown>).companyId ?? body?.companyId,
    ),
  );
  const companyId =
    Number.isFinite(requested) && requested > 0
      ? requested
      : Number(user.company_id || companyIds[0]);
  if (!companyIds.includes(companyId)) {
    return denied(403, "You do not have access to this company");
  }
  const company = await loadCompany(companyId);
  if (!company) return denied(403, "Company not found or inactive");
  auth.company = company;

  setParam(req, body, "companyId", company.id);
  setParam(req, body, "companyName", company.name);
  setParam(req, body, "autotaskCompanyId", company.autotask_company_id);
  setParam(req, body, "atCompanyId", company.autotask_company_id);
  setParam(req, body, "organizationId", company.itglue_organization_id);
  setParam(req, body, "orgId", company.itglue_organization_id);
  setParam(req, body, "siteUid", company.datto_rmm_site_uid);
  setParam(req, body, "siteUrl", company.sharepoint_site_url);
  setParam(req, body, "basePath", company.sharepoint_folder_path);
  for (const k of ["tenantId", "clientId", "clientSecret"]) {
    dropParam(req, body, k);
  }

  // Integration must be linked for this company, otherwise handlers could
  // fall back to "no company filter" paths.
  if (rel.startsWith("autotask/") && !company.autotask_company_id && !isStatusRoute(rel)) {
    return denied(403, "Autotask is not linked for your company");
  }
  if (rel.startsWith("itglue/") && !company.itglue_organization_id && !isStatusRoute(rel)) {
    return denied(403, "IT Glue is not linked for your company");
  }
  if (rel.startsWith("datto-rmm/") && !company.datto_rmm_site_uid && !isStatusRoute(rel)) {
    return denied(403, "Datto RMM is not linked for your company");
  }
  if (
    rel.startsWith("sharepoint/") &&
    !isStatusRoute(rel) &&
    !company.sharepoint_site_url
  ) {
    return denied(403, "Documentation is not linked for your company");
  }

  // Section permissions from the client's roles (was enforced in the UI only)
  const needed = requiredClientPermission(rel);
  if (needed) {
    const perms = await loadClientPermissions(user, company.id);
    if (!perms[needed]) {
      return denied(403, "This section is not enabled for your account");
    }
  }

  // Clients may only look inside their company's folder
  if (rel === "sharepoint/browse") {
    const p = firstParam((req.query as Record<string, unknown>).path ?? body?.path);
    if (p.split(/[\\/]+/).some((seg) => seg === ".." || seg === ".")) {
      return denied(400, "Invalid path");
    }
  }

  // Clients: only their own contact's tickets (company-wide is the staff path)
  if (rel === "autotask/tickets") {
    setParam(req, body, "scope", "user");
  }

  // Status probes that call vendors / create sessions are staff-only
  if (isStatusRoute(rel)) {
    for (const k of ["verify", "probe", "refresh", "testCreate"]) {
      dropParam(req, body, k);
    }
  }

  return { ok: true, auth };
}

/** AuthContext attached by the server after gateApiRequest succeeded. */
export function requestAuth(req: VercelRequest): AuthContext | null {
  return (req as unknown as { auth?: AuthContext | null }).auth ?? null;
}

/**
 * Fail-closed ownership check for records that carry an Autotask company id.
 * Staff may act across companies; clients only on their own company's records.
 */
export function clientOwnsAutotaskRecord(
  req: VercelRequest,
  recordCompanyId: unknown,
): boolean {
  const auth = requestAuth(req);
  if (!auth) return false;
  if (auth.isStaff) return true;
  const mine = Number(auth.company?.autotask_company_id);
  const theirs = Number(recordCompanyId);
  return Number.isFinite(mine) && Number.isFinite(theirs) && mine === theirs;
}

function publicPortalUrl(req: VercelRequest): string {
  for (const key of ["PUBLIC_URL", "APP_URL", "BASE_URL"] as const) {
    const v = String(process.env[key] || "").trim().replace(/^['"]|['"]$/g, "");
    if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, "");
  }
  // Production never trusts the Host header for links in outgoing mail
  // (a forged Host would phish recipients). Set PUBLIC_URL instead.
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AKAB_ENV === "production"
  ) {
    return "";
  }
  const host = firstParam(req.headers?.host);
  return host ? `https://${host}` : "";
}

/**
 * For client users on integration status routes, strip everything except booleans that
 * drive the UI (configured / connected …). Staff get the full diagnostic body.
 */
/** Debug fields that may carry upstream responses, hosts, paths or IDs. */
const CLIENT_DROP_KEYS = new Set([
  "hint",
  "hints",
  "details",
  "detail",
  "raw",
  "upstream",
  "upstreamBody",
  "response",
  "stack",
  "diagnostics",
  "diag",
  "debug",
  "issues",
  "criticalIssues",
  "tenantId",
  "clientId",
  "zoneUrl",
]);

/**
 * Error text a client may see: short, our own wording. Anything that looks
 * like an upstream message (URLs, paths, .env names, JSON, long text) is
 * replaced so integration internals never reach company users.
 */
function clientSafeError(v: unknown, status: number): unknown {
  if (typeof v !== "string") return v;
  const looksInternal =
    v.length > 120 ||
    /https?:|\/|\\|\.env|[A-Z_]{4,}=|[{}<>]|\b(sql|stack|ECONN|ETIMEDOUT|tenant|secret|token)\b/i.test(v);
  if (!looksInternal) return v;
  return status >= 500 ? "Service temporarily unavailable." : "Request failed.";
}

export function wrapStatusResponse(
  rel: string,
  auth: AuthContext | null,
  res: VercelResponse,
): void {
  if (!auth || auth.isStaff) return;
  const statusOnly = isStatusRoute(rel);
  const original = res.json.bind(res);
  (res as unknown as { json: (b: unknown) => unknown }).json = (b: unknown) => {
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const safe: Record<string, unknown> = {};
      const status = Number(res.statusCode) || 200;
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
        if (statusOnly) {
          if (STATUS_SAFE_KEYS.has(k)) safe[k] = v;
          continue;
        }
        if (CLIENT_DROP_KEYS.has(k)) continue;
        safe[k] = k === "error" || k === "message" || k === "warning" ? clientSafeError(v, status) : v;
      }
      return original(safe);
    }
    return original(b);
  };
}
