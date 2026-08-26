import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isPostgresConfigured, proxyQuery } from "../_lib/pg.js";
import { getRequestSessionUserId, readSession } from "../_lib/session.js";
import { isMfaEnabled, loadUserById, type DbUser } from "../_lib/auth-server.js";

/**
 * POST /api/db/query
 * Drizzle pg-proxy — authenticated, MFA-complete session required.
 *
 * Auth is the HttpOnly signed session cookie only (never a VITE_ secret).
 * Password hashes, MFA material, and SharePoint client secrets never leave
 * the server. Clients are tenant-scoped to their company_id.
 */

const BLOCKED_SQL =
  /\b(pg_sleep|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink|copy\s+\w+\s+from|into\s+outfile|load_file|set\s+role|set\s+session|create\s+user|create\s+role|alter\s+role|grant\s+|revoke\s+|alter\s+user|drop\s+user|drop\s+role|drop\s+table|drop\s+database|drop\s+schema|truncate\s+|alter\s+system|create\s+extension)\b/i;

const AUTH_SECRET_COLS = [
  "password",
  "mfa_totp_secret",
  "mfa_recovery_codes",
  "mfa_email_code_hash",
  "mfa_email_code_expires",
] as const;

const MFA_WRITE_COLS = [
  "mfa_totp_secret",
  "mfa_recovery_codes",
  "mfa_email_code_hash",
  "mfa_email_code_expires",
] as const;

/** Safe users projection (ordinal-stable for Drizzle when replacing SELECT *). */
const USERS_SAFE_SELECT = [
  "id",
  "email",
  "NULL::text AS password",
  "name",
  "role",
  "company_id",
  "active",
  "staff_role_id",
  "client_role_id",
  "billing_access",
  "job_title",
  "phone",
  "mobile",
  "bio",
  "locale",
  "itglue_user_id",
  "datto_web_remote_device_uids",
  "board_email_opt_in",
  "mfa_enabled",
  "NULL::text AS mfa_totp_secret",
  "NULL::text AS mfa_recovery_codes",
  "NULL::text AS mfa_email_code_hash",
  "NULL::text AS mfa_email_code_expires",
  "created_at",
].join(", ");

/** Safe companies projection — SharePoint client secret always NULL to clients/staff via proxy. */
const COMPANIES_SAFE_SELECT = [
  "id",
  "name",
  "type",
  "email",
  "phone",
  "notes",
  "active",
  "autotask_company_id",
  "dashboard_layout",
  "sharepoint_site_url",
  "sharepoint_folder_path",
  "sharepoint_tenant_id",
  "sharepoint_client_id",
  // Secret never returned over the browser proxy (server Graph code uses pg pool).
  "NULL::text AS sharepoint_client_secret",
  "documentation_title",
  "documentation_enabled",
  "itglue_organization_id",
  "datto_rmm_site_uid",
  "datto_rmm_site_name",
  "created_at",
].join(", ");

const TENANT_TABLES = [
  "board_messages",
  "message_user_states",
  "sos_requests",
  "users",
  "companies",
  "client_roles",
  "client_user_roles",
] as const;

function bodyIsObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function isSelectLike(sql: string): boolean {
  const s = sql.trim().toLowerCase();
  return s.startsWith("select") || s.startsWith("with");
}

function statementKind(
  sql: string,
): "select" | "insert" | "update" | "delete" | "other" {
  const s = sql.trim().toLowerCase();
  if (s.startsWith("select") || s.startsWith("with")) return "select";
  if (s.startsWith("insert")) return "insert";
  if (s.startsWith("update")) return "update";
  if (s.startsWith("delete")) return "delete";
  return "other";
}

function mentionsTable(sql: string, table: string): boolean {
  const re = new RegExp(
    `\\b(from|into|update|join)\\s+["']?${table}["']?\\b`,
    "i",
  );
  return re.test(sql);
}

/**
 * Expand SELECT * on sensitive tables and NULL any explicit secret columns.
 */
