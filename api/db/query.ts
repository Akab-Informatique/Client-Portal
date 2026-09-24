import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isPostgresConfigured,
  isProxyIsolationReady,
  proxyQuery,
} from "../_lib/pg.js";
import { hashPassword, isPasswordHashed } from "../_lib/passwords.js";
import { sealSecret } from "../_lib/secret-box.js";
import { assertSameOrigin } from "../_lib/request-guard.js";
import { loadCompanyIds } from "../_lib/api-gate.js";
import { readSession } from "../_lib/session.js";
import {
  bumpSessionEpoch,
  isMfaEnabled,
  requireSessionUser,
  toSessionUserDto,
  type DbUser,
  type SessionUserDto,
} from "../_lib/auth-server.js";

/**
 * POST /api/db/query
 * Drizzle pg-proxy — authenticated, MFA-complete session required.
 *
 * Auth is the HttpOnly signed session cookie only (never a VITE_ secret).
 * Password hashes, MFA material, and SharePoint client secrets never leave
 * the server. Clients are tenant-scoped to their company_id.
 *
 * IMPORTANT — access control lives HERE, not in the React UI. Client-side
 * ProtectedRoute / can() checks are UX only. Every statement is authorized
 * against the session user loaded from the cookie before it reaches Postgres.
 *
 * Bound parameters are always passed separately to proxyQuery — user values
 * never become part of the SQL text. The string transforms below only rewrite
 * fixed server-side allowlists (safe column projections) or reject statements.
 */

/**
 * Kill-switch for production hardening: set SQL_PROXY_DISABLED=1 to refuse
 * all browser SQL (migrate callers to purpose-built /api/* handlers first).
 */
function proxyDisabled(): boolean {
  const off = String(process.env.SQL_PROXY_DISABLED || "")
    .trim()
    .toLowerCase();
  if (off === "1" || off === "true" || off === "yes") return true;
  // Production: require explicit SQL_PROXY_ENABLED=1 to keep the browser proxy.
  // Prefer purpose-built /api/* handlers; the proxy is a migration bridge only.
  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  const isProd =
    nodeEnv === "production" ||
    String(process.env.AKAB_ENV || "").toLowerCase() === "production";
  if (isProd) {
    const on = String(process.env.SQL_PROXY_ENABLED || "")
      .trim()
      .toLowerCase();
    if (!(on === "1" || on === "true" || on === "yes")) return true;
  }
  return false;
}

// DDL / dangerous function denylist (statement text shape only — not user-built SQL).
const BLOCKED_SQL =
  /\b(pg_sleep|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink|copy\s+\w+\s+from|into\s+outfile|load_file|set\s+role|set\s+session|create\s+user|create\s+role|alter\s+role|grant\s+|revoke\s+|alter\s+user|drop\s+user|drop\s+role|drop\s+table|drop\s+database|drop\s+schema|truncate\s+|alter\s+system|create\s+extension)\b/i;

/**
 * Shapes the Drizzle query builder never produces. Rejecting them closes the
 * tricks used to slip past the text checks below: comments, schema-qualified
 * or catalog tables, whole-row / JSON / aggregate serialisation of rows, and
 * changing the per-request RLS settings (set_config / current_setting).
 */
const NON_BUILDER_SQL =
  /--|\/\*|\bpg_\w+|\binformation_schema\b|\bpublic"?\s*\.|\b(row_to_json|to_json|to_jsonb|json_agg|jsonb_agg|json_object_agg|jsonb_object_agg|json_build_object|jsonb_build_object|json_build_array|jsonb_build_array|array_agg|string_agg|xmlagg|query_to_xml|table_to_xml|set_config|current_setting|current_user|session_user|lo_\w+)\b|\bselect\s+\*/i;

const AUTH_SECRET_COLS = [
  "password",
  "mfa_totp_secret",
  "mfa_recovery_codes",
  "mfa_email_code_hash",
  "mfa_email_code_expires",
  "mfa_enroll_secret",
  "mfa_enroll_id",
] as const;

const MFA_WRITE_COLS = [
  "mfa_totp_secret",
  "mfa_recovery_codes",
  "mfa_email_code_hash",
  "mfa_email_code_expires",
] as const;

/** Privilege / identity columns clients and non-admin staff must not write. */
const PRIVILEGE_COLS = [
  "role",
  "company_id",
  "active",
  "staff_role_id",
  "client_role_id",
  "billing_access",
  "password",
  "mfa_enabled",
] as const;

const TENANT_TABLES = [
  "board_messages",
  "message_user_states",
  "sos_requests",
  "users",
  "companies",
  "client_roles",
  "client_user_roles",
] as const;

/** Map of tables → staff permission keys (any of the listed grants access). */
const STAFF_TABLE_PERMS: Record<string, string[]> = {
  users: ["users", "technicians", "directory", "profiles", "clients"],
  companies: ["clients", "documentation", "devices", "dashboard"],
  board_messages: ["messages", "dashboard"],
  message_user_states: ["messages", "dashboard"],
  staff_roles: ["roles", "technicians"],
  client_roles: ["roles", "clients", "users"],
  client_user_roles: ["roles", "clients", "users"],
  sos_requests: ["dashboard", "devices"],
};

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


function hasColumnIdent(sql: string, col: string): boolean {
  if (!/^[a-z_][a-z0-9_]*$/i.test(col)) return false;
  const lower = sql.toLowerCase();
  const c = col.toLowerCase();
  let from = 0;
  while (true) {
    const i = lower.indexOf(c, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : lower[i - 1];
    const after = lower[i + c.length] || "";
    if ((!before || !/[a-z0-9_]/.test(before)) && (!after || !/[a-z0-9_]/.test(after))) {
      return true;
    }
    from = i + c.length;
  }
}

function sqlMentionsIdEquals(sql: string, id: string): boolean {
  if (!/^\d+$/.test(id)) return false;
  if (/\bid\s*=\s*\$\d+\b/i.test(sql)) return true;
  const compact = sql.toLowerCase().replace(/\s+/g, "");
  for (const p of ["id=" + id, "id='" + id + "'", 'id="' + id + '"']) {
    if (compact.includes(p)) return true;
  }
  return false;
}

function sqlMentionsCompanyIdEquals(sql: string, id: string): boolean {
  if (!/^\d+$/.test(id)) return false;
  if (/\bcompany_id\s*=\s*\$\d+\b/i.test(sql)) return true;
  const compact = sql.toLowerCase().replace(/\s+/g, "");
  for (const p of [
    "company_id=" + id,
    "company_id='" + id + "'",
    'company_id="' + id + '"',
  ]) {
    if (compact.includes(p)) return true;
  }
  if (compact.includes("company_idin(") && compact.includes(id)) {
    const idx = compact.indexOf(id);
    if (idx >= 0) {
      const b = compact[idx - 1] || ",";
      const a = compact[idx + id.length] || ",";
      if ((b < "0" || b > "9") && (a < "0" || a > "9")) return true;
    }
  }
  return false;
}

function mentionsTable(sql: string, table: string): boolean {
  // Defensive shape check — table is always a hard-coded allowlist identifier.
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) return false;
  const lower = sql.toLowerCase();
  const tname = table.toLowerCase();
  for (const kw of ["from", "into", "update", "join"]) {
    let from = 0;
    while (true) {
      const i = lower.indexOf(kw, from);
      if (i < 0) break;
      const before = i === 0 ? " " : lower[i - 1];
      const afterKw = lower[i + kw.length] || " ";
      if (/[a-z0-9_]/.test(before) || !/\s/.test(afterKw)) {
        from = i + kw.length;
        continue;
      }
      let rest = lower.slice(i + kw.length).trimStart();
      if (rest.startsWith('"') || rest.startsWith("'")) rest = rest.slice(1);
      if (rest.startsWith(tname)) {
        const endCh = rest[tname.length] || " ";
        if (!/[a-z0-9_]/.test(endCh)) return true;
      }
      from = i + kw.length;
    }
  }
  return false;
}

function tablesMentioned(sql: string): string[] {
  const found: string[] = [];
  const all = [
    ...TENANT_TABLES,
    "staff_roles",
    "todos",
    "todo_items",
  ] as const;
  for (const t of all) {
    if (mentionsTable(sql, t)) found.push(t);
  }
  return found;
}

function staffHasAnyPerm(
  dto: SessionUserDto,
  keys: string[],
): boolean {
  if (dto.role === "admin") return true;
  if (dto.role !== "technician" && dto.role !== "admin") return false;
  // Admin with null permissions map = full access
  if (dto.permissions == null && dto.role === "admin") return true;
  const perms = dto.permissions || {};
  return keys.some((k) => perms[k] === true);
}