function redactSecretsInSelect(sql: string): string {
  let out = sql;

  // SELECT "users".* / SELECT * FROM users
  out = out.replace(
    /select\s+(?:["']?users["']?\.)?\*\s+from\s+["']?users["']?/gi,
    `SELECT ${USERS_SAFE_SELECT} FROM users`,
  );
  out = out.replace(
    /select\s+(?:["']?companies["']?\.)?\*\s+from\s+["']?companies["']?/gi,
    `SELECT ${COMPANIES_SAFE_SELECT} FROM companies`,
  );

  // Explicit secret columns → NULL (keeps aliases/ordinals when possible)
  const secretCols = [
    ...AUTH_SECRET_COLS,
    "sharepoint_client_secret",
  ] as const;
  for (const col of secretCols) {
    const re = new RegExp(
      `([\\s,])(?:([a-zA-Z_][\\w]*)\\.)?(["']?)${col}\\3(?=[\\s,]|$)`,
      "gi",
    );
    out = out.replace(re, `$1NULL`);
  }
  return out;
}

function assertClientTenantScope(sql: string, user: DbUser): string | null {
  const companyId = user.company_id;
  if (companyId == null || !Number.isFinite(Number(companyId))) {
    return "Client account has no company scope.";
  }
  const cid = String(Number(companyId));
  const uid = String(Number(user.id));
  const kind = statementKind(sql);
  if (kind === "other") return "Statement not allowed.";

  if (mentionsTable(sql, "companies") && kind !== "select") {
    return "Access denied.";
  }

  for (const table of TENANT_TABLES) {
    if (!mentionsTable(sql, table)) continue;

    if (table === "users") {
      const selfId =
        new RegExp(`\\bid\\s*=\\s*['"]?${uid}['"]?\\b`).test(sql) ||
        /\bid\s*=\s*\$\d+\b/i.test(sql);
      const ownCompany =
        new RegExp(`\\bcompany_id\\s*=\\s*['"]?${cid}['"]?\\b`).test(sql) ||
        /\bcompany_id\s*=\s*\$\d+\b/i.test(sql);
      if (!selfId && !ownCompany) {
        return "Tenant scope required for users.";
      }
      if (kind === "insert" || kind === "delete") {
        return "Access denied.";
      }
      if (kind === "update") {
        if (
          /\b(role|company_id|active|staff_role_id|client_role_id|billing_access|password)\b/i.test(
            sql,
          )
        ) {
          return "Access denied.";
        }
        for (const col of MFA_WRITE_COLS) {
          if (new RegExp(`\\b${col}\\b`, "i").test(sql)) {
            return "MFA fields can only be changed through auth APIs.";
          }
        }
      }
      continue;
    }

    if (table === "companies") {
      // Must target own company id (literal or placeholder checked in params)
      const scoped =
        new RegExp(`\\bid\\s*=\\s*['"]?${cid}['"]?\\b`).test(sql) ||
        /\bid\s*=\s*\$\d+\b/i.test(sql);
      if (!scoped) {
        return "Tenant scope required for companies.";
      }
      continue;
    }

    const scoped =
      new RegExp(`\\bcompany_id\\s*=\\s*['"]?${cid}['"]?\\b`).test(sql) ||
      /\bcompany_id\s*=\s*\$\d+\b/i.test(sql) ||
      new RegExp(`\\bcompany_id\\s+in\\s*\\([^)]*\\b${cid}\\b`, "i").test(sql);
    if (!scoped) {
      return `Tenant scope required for ${table}.`;
    }
  }

  if (/\bsharepoint_client_secret\b/i.test(sql)) {
    return "Access denied.";
  }
  if (/\bupdate\s+["']?users["']?/i.test(sql) && /\brole\b/i.test(sql)) {
    return "Access denied.";
  }
  if (/\bpassword\b/i.test(sql) && !isSelectLike(sql)) {
    return "Access denied.";
  }

  return null;
}

function assertClientParams(
  sql: string,
  params: unknown[],
  user: DbUser,
): string | null {
  const companyId = Number(user.company_id);
  const userId = Number(user.id);
  if (!Number.isFinite(companyId)) return "Client account has no company scope.";

  const companyRe = /\bcompany_id\s*=\s*\$(\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = companyRe.exec(sql))) {
    const idx = Number(m[1]) - 1;
    const v = params[idx];
    const num = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(num) || num !== companyId) {
      return "Tenant parameter mismatch.";
    }
  }

  // companies.id = $n
  if (mentionsTable(sql, "companies")) {
    const idRe = /\bid\s*=\s*\$(\d+)\b/gi;
    while ((m = idRe.exec(sql))) {
      const idx = Number(m[1]) - 1;
      const v = params[idx];
      const num = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(num) || num !== companyId) {
        return "Tenant parameter mismatch.";
      }
    }
  }

  if (/\bupdate\s+["']?users["']?/i.test(sql)) {
    const idRe = /\bid\s*=\s*\$(\d+)\b/gi;
    while ((m = idRe.exec(sql))) {
      const idx = Number(m[1]) - 1;
      const v = params[idx];
      const num = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(num) || num !== userId) {
        return "Tenant parameter mismatch.";
      }
    }
  }

  return null;
}

function assertMfaWriteRules(sql: string): string | null {
  if (isSelectLike(sql)) return null;
  for (const col of MFA_WRITE_COLS) {
    if (new RegExp(`\\b${col}\\b`, "i").test(sql)) {
      return "MFA fields can only be changed through auth APIs.";
    }
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Allow", "POST, OPTIONS");
      return res.status(204).end();
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!isPostgresConfigured()) {
      return res.status(503).json({ error: "Database is not configured." });
    }

    const session = readSession(req);
    const uid = getRequestSessionUserId(req);
    if (!session || uid == null) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const user = await loadUserById(uid);
    if (!user || !user.active || !isMfaEnabled(user)) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const body = bodyIsObj(req.body) ? req.body : {};
    let sql = String(body.sql ?? "").trim();
    const params = Array.isArray(body.params) ? body.params : [];
    const method = String(body.method ?? "all");

    if (!sql) {
      return res.status(400).json({ error: "Invalid query." });
    }
    if (sql.includes(";")) {
      return res
        .status(400)
        .json({ error: "Multiple statements are not allowed." });
    }
    if (BLOCKED_SQL.test(sql)) {
      return res.status(400).json({ error: "Query not allowed." });
    }
    if (statementKind(sql) === "other") {
      return res.status(400).json({ error: "Query not allowed." });
    }

    const mfaErr = assertMfaWriteRules(sql);
    if (mfaErr) {
      return res.status(403).json({ error: mfaErr });
    }

    if (user.role === "client") {
      const scopeErr = assertClientTenantScope(sql, user);
      if (scopeErr) {
        return res.status(403).json({ error: scopeErr });
      }
      const paramErr = assertClientParams(sql, params, user);
      if (paramErr) {
        return res.status(403).json({ error: paramErr });
      }
    } else {
      // Staff (non-admin): block privilege escalation and MFA tampering via SQL
      if (user.role !== "admin") {
        if (
          /\bupdate\s+["']?users["']?/i.test(sql) &&
          /\b(role|staff_role_id|mfa_enabled|active)\b/i.test(sql)
        ) {
          return res.status(403).json({ error: "Access denied." });
        }
        if (
          /\b(insert\s+into|delete\s+from)\s+["']?users["']?/i.test(sql) &&
          /\brole\b/i.test(sql)
        ) {
          return res.status(403).json({ error: "Access denied." });
        }
      }
      // Nobody may clear MFA secrets or set mfa_enabled via proxy
      if (
        !isSelectLike(sql) &&
        /\bmfa_enabled\b/i.test(sql) &&
        mentionsTable(sql, "users")
      ) {
        return res.status(403).json({
          error: "MFA fields can only be changed through auth APIs.",
        });
      }
    }

    // SharePoint client secret: never readable; writable only by admin staff
    if (/\bsharepoint_client_secret\b/i.test(sql) && !isSelectLike(sql)) {
      if (user.role !== "admin") {
        return res.status(403).json({ error: "Access denied." });
      }
    }

    if (isSelectLike(sql)) {
      sql = redactSecretsInSelect(sql);
    }

    const rows = await proxyQuery({ sql, params, method });
    return res.status(200).json(rows);
  } catch (err) {
    console.error("[akab-db/query]", err);
    return res.status(500).json({ error: "Database query failed" });
  }
}