/**
 * Server-side staff authorization: table-level permission gates.
 * UI RequirePermission is UX only — this is the real check.
 */
function assertStaffAuthorization(
  sql: string,
  dto: SessionUserDto,
): string | null {
  if (dto.role === "admin") {
    // Admins still cannot write MFA secrets via proxy
    return null;
  }
  if (dto.role !== "technician" && dto.role !== "admin") {
    return "Access denied.";
  }

  const kind = statementKind(sql);
  const tables = tablesMentioned(sql);

  for (const table of tables) {
    const needed = STAFF_TABLE_PERMS[table];
    if (needed && !staffHasAnyPerm(dto, needed)) {
      return "Access denied.";
    }
  }

  // Non-admin staff: block privilege escalation via users writes
  // (shape checks on statement text — parameters stay bound separately)
  if (mentionsTable(sql, "users") && kind !== "select") {
    for (const col of [
      "role",
      "staff_role_id",
      "mfa_enabled",
      "active",
      "company_id",
    ] as const) {
      if (hasColumnIdent(sql, col)) {
        return "Access denied.";
      }
    }
    if (kind === "insert" || kind === "delete") {
      // Creating/deleting users requires users permission already checked;
      // still block role assignment on insert by column list inspection below.
      if (kind === "insert") {
        const insertCols = matchInsertColumns(sql, "users");
        if (insertCols?.some((c) => (PRIVILEGE_COLS as readonly string[]).includes(c))) {
          // password is allowed (hashed below) but role/staff_role_id are not
          const blocked = insertCols.filter((c) =>
            ["role", "staff_role_id", "mfa_enabled", "company_id", "active"].includes(c),
          );
          if (blocked.length) return "Access denied.";
        }
      }
    }
  }

  return null;
}

/**
 * Parse INSERT column list for a known allowlisted table name (shape only).
 * `table` is always a hard-coded identifier from TENANT_TABLES / callers —
 * never request input. No RegExp is built from user strings.
 */
function matchInsertColumns(sql: string, table: string): string[] | null {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) return null;
  const lower = sql.toLowerCase();
  const candidates = [`insert into ${table}`, `insert into "${table}"`, `insert into '${table}'`];
  let start = -1;
  let prefixLen = 0;
  for (const needle of candidates) {
    const i = lower.indexOf(needle);
    if (i >= 0) {
      start = i;
      prefixLen = needle.length;
      break;
    }
  }
  if (start < 0) return null;
  const after = sql.slice(start + prefixLen).trimStart();
  if (!after.startsWith("(")) return null;
  const end = after.indexOf(")");
  if (end < 0) return null;
  const cols = after.slice(1, end);
  return cols.split(",").map((c) => c.trim().replace(/["']/g, "").toLowerCase());
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

  // Clients may only touch tenant tables
  const tables = tablesMentioned(sql);
  for (const t of tables) {
    if (!(TENANT_TABLES as readonly string[]).includes(t)) {
      return "Access denied.";
    }
  }

  if (mentionsTable(sql, "companies") && kind !== "select") {
    return "Access denied.";
  }

  for (const table of TENANT_TABLES) {
    if (!mentionsTable(sql, table)) continue;

    if (table === "users") {
      const selfId =
        sqlMentionsIdEquals(sql, uid);
      const ownCompany =
        sqlMentionsCompanyIdEquals(sql, cid);
      if (!selfId && !ownCompany) {
        return "Tenant scope required for users.";
      }
      if (kind === "insert" || kind === "delete") {
        return "Access denied.";
      }
      if (kind === "update") {
        for (const col of PRIVILEGE_COLS) {
          if (hasColumnIdent(sql, col)) {
            return "Access denied.";
          }
        }
        for (const col of MFA_WRITE_COLS) {
          if (hasColumnIdent(sql, col)) {
            return "MFA fields can only be changed through auth APIs.";
          }
        }
      }
      continue;
    }

    if (table === "companies") {
      const scoped =
        sqlMentionsIdEquals(sql, cid);
      if (!scoped) {
        return "Tenant scope required for companies.";
      }
      continue;
    }

    if (table === "client_roles" || table === "client_user_roles") {
      const scoped =
        sqlMentionsCompanyIdEquals(sql, cid);
      if (!scoped) {
        return `Tenant scope required for ${table}.`;
      }
      if (kind !== "select") {
        // Clients cannot invent roles
        return "Access denied.";
      }
      continue;
    }

    // Per-user tables may be scoped by user_id (param verified in assertClientParams)
    const scoped =
      sqlMentionsCompanyIdEquals(sql, cid) ||
      ((table === "message_user_states" || table === "sos_requests") &&
        (/\buser_id\s*=\s*\$\d+\b/i.test(sql) || /\bid\s*=\s*\$\d+\b/i.test(sql))) ||
      // New read-state rows: RLS WITH CHECK pins user_id to the caller
      (table === "message_user_states" && kind === "insert" && isProxyIsolationReady());
    if (!scoped) {
      return `Tenant scope required for ${table}.`;
    }
  }

  if (/\bsharepoint_client_secret\b/i.test(sql)) {
    return "Access denied.";
  }
  // Privilege escalation guard (shape check on UPDATE users … role)
  if (
    mentionsTable(sql, "users") &&
    kind === "update" &&
    /\brole\b/i.test(sql)
  ) {
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

  for (const hit of sql.matchAll(/\bcompany_id\s*=\s*\$(\d+)\b/gi)) {
    const idx = Number(hit[1]) - 1;
    const v = params[idx];
    const num = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(num) || num !== companyId) {
      return "Tenant parameter mismatch.";
    }
  }

  if (mentionsTable(sql, "companies")) {
    for (const hit of sql.matchAll(/\bid\s*=\s*\$(\d+)\b/gi)) {
      const idx = Number(hit[1]) - 1;
      const v = params[idx];
      const num = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(num) || num !== companyId) {
        return "Tenant parameter mismatch.";
      }
    }
  }

  // user_id filters must name the caller (RLS enforces this again in Postgres)
  for (const hit of sql.matchAll(/\buser_id\s*=\s*\$(\d+)\b/gi)) {
    const idx = Number(hit[1]) - 1;
    const v = params[idx];
    const num = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(num) || num !== userId) {
      return "Tenant parameter mismatch.";
    }
  }

  // UPDATE users must target self when binding id
  if (mentionsTable(sql, "users") && statementKind(sql) === "update") {
    for (const hit of sql.matchAll(/\bid\s*=\s*\$(\d+)\b/gi)) {
      const idx = Number(hit[1]) - 1;
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
    if (hasColumnIdent(sql, col)) {
      return "MFA fields can only be changed through auth APIs.";
    }
  }
  return null;
}

/**
 * Hash plaintext password bind params on users INSERT/UPDATE so admins
 * setting passwords via the app never store cleartext.
 * Uses bound $N placeholders only — never concatenates password into SQL.
 */
async function hashPasswordParamsInSql(
  sql: string,
  params: unknown[],
): Promise<unknown[]> {
  if (isSelectLike(sql)) return params;
  if (!mentionsTable(sql, "users")) return params;
  if (!/\bpassword\b/i.test(sql)) return params;
  const out = params.slice();
  const idxs = new Set<number>();
  for (const hit of sql.matchAll(/\bpassword\s*=\s*\$(\d+)\b/gi)) {
    const idx = Number(hit[1]) - 1;
    if (Number.isFinite(idx) && idx >= 0) idxs.add(idx);
  }
  const cols = matchInsertColumns(sql, "users");
  if (cols) {
    const pwCol = cols.indexOf("password");
    if (pwCol >= 0) {
      const valuesMatch = sql.match(/values\s*\(([^)]+)\)/i);
      if (valuesMatch) {
        const placeholders = valuesMatch[1].split(",").map((s) => s.trim());
        const ph = placeholders[pwCol];
        const pm = ph?.match(/^\$(\d+)$/);
        if (pm) idxs.add(Number(pm[1]) - 1);
      }
    }
  }
  for (const idx of idxs) {
    const v = out[idx];
    if (typeof v === "string" && v.length > 0 && !isPasswordHashed(v)) {
      out[idx] = await hashPassword(v);
    }
  }
  return out;
}


const SECRET_COLUMNS = [
  ...AUTH_SECRET_COLS,
  "mfa_enroll_expires",
  "sharepoint_client_secret",
] as const;

/** `"users"."password"`, `users.password`, `"password"` or `password`. */
const SECRET_COLUMN_REF = new RegExp(
  `(?:"?[a-z_][a-z0-9_]*"?\\s*\\.\\s*)?"?\\b(?:${SECRET_COLUMNS.join("|")})\\b"?`,
  "gi",
);

/**
 * Replace secret column references with NULL wherever the statement READS
 * data: the whole statement for SELECT, only the RETURNING clause for writes
 * (INSERT column lists / SET targets stay intact so admins can still set a
 * password — it is hashed / sealed before execution).
 */
function nullSecretReads(sql: string): string {
  const replace = (ref: string) =>
    // The admin UI shows whether a SharePoint secret is set — keep that signal
    /sharepoint_client_secret/i.test(ref)
      ? `(CASE WHEN length(btrim(coalesce(${ref}, ''))) > 0 THEN 'configured' END)`
      : "NULL";
  if (isSelectLike(sql)) return sql.replace(SECRET_COLUMN_REF, replace);
  const i = sql.toLowerCase().lastIndexOf("returning");
  if (i < 0) return sql;
  return sql.slice(0, i) + sql.slice(i).replace(SECRET_COLUMN_REF, replace);
}

/** The 'configured' marker produced by nullSecretReads — safe, never the value. */
const CONFIGURED_MARKER =
  /\(CASE WHEN length\(btrim\(coalesce\([^()]*, ''\)\)\) > 0 THEN 'configured' END\)/gi;

/**
 * `"table"."column"` → `table.column`, secret markers → NULL.
 * For text checks only — the executed SQL keeps its quoting.
 */
function unquoteIdentifiers(sql: string): string {
  return sql
    .replace(CONFIGURED_MARKER, "NULL")
    .replace(/"([a-z_][a-z0-9_]*)"/gi, "$1");
}

/**
 * After nulling, a secret column may only appear as a write target that
 * receives a bound parameter (`password = $3`, INSERT column list). Anything
 * else — e.g. `SET bio = password`, `substr(password …)` — could copy secret
 * material into a readable column and is refused.
 */
function selectTouchesSecretColumns(sql: string): boolean {
  let probe = sql.toLowerCase();
  if (!isSelectLike(sql)) {
    probe = probe
      .replace(/\b(?:[a-z_][a-z0-9_]*\.)?(password|sharepoint_client_secret)\s*=\s*\$\d+/g, " ")
      .replace(/^\s*insert\s+into\s+[a-z_][a-z0-9_.]*\s*\([^)]*\)/, "insert ");
  }
  return SECRET_COLUMNS.some((col) => new RegExp(`\\b${col}\\b`).test(probe));
}

/** Seal sharepoint_client_secret write params (AES-GCM) before INSERT/UPDATE. */
function sealSharePointSecretParamsInSql(
  sql: string,
  params: unknown[],
): unknown[] {
  if (!/\bsharepoint_client_secret\b/i.test(sql)) return params;
  if (isSelectLike(sql)) return params;
  const out = params.slice();
  const idxs = new Set<number>();
  for (const hit of sql.matchAll(
    /\bsharepoint_client_secret\s*=\s*\$(\d+)\b/gi,
  )) {
    const idx = Number(hit[1]) - 1;
    if (Number.isFinite(idx) && idx >= 0) idxs.add(idx);
  }
  const cols = matchInsertColumns(sql, "companies");
  if (cols) {
    const colIdx = cols.indexOf("sharepoint_client_secret");
    if (colIdx >= 0) {
      const valuesMatch = sql.match(/values\s*\(([^)]+)\)/i);
      if (valuesMatch) {
        const placeholders = valuesMatch[1].split(",").map((s) => s.trim());
        const ph = placeholders[colIdx];
        const pm = ph?.match(/^\$(\d+)$/);
        if (pm) idxs.add(Number(pm[1]) - 1);
      }
    }
  }
  for (const idx of idxs) {
    const v = out[idx];
    if (typeof v === "string" && v.length > 0) {
      try {
        out[idx] = sealSecret(v);
      } catch (e) {
        console.warn("[db/query] sealSecret failed", e);
        throw e;
      }
    }
  }
  return out;
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

    const originErr = assertSameOrigin(req);
    if (originErr) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (proxyDisabled()) {
      return res.status(403).json({
        error:
          "Browser SQL proxy is disabled. Use purpose-built /api/* handlers. " +
          "Set SQL_PROXY_ENABLED=1 only as a temporary bridge (not recommended).",
      });
    }

    if (!isPostgresConfigured()) {
      return res.status(503).json({ error: "Database is not configured." });
    }

    const session = readSession(req);
    // requireSessionUser also enforces session_epoch (logout / password / MFA revoke)
    const user = await requireSessionUser(session);
    if (!user || !isMfaEnabled(user)) {
      return res.status(401).json({ error: "Authentication required." });
    }
    const body = bodyIsObj(req.body) ? req.body : {};
    let sql = String(body.sql ?? "").trim();
    let params = Array.isArray(body.params) ? body.params.slice() : [];
    const method = String(body.method ?? "all");

    if (!sql) {
      return res.status(400).json({ error: "Invalid query." });
    }
    if (sql.includes(";")) {
      return res
        .status(400)
        .json({ error: "Multiple statements are not allowed." });
    }
    if (BLOCKED_SQL.test(sql) || NON_BUILDER_SQL.test(sql)) {
      return res.status(400).json({ error: "Query not allowed." });
    }
    if (statementKind(sql) === "other") {
      return res.status(400).json({ error: "Query not allowed." });
    }

    // Secret columns become NULL wherever they are read (SELECT, RETURNING) so
    // they can neither be returned nor used as a WHERE oracle. proxyQuery also
    // strips them from results and RLS enforces tenancy; the text checks below
    // are an extra layer and run on an identifier-unquoted copy so they
    // understand Drizzle's `"table"."column"` output.
    sql = nullSecretReads(sql);
    const check = unquoteIdentifiers(sql);

    const mfaErr = assertMfaWriteRules(check);
    if (mfaErr) {
      return res.status(403).json({ error: mfaErr });
    }

    if (user.role === "client") {
      const scopeErr = assertClientTenantScope(check, user);
      if (scopeErr) {
        return res.status(403).json({ error: scopeErr });
      }
      const paramErr = assertClientParams(check, params, user);
      if (paramErr) {
        return res.status(403).json({ error: paramErr });
      }
    } else {
      // Resolve server-side permissions (never trust client patchSession / local state)
      const dto = await toSessionUserDto(user);
      const staffErr = assertStaffAuthorization(check, dto);
      if (staffErr) {
        return res.status(403).json({ error: staffErr });
      }
      // Nobody may set mfa_enabled via proxy
      if (
        !isSelectLike(check) &&
        /\bmfa_enabled\b/i.test(check) &&
        mentionsTable(check, "users")
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

    // Anything still reading a secret column after nulling is an unusual shape
    if (selectTouchesSecretColumns(check)) {
      return res.status(403).json({ error: "Access denied." });
    }

    if (!isSelectLike(check)) {
      params = await hashPasswordParamsInSql(check, params);
      params = sealSharePointSecretParamsInSql(check, params);
    }

    // Always execute with bound parameters — never interpolate params into sql.
    // Runs as the restricted proxy role with row-level security for this user.
    const role =
      user.role === "admin" || user.role === "technician" ? user.role : "client";
    const rows = await proxyQuery({
      sql,
      params,
      method,
      scope: {
        role,
        userId: user.id,
        companyIds: role === "client" ? await loadCompanyIds(user) : [],
      },
    });

    // Admin password changes via the proxy must revoke outstanding cookies
    if (
      !isSelectLike(check) &&
      mentionsTable(check, "users") &&
      /\bpassword\b/i.test(check)
    ) {
      try {
        for (const hit of check.matchAll(/\bid\s*=\s*\$(\d+)\b/gi)) {
          const idx = Number(hit[1]) - 1;
          const idVal = params[idx];
          const idNum = typeof idVal === "number" ? idVal : Number(idVal);
          if (Number.isFinite(idNum) && idNum > 0) {
            await bumpSessionEpoch(idNum);
          }
        }
      } catch (e) {
        console.warn(
          "[db/query] session epoch bump after password write failed",
          e,
        );
      }
    }

    return res.status(200).json(rows);
  } catch (err) {
    console.error("[akab-db/query]", err);
    return res.status(500).json({ error: "Database query failed" });
  }
}
